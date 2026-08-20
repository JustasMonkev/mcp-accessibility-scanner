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

import { logUnhandledError } from '../utils/log.js';

import type { DebuggerSession, Debuggee, Tab } from './protocol.js';

export type CDPMessage = {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message: string };
};

export type SendCommand = (method: string, params: any) => Promise<any>;
export type SendToCDPClient = (message: CDPMessage) => void;

// Chrome force-detaches chrome.debugger from the whole tab (onDetach reason
// "target_closed") when a frame navigates to a scheme it cannot attach to,
// even though the tab stays open and re-attachable. Mirroring the recovery
// upstream added to the extension in microsoft/playwright#42221, wait for the
// navigation to settle before re-attaching, and space attempts at least the
// cooldown apart so a page that keeps triggering the condition cannot cause a
// tight re-attach loop.
/** @public */
export const REATTACH_DELAY_MS = 500;
/** @public */
export const REATTACH_COOLDOWN_MS = 10_000;
// Consecutive failed recovery attempts before a tab is given up on, so a tab
// that can no longer be attached at all does not keep the model retrying
// forever in the background.
/** @public */
export const REATTACH_MAX_ATTEMPTS = 3;

type TabSession = {
  tabId: number;
  sessionId: string;
  targetInfo: any;
  childSessions: Set<string>;
};

export class BrowserModel {
  private _sendToExtension: SendCommand;
  private _sendToCDPClient: SendToCDPClient | null = null;
  private _knownTabs = new Map<number, Tab>();
  private _tabSessions = new Map<number, TabSession>();
  private _tabAttachmentPromises = new Map<number, Promise<TabSession>>();
  private _reattachTimers = new Map<number, NodeJS.Timeout>();
  private _lastReattachAttempt = new Map<number, number>();
  private _reattachFailures = new Map<number, number>();
  private _autoAttachOperation = Promise.resolve();
  private _autoAttach = false;
  private _disposed = false;
  private _nextSessionId = 1;

  constructor(sendToExtension: SendCommand, private _connectPagePrefix?: string) {
    this._sendToExtension = sendToExtension;
  }

  connectOverCDP(sendToCDPClient: SendToCDPClient): void {
    this._sendToCDPClient = sendToCDPClient;
  }

  private _emit(message: CDPMessage): void {
    this._sendToCDPClient?.(message);
  }

  onTabCreated(tab: Tab): void {
    if (tab.id === undefined)
      return;
    this._knownTabs.set(tab.id, tab);
    if (this._autoAttach)
      void this._attachTab(tab.id).catch(logUnhandledError);
  }

  onTabRemoved(tabId: number): void {
    this._knownTabs.delete(tabId);
    this._cancelReattach(tabId);
    this._lastReattachAttempt.delete(tabId);
    this._reattachFailures.delete(tabId);
    this._detachTab(tabId);
  }

  onDebuggerEvent(source: DebuggerSession, method: string, params: any): void {
    if (source.tabId === undefined)
      return;
    const tabSession = this._tabSessions.get(source.tabId);
    if (!tabSession)
      return;
    const childSessionId = (params as { sessionId?: string } | undefined)?.sessionId;
    if (method === 'Target.attachedToTarget' && childSessionId)
      tabSession.childSessions.add(childSessionId);
    else if (method === 'Target.detachedFromTarget' && childSessionId)
      tabSession.childSessions.delete(childSessionId);
    this._emit({ sessionId: source.sessionId || tabSession.sessionId, method, params });
  }

  onDebuggerDetach(source: Debuggee, reason?: string): void {
    if (source.tabId === undefined)
      return;
    if (reason === 'target_closed') {
      this._recoverAfterInvoluntaryDetach(source.tabId);
    } else {
      // A voluntary detach is terminal: make sure no recovery re-attaches
      // the tab behind the client's back.
      this._cancelReattach(source.tabId);
      this._detachTab(source.tabId);
    }
  }

  // The extension connection is gone; this model is about to be replaced and
  // must not act over whatever connection the relay holds next — the send
  // closure resolves the relay's current connection at each call, so pending
  // timers and in-flight attach operations both have to stand down.
  dispose(): void {
    this._disposed = true;
    for (const tabId of [...this._reattachTimers.keys()])
      this._cancelReattach(tabId);
  }

  // "target_closed" is an involuntary detach: Chrome dropped the debugger
  // session, but the tab may still be open (chrome.tabs.onRemoved tells us
  // when it actually closes). The old CDP session is gone either way — its
  // enabled domains and child sessions do not survive a re-attach — so tear
  // it down for the client, then re-attach the tab under a fresh session.
  private _recoverAfterInvoluntaryDetach(tabId: number): void {
    if (this._disposed)
      return;
    const inFlightAttach = this._tabAttachmentPromises.get(tabId);
    if (inFlightAttach) {
      // The debugger detached while an attach was still completing. If that
      // attach fails against the now-detached debugger there is no session to
      // observe the detach, so recover once the attempt settles instead of
      // losing the tab.
      void inFlightAttach.then(
          () => this._recoverAfterInvoluntaryDetach(tabId),
          () => this._scheduleReattach(tabId),
      );
      return;
    }
    if (!this._tabSessions.has(tabId))
      return;
    // A live session proves the last attach succeeded, so this is a fresh
    // recovery episode with a fresh attempt budget.
    this._reattachFailures.delete(tabId);
    this._detachTab(tabId);
    this._scheduleReattach(tabId);
  }

  private _scheduleReattach(tabId: number): void {
    if (this._disposed || !this._knownTabs.has(tabId) || this._reattachTimers.has(tabId))
      return;
    if (this._reattachBudgetSpent(tabId))
      return;
    // Wait out whatever remains of the cooldown since the last attempt, so a
    // page that keeps forcing detaches is retried at most once per cooldown
    // instead of in a tight loop.
    const lastAttempt = this._lastReattachAttempt.get(tabId);
    const cooldownRemaining = lastAttempt === undefined
      ? 0
      : Math.max(0, lastAttempt + REATTACH_COOLDOWN_MS - Date.now());
    const timer = setTimeout(() => {
      this._reattachTimers.delete(tabId);
      if (this._disposed || !this._knownTabs.has(tabId) || this._tabSessions.has(tabId))
        return;
      // The budget can run out after this timer was scheduled — a detach
      // event racing a failing attempt schedules the next timer before that
      // attempt's failure is counted — so re-check at fire time.
      if (this._reattachBudgetSpent(tabId))
        return;
      this._lastReattachAttempt.set(tabId, Date.now());
      void this._attachTab(tabId, { tolerateAlreadyAttached: true }).then(
          () => this._reattachFailures.delete(tabId),
          error => {
            logUnhandledError(error);
            this._reattachFailures.set(tabId, (this._reattachFailures.get(tabId) ?? 0) + 1);
            // A failed attempt may be transient (e.g. another navigation raced
            // the re-attach), so retry after the cooldown until the budget for
            // this recovery episode is spent (_scheduleReattach enforces it).
            this._scheduleReattach(tabId);
          },
      );
    }, Math.max(REATTACH_DELAY_MS, cooldownRemaining));
    timer.unref?.();
    this._reattachTimers.set(tabId, timer);
  }

  private _reattachBudgetSpent(tabId: number): boolean {
    return (this._reattachFailures.get(tabId) ?? 0) >= REATTACH_MAX_ATTEMPTS;
  }

  private _cancelReattach(tabId: number): void {
    const timer = this._reattachTimers.get(tabId);
    if (timer === undefined)
      return;
    clearTimeout(timer);
    this._reattachTimers.delete(tabId);
  }

  enableAutoAttach(): Promise<void> {
    return this._runAutoAttachOperation(async () => {
      this._autoAttach = true;
      await Promise.all([...this._knownTabs.keys()].map(tabId => this._attachTab(tabId)));
    });
  }

  disableAutoAttach(): Promise<void> {
    return this._runAutoAttachOperation(async () => {
      this._autoAttach = false;
      for (const tabId of [...this._reattachTimers.keys()])
        this._cancelReattach(tabId);
      await Promise.allSettled(this._tabAttachmentPromises.values());
      try {
        await Promise.all([...this._tabSessions.keys()].map(async tabId => {
          try {
            await this._sendToExtension('chrome.debugger.detach', [{ tabId }]);
          } finally {
            // The detach RPC rejects when Chrome already force-detached; the
            // session is dead either way, so tell the client and drop it.
            this._detachTab(tabId);
          }
        }));
      } finally {
        // A target_closed event arriving during the awaits above can schedule
        // a new recovery, and a detach RPC can reject when Chrome already
        // force-detached — so cancel once more however the operation settles.
        for (const tabId of [...this._reattachTimers.keys()])
          this._cancelReattach(tabId);
      }
    });
  }

  async createTarget(url: string | undefined): Promise<{ targetId: string | undefined }> {
    const tab = await this._sendToExtension('chrome.tabs.create', [{ url }]);
    if (tab?.id === undefined)
      throw new Error('Failed to create tab');
    this._knownTabs.set(tab.id, tab);
    const tabSession = await this._attachTab(tab.id);
    if (this._connectPagePrefix) {
      const connectPagePrefix = this._connectPagePrefix;
      await Promise.allSettled([...this._knownTabs]
          .filter(([tabId, knownTab]) => tabId !== tab.id && knownTab.url?.startsWith(connectPagePrefix))
          .map(async ([tabId]) => {
            const result = await this._sendDebuggerCommand({ tabId }, 'Target.getTargetInfo', undefined);
            if (result?.targetInfo?.url?.startsWith(connectPagePrefix))
              await this._sendToExtension('chrome.tabs.remove', [tabId]);
          }));
    }
    return { targetId: tabSession.targetInfo?.targetId };
  }

  async closeTarget(targetId: string | undefined): Promise<{ success: boolean }> {
    const tabSession = targetId ? this._findTabSession(session => session.targetInfo?.targetId === targetId) : undefined;
    if (!tabSession)
      return { success: false };
    await this._sendToExtension('chrome.tabs.remove', [tabSession.tabId]);
    return { success: true };
  }

  getTargetInfo(sessionId: string | undefined): any {
    if (!sessionId)
      return undefined;
    return this._findTabSession(session => session.sessionId === sessionId)?.targetInfo;
  }

  async sendBrowserCommand(method: string, params: any): Promise<any> {
    const tabSession = this._tabSessions.values().next().value;
    if (!tabSession)
      throw new Error(`No attached tab to forward browser-level command: ${method}`);
    return await this._sendDebuggerCommand({ tabId: tabSession.tabId }, method, params);
  }

  async sendCommand(sessionId: string, method: string, params: any): Promise<any> {
    let tabSession = this._findTabSession(session => session.sessionId === sessionId);
    let cdpSessionId: string | undefined;
    if (!tabSession) {
      tabSession = this._findTabSession(session => session.childSessions.has(sessionId));
      cdpSessionId = sessionId;
    }
    if (!tabSession)
      throw new Error(`No tab found for sessionId: ${sessionId}`);
    return await this._sendDebuggerCommand({ tabId: tabSession.tabId, sessionId: cdpSessionId }, method, params);
  }

  private async _sendDebuggerCommand(target: DebuggerSession, method: string, params: any): Promise<any> {
    const command: [DebuggerSession, string, object?] = [target, method];
    if (params !== undefined)
      command.push(params);
    return await this._sendToExtension('chrome.debugger.sendCommand', command);
  }

  private _attachTab(tabId: number, options?: { tolerateAlreadyAttached?: boolean }): Promise<TabSession> {
    const existing = this._tabSessions.get(tabId);
    if (existing)
      return Promise.resolve(existing);
    const inFlight = this._tabAttachmentPromises.get(tabId);
    if (inFlight)
      return inFlight;
    const promise = Promise.resolve().then(() => this._attachTabImpl(tabId, options));
    this._tabAttachmentPromises.set(tabId, promise);
    return promise.finally(() => {
      if (this._tabAttachmentPromises.get(tabId) === promise)
        this._tabAttachmentPromises.delete(tabId);
    });
  }

  private _runAutoAttachOperation(operation: () => Promise<void>): Promise<void> {
    const result = this._autoAttachOperation.then(operation);
    this._autoAttachOperation = result.catch(() => {});
    return result;
  }

  private async _attachTabImpl(tabId: number, options?: { tolerateAlreadyAttached?: boolean }): Promise<TabSession> {
    try {
      await this._sendToExtension('chrome.debugger.attach', [{ tabId }, '1.3']);
    } catch (error) {
      // The published extension recovers from involuntary detaches on its own
      // (microsoft/playwright#42221); if it re-attached before our recovery
      // fired, the attach fails with "already attached" while the debugger is
      // in fact attached — proceed and rebuild the session instead of losing
      // the tab.
      const alreadyAttached = error instanceof Error && /already attached/i.test(error.message);
      if (!options?.tolerateAlreadyAttached || !alreadyAttached)
        throw error;
    }
    try {
      // Re-check after every await: the model may have been disposed while
      // the extension round trip was in flight, and the send closure would
      // otherwise act over whatever connection replaced the disconnected one.
      if (this._disposed)
        throw new Error('Browser model was disposed while attaching');
      return await this._createTabSession(tabId);
    } catch (error) {
      // The debugger is attached but no session tracks it, so nothing would
      // ever detach it or observe its detach events. Roll the attach back
      // (unless disposed — then no RPC may leave this model) so the tab stays
      // re-attachable, and await it so no retry can adopt the half-attached
      // debugger before the detach has settled.
      if (!this._disposed)
        await this._sendToExtension('chrome.debugger.detach', [{ tabId }]).catch(logUnhandledError);
      throw error;
    }
  }

  private async _createTabSession(tabId: number): Promise<TabSession> {
    const result = await this._sendToExtension('chrome.debugger.sendCommand', [
      { tabId },
      'Target.getTargetInfo',
    ]);
    if (this._disposed)
      throw new Error('Browser model was disposed while attaching');
    const targetInfo = result?.targetInfo;
    const sessionId = `pw-tab-${this._nextSessionId++}`;
    const tabSession: TabSession = { tabId, sessionId, targetInfo, childSessions: new Set() };
    this._tabSessions.set(tabId, tabSession);
    this._emit({
      method: 'Target.attachedToTarget',
      params: {
        sessionId,
        targetInfo: { ...targetInfo, attached: true },
        waitingForDebugger: false,
      },
    });
    return tabSession;
  }

  private _detachTab(tabId: number): void {
    const tabSession = this._tabSessions.get(tabId);
    if (!tabSession)
      return;
    this._tabSessions.delete(tabId);
    this._emit({
      method: 'Target.detachedFromTarget',
      params: {
        sessionId: tabSession.sessionId,
        targetId: tabSession.targetInfo?.targetId,
      },
    });
  }

  private _findTabSession(predicate: (session: TabSession) => boolean): TabSession | undefined {
    for (const session of this._tabSessions.values()) {
      if (predicate(session))
        return session;
    }
    return undefined;
  }
}
