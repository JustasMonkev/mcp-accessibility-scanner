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

import { ManualPromise } from '../mcp/manualPromise.js';
import { logUnhandledError } from '../utils/log.js';
import { BrowserModel } from './browserModel.js';

import type { SendCommand, SendToCDPClient } from './browserModel.js';
import type { ExtensionEventsV2 } from './protocol.js';

export class ExtensionProtocolV2 {
  private _model: BrowserModel;
  private _ready = new ManualPromise<void>();

  constructor(sendCommand: SendCommand, connectPagePrefix?: string) {
    this._model = new BrowserModel(sendCommand, connectPagePrefix);
    void this._ready.catch(logUnhandledError);
  }

  ready(): Promise<void> {
    return this._ready;
  }

  connectOverCDP(sendToCDPClient: SendToCDPClient): void {
    this._model.connectOverCDP(sendToCDPClient);
  }

  onExtensionDisconnect(reason: string): void {
    if (!this._ready.isDone())
      this._ready.reject(new Error(`Extension disconnected before initialization: ${reason}`));
  }

  handleExtensionEvent(method: string, params: any): void {
    switch (method) {
      case 'chrome.debugger.onEvent': {
        const [source, cdpMethod, cdpParams] = params as ExtensionEventsV2['chrome.debugger.onEvent']['params'];
        this._model.onDebuggerEvent(source, cdpMethod, cdpParams);
        break;
      }
      case 'chrome.debugger.onDetach': {
        const [source] = params as ExtensionEventsV2['chrome.debugger.onDetach']['params'];
        this._model.onDebuggerDetach(source);
        break;
      }
      case 'chrome.tabs.onCreated': {
        const [tab] = params as ExtensionEventsV2['chrome.tabs.onCreated']['params'];
        this._model.onTabCreated(tab);
        break;
      }
      case 'chrome.tabs.onRemoved': {
        const [tabId] = params as ExtensionEventsV2['chrome.tabs.onRemoved']['params'];
        this._model.onTabRemoved(tabId);
        break;
      }
      case 'extension.initialized': {
        this._ready.resolve();
        break;
      }
    }
  }

  async handleCDPCommand(method: string, params: any, sessionId: string | undefined): Promise<{ result: any } | undefined> {
    switch (method) {
      case 'Target.setAutoAttach': {
        if (sessionId)
          return undefined;
        if (params?.autoAttach)
          await this._model.enableAutoAttach();
        else
          await this._model.disableAutoAttach();
        return { result: {} };
      }
      case 'Target.createTarget':
        return { result: await this._model.createTarget(params?.url) };
      case 'Target.closeTarget':
        return { result: await this._model.closeTarget(params?.targetId) };
      case 'Target.getTargetInfo':
        return { result: this._model.getTargetInfo(sessionId) };
    }
    return undefined;
  }

  async forwardToExtension(method: string, params: any, sessionId: string | undefined): Promise<any> {
    if (!sessionId)
      return await this._model.sendBrowserCommand(method, params);
    return await this._model.sendCommand(sessionId, method, params);
  }
}
