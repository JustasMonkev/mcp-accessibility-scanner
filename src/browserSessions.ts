/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import crypto from 'node:crypto';

import { logUnhandledError } from './utils/log.js';

import type { Context } from './context.js';

/**
 * The slice of the registry the session tools reach through their Context:
 * `browser_session_open` mints a handle, `browser_session_close` releases one.
 * open() is async so the backend can finish fallible setup (the --save-session
 * log) BEFORE the handle is registered — a failure must not leave a
 * half-registered session behind.
 */
export type BrowserSessionBroker = {
  open(): Promise<string>;
  close(id: string): Promise<void>;
};

const defaultSessionTtlMs = 30 * 60 * 1000;

/**
 * Inactivity TTL for explicitly opened browser sessions. Overridable via
 * `PLAYWRIGHT_MCP_BROWSER_SESSION_TTL_MS`; a present-but-blank or unparsable
 * value keeps the default rather than becoming 0, and a zero or negative
 * value disables reaping entirely.
 *
 * @public
 */
export function browserSessionTtlMs(): number {
  const value = process.env.PLAYWRIGHT_MCP_BROWSER_SESSION_TTL_MS;
  if (value === undefined)
    return defaultSessionTtlMs;
  const trimmed = value.trim();
  if (!trimmed)
    return defaultSessionTtlMs;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed))
    return defaultSessionTtlMs;
  return parsed;
}

type SessionEntry = {
  context: Context;
  lastUsedAt: number;
};

/**
 * Maps server-minted opaque handles (`bs_<uuid>`) to Contexts, per the MCP
 * 2026-07-28 prescription for stateful servers: state is named by an explicit
 * handle the model passes back as an ordinary tool argument, instead of being
 * hidden in the connection. The default (no-handle) Context stays outside
 * this registry so existing clients see today's behavior unchanged.
 *
 * Entries expire after `ttlMs` of inactivity so an abandoned handle cannot
 * leak a browser process. The TTL is refreshed on every use and held while a
 * tool is running (a long `audit_site` crawl must not be reaped mid-run); the
 * reaper timer is unref'ed so it never keeps the process alive. Refs #167.
 */
export class BrowserSessionRegistry {
  private _sessions = new Map<string, SessionEntry>();
  private _ttlMs: number;
  private _reaper: NodeJS.Timeout | undefined;

  constructor(ttlMs: number = browserSessionTtlMs()) {
    this._ttlMs = ttlMs;
  }

  /**
   * Mints a handle for a Context built by `createContext` — supplied per call,
   * never stored: a registry shared across backend instances (stateful HTTP
   * sessions, and the stateless HTTP path's fresh backend per request) serves
   * several live backends at once, and a registry-wide rebindable constructor
   * would mint every new session with the LAST initializer's identity — its
   * clientInfo (CDP User-Agent) and SessionLog (recorder entries in the wrong
   * session folder) — regardless of which client asked.
   *
   * The minted handle is handed to `createContext` so the Context knows the
   * identity it serves: the `--save-session` log is shared backend-wide, and
   * recorded user actions are tagged with the handle the way routed tool
   * calls already tag their logged args.
   */
  open(createContext: (id: string) => Context, sessionsUnsupportedReason?: string): string {
    BrowserSessionRegistry.checkSessionsSupported(sessionsUnsupportedReason);
    const id = `bs_${crypto.randomUUID()}`;
    this._sessions.set(id, { context: createContext(id), lastUsedAt: Date.now() });
    this._ensureReaper();
    return id;
  }

  /**
   * Throws the veto for modes whose factory hands every Context the same live
   * browser context (non-isolated CDP attach, extension, VS Code, custom
   * getters): a handle there would claim a separation that does not exist —
   * two "sessions" sharing tabs, cookies and storage. open() enforces this
   * itself; it is exposed so a caller with fallible pre-open side effects
   * (the backend resolves the --save-session log before minting a handle)
   * can fail first, without minting an empty session-* directory per
   * doomed attempt.
   */
  static checkSessionsSupported(sessionsUnsupportedReason: string | undefined): void {
    if (sessionsUnsupportedReason)
      throw new Error(`Cannot open a separate browser session: ${sessionsUnsupportedReason}`);
  }

  /** Returns the session's Context and refreshes its TTL. */
  resolve(id: string): Context {
    const entry = this._sessions.get(id);
    if (!entry)
      throw new Error(this._unknownSessionMessage(id));
    entry.lastUsedAt = Date.now();
    return entry.context;
  }

  /** Refreshes the TTL if the session still exists (e.g. after a tool run). */
  touch(id: string): void {
    const entry = this._sessions.get(id);
    if (entry)
      entry.lastUsedAt = Date.now();
  }

  async close(id: string): Promise<void> {
    const entry = this._sessions.get(id);
    if (!entry)
      throw new Error(this._unknownSessionMessage(id));
    // Disposing under a running call would yank the browser out from under it
    // (browser_session_close itself executes on the default Context, so it
    // never counts as the session's own running tool).
    if (entry.context.isRunningTool())
      throw new Error(`Browser session "${id}" still has a tool call running. Wait for it to finish, then retry browser_session_close.`);
    this._sessions.delete(id);
    this._stopReaperIfIdle();
    await entry.context.dispose();
  }

  async disposeAll(): Promise<void> {
    const contexts = [...this._sessions.values()].map(entry => entry.context);
    this._sessions.clear();
    this._stopReaperIfIdle();
    await Promise.all(contexts.map(context => context.dispose().catch(logUnhandledError)));
  }

  // Deliberately does NOT enumerate the open sessions: handles are bearer
  // tokens, and listing them would hand any caller with a mistyped handle the
  // keys to every other session's browser.
  private _unknownSessionMessage(id: string): string {
    return `Unknown browserSessionId "${id}": the session may have expired or been closed. Use browser_session_open to open a session, or omit browserSessionId to use the default session.`;
  }

  private _ensureReaper(): void {
    if (this._reaper || this._ttlMs <= 0 || !this._sessions.size)
      return;
    const interval = Math.min(this._ttlMs, 60_000);
    this._reaper = setInterval(() => this._reap(), interval);
    // The reaper must never keep the process alive on its own.
    this._reaper.unref?.();
  }

  private _stopReaperIfIdle(): void {
    if (!this._sessions.size && this._reaper) {
      clearInterval(this._reaper);
      this._reaper = undefined;
    }
  }

  private _reap(): void {
    const now = Date.now();
    for (const [id, entry] of this._sessions) {
      // A running tool holds the session's TTL: refresh instead of expiring,
      // so a long crawl that never re-touches the registry survives.
      if (entry.context.isRunningTool()) {
        entry.lastUsedAt = now;
        continue;
      }
      const recordingActivityAt = entry.context.recordingActivityAt();
      if (recordingActivityAt !== undefined && now - recordingActivityAt < this._ttlMs)
        continue;
      const idleFor = now - entry.lastUsedAt;
      if (idleFor < this._ttlMs)
        continue;
      // An in-flight download save holds expiry too — downloads outlive the
      // tool call that started them, and reaping would abort the save. But
      // the hold is bounded at one extra TTL period (proportionate to the
      // operator's configured idle tolerance): a stalled saveAs() on an
      // abandoned handle must not pin the browser forever. Because the tool
      // call that starts a download refreshes lastUsedAt as it finishes,
      // every download gets at least a full TTL of downloads-only grace,
      // and disposal itself still waits (bounded) for the save.
      if (entry.context.hasPendingDownloads() && idleFor < this._ttlMs * 2)
        continue;
      this._sessions.delete(id);
      void entry.context.dispose().catch(logUnhandledError);
    }
    this._stopReaperIfIdle();
  }
}
