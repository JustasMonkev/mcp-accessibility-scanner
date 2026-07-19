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

export class BrowserModel {
  private _sendToExtension: SendCommand;
  private _sendToCDPClient: SendToCDPClient | null = null;
  private _knownTabs = new Map<number, Tab>();
  private _tabSessions = new Map<number, TabSession>();
  private _tabAttachmentPromises = new Map<number, Promise<TabSession>>();
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
    if (source.tabId !== undefined)
      this._detachTab(source.tabId);
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
      await Promise.allSettled(this._tabAttachmentPromises.values());
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

  private _attachTab(tabId: number): Promise<TabSession> {
    const existing = this._tabSessions.get(tabId);
    if (existing)
      return Promise.resolve(existing);
    const inFlight = this._tabAttachmentPromises.get(tabId);
    if (inFlight)
      return inFlight;
    const promise = Promise.resolve().then(() => this._attachTabImpl(tabId));
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

  private async _attachTabImpl(tabId: number): Promise<TabSession> {
    await this._sendToExtension('chrome.debugger.attach', [{ tabId }, '1.3']);
    const result = await this._sendToExtension('chrome.debugger.sendCommand', [
      { tabId },
      'Target.getTargetInfo',
    ]);
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
