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

export const VERSION = 2;
export const EXTENSION_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm';

export type Debuggee = { tabId?: number; extensionId?: string; targetId?: string };
export type DebuggerSession = Debuggee & { sessionId?: string };
/** @public */
export type TabCreateProperties = {
  active?: boolean;
  index?: number;
  openerTabId?: number;
  pinned?: boolean;
  url?: string;
  windowId?: number;
};
export type Tab = {
  id?: number;
  index: number;
  windowId: number;
  openerTabId?: number;
  url?: string;
  title?: string;
  active: boolean;
  pinned: boolean;
};
/** @public */
export type TabRemoveInfo = { windowId: number; isWindowClosing: boolean };

export type ExtensionCommandV2 = {
  'chrome.debugger.attach': {
    params: [target: Debuggee, requiredVersion: string];
    result: void;
  };
  'chrome.debugger.detach': {
    params: [target: Debuggee];
    result: void;
  };
  'chrome.debugger.sendCommand': {
    params: [target: DebuggerSession, method: string, commandParams?: object];
    result: any;
  };
  'chrome.tabs.create': {
    params: [createProperties: TabCreateProperties];
    result: Tab;
  };
  'chrome.tabs.remove': {
    params: [tabIds: number | number[]];
    result: void;
  };
};

export type ExtensionEventsV2 = {
  'chrome.debugger.onEvent': {
    params: [source: DebuggerSession, method: string, eventParams?: object];
  };
  'chrome.debugger.onDetach': {
    params: [source: Debuggee, reason: string];
  };
  'chrome.tabs.onCreated': {
    params: [tab: Tab];
  };
  'chrome.tabs.onRemoved': {
    params: [tabId: number, removeInfo: TabRemoveInfo];
  };
  'extension.initialized': {
    params: [];
  };
};
