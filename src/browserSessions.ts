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

export type BrowserSessionBroker = {
  open(): Promise<string>;
  close(id: string): Promise<void>;
};

const defaultSessionTtlMs = 30 * 60 * 1000;

/** @public */
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

export class BrowserSessionRegistry {
  private _sessions = new Map<string, SessionEntry>();
  private _ttlMs: number;
  private _reaper: NodeJS.Timeout | undefined;

  constructor(ttlMs: number = browserSessionTtlMs()) {
    this._ttlMs = ttlMs;
  }

  open(createContext: (id: string) => Context, sessionsUnsupportedReason?: string): string {
    BrowserSessionRegistry.checkSessionsSupported(sessionsUnsupportedReason);
    const id = `bs_${crypto.randomUUID()}`;
    this._sessions.set(id, { context: createContext(id), lastUsedAt: Date.now() });
    this._ensureReaper();
    return id;
  }

  static checkSessionsSupported(sessionsUnsupportedReason: string | undefined): void {
    if (sessionsUnsupportedReason)
      throw new Error(`Cannot open a separate browser session: ${sessionsUnsupportedReason}`);
  }

  resolve(id: string): Context {
    const entry = this._sessions.get(id);
    if (!entry)
      throw new Error(this._unknownSessionMessage(id));
    entry.lastUsedAt = Date.now();
    return entry.context;
  }

  touch(id: string): void {
    const entry = this._sessions.get(id);
    if (entry)
      entry.lastUsedAt = Date.now();
  }

  async close(id: string): Promise<void> {
    const entry = this._sessions.get(id);
    if (!entry)
      throw new Error(this._unknownSessionMessage(id));
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
    return `Unknown browserSessionId "${id}": the session may have expired or been closed. Use browser_session_open to open a session, or omit browserSessionId to use the default session.`;
  }

  private _ensureReaper(): void {
    if (this._reaper || this._ttlMs <= 0 || !this._sessions.size)
      return;
    const interval = Math.min(this._ttlMs, 60_000);
    this._reaper = setInterval(() => this._reap(), interval);
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
      if (entry.context.hasPendingDownloads() && idleFor < this._ttlMs * 2)
        continue;
      this._sessions.delete(id);
      void entry.context.dispose().catch(logUnhandledError);
    }
    this._stopReaperIfIdle();
  }
}
