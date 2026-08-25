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

type TabSession = {
  tabId: number;
  sessionId: string;
  targetInfo: any;
  childSessions: Set<string>;
};

// A detach that cancels an in-flight attach is recoverable, not a failure:
// the extension replays chrome.tabs.onCreated for the tab, which starts a
// fresh attachment. Auto-attach must not fail its initialization over it.
class TabDetachedWhileAttachingError extends Error {}

export class BrowserModel {
  private _sendToExtension: SendCommand;
  private _sendToCDPClient: SendToCDPClient | null = null;
  private _knownTabs = new Map<number, Tab>();
  private _tabSessions = new Map<number, TabSession>();
  private _tabAttachmentPromises = new Map<number, Promise<TabSession>>();
  // Every attempt from start to settlement. A detach cancels an attempt by
  // removing it from _tabAttachmentPromises before it settles, so that map
  // understates what is still running; the disable barrier drains this set.
  private _inFlightAttachAttempts = new Set<Promise<TabSession>>();
  // onDetach events owed per tab for attachments that provably ended before
  // their event was processed. chrome.debugger.onDetach names only the tab,
  // so this is how an event is matched to the attachment it ends.
  private _pendingStaleDetaches = new Map<number, number>();
  private _autoAttachOperation = Promise.resolve();
  private _autoAttach = false;
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
    this._pendingStaleDetaches.delete(tabId);
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

  onDebuggerDetach(source: Debuggee): void {
    if (source.tabId === undefined)
      return;
    const staleDetaches = this._pendingStaleDetaches.get(source.tabId);
    if (staleDetaches) {
      // This event ends an attachment that a later attach already replaced —
      // the attach could not have succeeded while it was alive. The current
      // attachment is untouched by it.
      if (staleDetaches === 1)
        this._pendingStaleDetaches.delete(source.tabId);
      else
        this._pendingStaleDetaches.set(source.tabId, staleDetaches - 1);
      return;
    }
    this._detachTab(source.tabId);
  }

  enableAutoAttach(): Promise<void> {
    return this._runAutoAttachOperation(async () => {
      this._autoAttach = true;
      const attachIgnoringCancellation = async (tabId: number) => {
        try {
          await this._attachTab(tabId);
        } catch (error) {
          if (!(error instanceof TabDetachedWhileAttachingError))
            throw error;
        }
      };
      await Promise.all([...this._knownTabs.keys()].map(async tabId => {
        try {
          await attachIgnoringCancellation(tabId);
        } catch (firstError) {
          // The failed command can be the detach itself, answered ahead of the
          // onDetach event that would have marked the attempt stale. Retrying
          // separates that from a tab that genuinely cannot be attached,
          // without matching on Chrome's error text, which is not a contract.
          try {
            await attachIgnoringCancellation(tabId);
          } catch (retryError) {
            // A first attempt that failed after chrome.debugger.attach had
            // succeeded leaves the debugger attached, so the retry reports
            // "Another debugger is already attached" rather than the reason
            // anyone needs. The relay forwards only Error.message, which never
            // carries a cause, so name both failures in the message itself.
            throw new Error(`Failed to attach tab ${tabId}: ${retryError} (first attempt: ${firstError})`, { cause: firstError });
          }
        }
      }));
    });
  }

  disableAutoAttach(): Promise<void> {
    return this._runAutoAttachOperation(async () => {
      this._autoAttach = false;
      // An attempt can register while we wait — a retry replacing a cancelled
      // attempt registers only once the original settles, which is exactly
      // when a one-shot snapshot stops waiting — so drain until nothing is in
      // flight rather than awaiting a snapshot.
      while (this._inFlightAttachAttempts.size)
        await Promise.allSettled([...this._inFlightAttachAttempts]);
      await Promise.all([...this._tabSessions.keys()].map(async tabId => {
        await this._sendToExtension('chrome.debugger.detach', [{ tabId }]);
        this._detachTab(tabId);
      }));
    });
  }

  async createTarget(url: string | undefined): Promise<{ targetId: string | undefined }> {
    const tab = await this._sendToExtension('chrome.tabs.create', [{ url }]);
    if (tab?.id === undefined)
      throw new Error('Failed to create tab');
    this._knownTabs.set(tab.id, tab);
    // A failed attach of the tab we just made can be a detach either way it
    // arrives: classified as a cancellation, or answered ahead of the onDetach
    // event that would have marked the attempt stale. Retry once rather than
    // failing the command, on the same terms as auto-attach — the tab is still
    // there, so the second attempt either attaches or fails with why it is
    // really gone. Do not wait for the extension to replay the tab instead: it
    // schedules a replay only for an involuntary detach, so a voluntary one
    // would wait forever.
    const tabSession = await this._attachTab(tab.id).catch(async firstError => {
      try {
        return await this._attachTab(tab.id);
      } catch (retryError) {
        // The first attempt may have left the debugger attached, so the retry
        // reports "Another debugger is already attached" rather than the reason
        // anyone needs. The relay forwards only Error.message, which never
        // carries a cause, so name both failures in the message itself.
        throw new Error(`Failed to attach tab ${tab.id}: ${retryError} (first attempt: ${firstError})`, { cause: firstError });
      }
    });
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

  private _attachTab(tabId: number): Promise<TabSession> {
    const existing = this._tabSessions.get(tabId);
    if (existing)
      return Promise.resolve(existing);
    const inFlight = this._tabAttachmentPromises.get(tabId);
    if (inFlight)
      return inFlight;
    const promise: Promise<TabSession> = Promise.resolve().then(() =>
      this._attachTabImpl(tabId, () => this._tabAttachmentPromises.get(tabId) === promise));
    this._tabAttachmentPromises.set(tabId, promise);
    // The barrier tracks the promise callers hold, not the raw attempt: a
    // caller's catch is attached to it before any drain can be, so a retry it
    // registers is always in the set by the time the drain re-checks.
    const settled: Promise<TabSession> = promise.finally(() => {
      this._inFlightAttachAttempts.delete(settled);
      if (this._tabAttachmentPromises.get(tabId) === promise)
        this._tabAttachmentPromises.delete(tabId);
    });
    this._inFlightAttachAttempts.add(settled);
    return settled;
  }

  private _runAutoAttachOperation(operation: () => Promise<void>): Promise<void> {
    const result = this._autoAttachOperation.then(operation);
    this._autoAttachOperation = result.catch(() => {});
    return result;
  }

  private async _attachTabImpl(tabId: number, isCurrentAttempt: () => boolean): Promise<TabSession> {
    // A detach can land anywhere below, either because the tab went away or
    // because Chrome force-detached the debugger. Both a call that fails
    // because of it and a reply that arrives after it are that cancellation,
    // not an attach failure: installing the session would hide a dead debuggee
    // behind a live-looking one and short-circuit the re-attach the extension
    // is about to ask for.
    let debuggerAttached = false;
    let result: any;
    try {
      await this._sendToExtension('chrome.debugger.attach', [{ tabId }, '1.3']);
      debuggerAttached = true;
      result = await this._sendToExtension('chrome.debugger.sendCommand', [
        { tabId },
        'Target.getTargetInfo',
      ]);
    } catch (error) {
      if (!isCurrentAttempt())
        throw this._abandonAttachAttempt(tabId, debuggerAttached);
      if (debuggerAttached) {
        try {
          // The failure leaves no session behind but may leave the debugger
          // attached, and a retry would then only ever report "Another
          // debugger is already attached". Undo the attach before surfacing
          // the failure, so a retry meets a detached tab.
          await this._sendToExtension('chrome.debugger.detach', [{ tabId }]);
        } catch {
          // Chrome refuses to detach a detached tab, so this failing means
          // the original failure WAS the detach, answered ahead of its
          // onDetach event. That event is still owed and must not tear down
          // whatever attachment exists when it arrives.
          this._pendingStaleDetaches.set(tabId, (this._pendingStaleDetaches.get(tabId) ?? 0) + 1);
        }
      }
      throw error;
    }
    if (!isCurrentAttempt())
      throw this._abandonAttachAttempt(tabId, debuggerAttached);
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

  private _abandonAttachAttempt(tabId: number, debuggerAttached: boolean): TabDetachedWhileAttachingError {
    // chrome.debugger.detach names only the tab, so once a replacement
    // attempt or session owns it, the undo would end the replacement's
    // attachment — and a detach we issue fires no onDetach to tell anyone.
    const tabTakenOver = this._tabSessions.has(tabId) || this._tabAttachmentPromises.has(tabId);
    if (debuggerAttached && !tabTakenOver) {
      // This attempt attached the debugger but installs no session, so nothing
      // would ever detach it and every later attach for the tab would fail
      // with "Another debugger is already attached". Undo it.
      void this._sendToExtension('chrome.debugger.detach', [{ tabId }]).catch(() => {
        // Already detached: the cancelling detach ended this attachment too.
      });
    }
    return new TabDetachedWhileAttachingError(`Tab ${tabId} was detached while attaching`);
  }

  private _detachTab(tabId: number): void {
    this._tabAttachmentPromises.delete(tabId);
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
