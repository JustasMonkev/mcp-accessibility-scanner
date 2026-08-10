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
 */
export type BrowserSessionBroker = {
  open(): string;
  close(id: string): Promise<void>;
};

const defaultSessionTtlMs = 30 * 60 * 1000;

/**
 * Inactivity TTL for explicitly opened browser sessions. Overridable via
 * `PLAYWRIGHT_MCP_BROWSER_SESSION_TTL_MS`; a present-but-blank or unparsable
 * value keeps the default rather than becoming 0, and a zero or negative
 * value disables reaping entirely.
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
export class BrowserSessionRegistry implements BrowserSessionBroker {
  private _sessions = new Map<string, SessionEntry>();
  private _createContext: () => Context;
  private _ttlMs: number;
  private _reaper: NodeJS.Timeout | undefined;
  private _sessionsUnsupportedReason: string | undefined;

  constructor(createContext: () => Context, ttlMs: number = browserSessionTtlMs(), sessionsUnsupportedReason?: string) {
    this._createContext = createContext;
    this._ttlMs = ttlMs;
    this._sessionsUnsupportedReason = sessionsUnsupportedReason;
  }

  open(): string {
    // Modes whose factory hands every Context the same live browser context
    // (non-isolated CDP attach, extension, VS Code, custom getters) are
    // refused up front: a handle here would claim a separation that does not
    // exist — two "sessions" sharing tabs, cookies and storage.
    if (this._sessionsUnsupportedReason)
      throw new Error(`Cannot open a separate browser session: ${this._sessionsUnsupportedReason}`);
    const id = `bs_${crypto.randomUUID()}`;
    this._sessions.set(id, { context: this._createContext(), lastUsedAt: Date.now() });
    this._ensureReaper();
    return id;
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

  private _unknownSessionMessage(id: string): string {
    const open = [...this._sessions.keys()];
    const known = open.length
      ? `Open sessions: ${open.join(', ')}.`
      : 'No browser sessions are open.';
    return `Unknown browserSessionId "${id}". ${known} Use browser_session_open to open one, or omit browserSessionId to use the default session.`;
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
      if (now - entry.lastUsedAt >= this._ttlMs) {
        this._sessions.delete(id);
        void entry.context.dispose().catch(logUnhandledError);
      }
    }
    this._stopReaperIfIdle();
  }
}
