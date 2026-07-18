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

import { describe, expect, it, vi } from 'vitest';
import { ExtensionProtocolV2 } from '../src/extension/cdpRelayV2.js';
import { EXTENSION_ID, VERSION } from '../src/extension/protocol.js';

import type { CDPMessage } from '../src/extension/browserModel.js';
import type { Tab } from '../src/extension/protocol.js';

describe('extension protocol v2', () => {
  it('tracks tabs and routes top-level, child, and browser CDP commands', async () => {
    const tabs = new Map<number, Tab>([
      [7, { id: 7, index: 0, windowId: 1, url: 'https://example.com', active: true, pinned: false }],
    ]);
    const sendCommand = vi.fn(async (method: string, params: any[]) => {
      if (method === 'chrome.tabs.create') {
        const tab = { id: 8, index: 1, windowId: 1, url: params[0].url, active: true, pinned: false };
        tabs.set(8, tab);
        return tab;
      }
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo')
        return { targetInfo: { targetId: `target-${params[0].tabId}`, type: 'page', url: tabs.get(params[0].tabId)?.url } };
      return {};
    });
    const messages: CDPMessage[] = [];
    const handler = new ExtensionProtocolV2(sendCommand);
    handler.connectOverCDP(message => messages.push(message));

    expect(VERSION).toBe(2);
    expect(EXTENSION_ID).toBe('mmlmfjhmonkocbjadbfplnigmagldckm');
    handler.handleExtensionEvent('chrome.tabs.onCreated', [tabs.get(7)]);
    handler.handleExtensionEvent('extension.initialized', []);
    await expect(handler.ready()).resolves.toBeUndefined();

    await expect(handler.handleCDPCommand('Target.setAutoAttach', {}, undefined)).resolves.toEqual({ result: {} });
    expect(sendCommand).toHaveBeenNthCalledWith(1, 'chrome.debugger.attach', [{ tabId: 7 }, '1.3']);
    expect(sendCommand).toHaveBeenNthCalledWith(2, 'chrome.debugger.sendCommand', [{ tabId: 7 }, 'Target.getTargetInfo']);
    expect(messages[0]).toMatchObject({
      method: 'Target.attachedToTarget',
      params: { sessionId: 'pw-tab-1', targetInfo: { targetId: 'target-7', attached: true } },
    });

    await handler.forwardToExtension('Runtime.evaluate', { expression: '1 + 1' }, 'pw-tab-1');
    expect(sendCommand).toHaveBeenLastCalledWith('chrome.debugger.sendCommand', [
      { tabId: 7, sessionId: undefined },
      'Runtime.evaluate',
      { expression: '1 + 1' },
    ]);

    handler.handleExtensionEvent('chrome.debugger.onEvent', [
      { tabId: 7 },
      'Target.attachedToTarget',
      { sessionId: 'child-1' },
    ]);
    await handler.forwardToExtension('Runtime.enable', {}, 'child-1');
    expect(sendCommand).toHaveBeenLastCalledWith('chrome.debugger.sendCommand', [
      { tabId: 7, sessionId: 'child-1' },
      'Runtime.enable',
      {},
    ]);

    await expect(handler.handleCDPCommand('Target.createTarget', { url: 'https://example.org' }, undefined))
        .resolves.toEqual({ result: { targetId: 'target-8' } });
    await expect(handler.handleCDPCommand('Target.closeTarget', { targetId: 'target-8' }, undefined))
        .resolves.toEqual({ result: { success: true } });
    expect(sendCommand).toHaveBeenLastCalledWith('chrome.tabs.remove', [8]);

    await handler.forwardToExtension('Storage.getCookies', {}, undefined);
    expect(sendCommand).toHaveBeenLastCalledWith('chrome.debugger.sendCommand', [
      { tabId: 7 },
      'Storage.getCookies',
      {},
    ]);
  });
});
