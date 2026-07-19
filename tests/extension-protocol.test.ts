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

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { CDPRelayServer } from '../src/extension/cdpRelay.js';
import { ExtensionProtocolV2 } from '../src/extension/cdpRelayV2.js';
import { EXTENSION_ID, VERSION } from '../src/extension/protocol.js';

import type { CDPMessage } from '../src/extension/browserModel.js';
import type { Tab } from '../src/extension/protocol.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

describe('extension protocol v2', () => {
  it('tracks tabs and routes top-level, child, and browser CDP commands', async () => {
    const tabs = new Map<number, Tab>([
      [7, { id: 7, index: 0, windowId: 1, url: 'https://example.com', active: true, pinned: false }],
    ]);
    const sendCommand = vi.fn(async (method: string, params: any[]) => {
      if (method === 'chrome.tabs.create') {
        const tab = { id: 8, index: 1, windowId: 1, url: params[0].url, active: true, pinned: false };
        tabs.set(8, tab);
        handler.handleExtensionEvent('chrome.tabs.onCreated', [tab]);
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

    await expect(handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: true }, undefined))
        .resolves.toEqual({ result: {} });
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

    await handler.forwardToExtension('Page.enable', undefined, 'pw-tab-1');
    expect(sendCommand).toHaveBeenLastCalledWith('chrome.debugger.sendCommand', [
      { tabId: 7, sessionId: undefined },
      'Page.enable',
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
    expect(sendCommand.mock.calls.filter(([method, params]) => method === 'chrome.debugger.attach' && params[0].tabId === 8)).toHaveLength(1);
    await expect(handler.handleCDPCommand('Target.closeTarget', { targetId: 'target-8' }, undefined))
        .resolves.toEqual({ result: { success: true } });
    expect(sendCommand).toHaveBeenLastCalledWith('chrome.tabs.remove', [8]);

    await handler.forwardToExtension('Storage.getCookies', {}, undefined);
    expect(sendCommand).toHaveBeenLastCalledWith('chrome.debugger.sendCommand', [
      { tabId: 7 },
      'Storage.getCookies',
      {},
    ]);

    await expect(handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: false }, undefined))
        .resolves.toEqual({ result: {} });
    expect(sendCommand.mock.calls.filter(([method]) => method === 'chrome.debugger.detach')).toEqual([
      ['chrome.debugger.detach', [{ tabId: 7 }]],
      ['chrome.debugger.detach', [{ tabId: 8 }]],
    ]);
    expect(messages.filter(message => message.method === 'Target.detachedFromTarget')).toHaveLength(2);
  });

  it('rejects initial auto-attach when an existing tab cannot be attached', async () => {
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'chrome.debugger.attach')
        throw new Error('attach failed');
      return {};
    });
    const handler = new ExtensionProtocolV2(sendCommand);
    handler.handleExtensionEvent('chrome.tabs.onCreated', [
      { id: 7, index: 0, windowId: 1, active: true, pinned: false },
    ]);

    await expect(handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: true }, undefined))
        .rejects.toThrow('attach failed');
  });

  it('removes the token-bypass connect page after creating a target', async () => {
    const sendCommand = vi.fn(async (method: string, params: any[]) => {
      if (method === 'chrome.tabs.create')
        return { id: 8, url: params[0].url };
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo')
        return { targetInfo: { targetId: `target-${params[0].tabId}`, type: 'page' } };
      return {};
    });
    const handler = new ExtensionProtocolV2(sendCommand);
    handler.handleExtensionEvent('chrome.tabs.onCreated', [{
      id: 7,
      url: `chrome-extension://${EXTENSION_ID}/connect.html?mcpRelayUrl=ws%3A%2F%2F127.0.0.1`,
    }]);

    await handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: true }, undefined);
    await handler.handleCDPCommand('Target.createTarget', {}, undefined);

    expect(sendCommand).toHaveBeenCalledWith('chrome.tabs.remove', [7]);
  });

  it('serializes concurrent auto-attach state changes', async () => {
    let resolveDetach!: () => void;
    const detach = new Promise<void>(resolve => resolveDetach = resolve);
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'chrome.debugger.sendCommand')
        return { targetInfo: { targetId: 'target-7', type: 'page' } };
      if (method === 'chrome.debugger.detach')
        await detach;
      return {};
    });
    const handler = new ExtensionProtocolV2(sendCommand);
    handler.handleExtensionEvent('chrome.tabs.onCreated', [
      { id: 7, index: 0, windowId: 1, active: true, pinned: false },
    ]);
    await handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: true }, undefined);

    const disabling = handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: false }, undefined);
    await vi.waitFor(() => expect(sendCommand.mock.calls.some(([method]) => method === 'chrome.debugger.detach')).toBe(true));
    const enabling = handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: true }, undefined);
    let enabled = false;
    void enabling.then(() => enabled = true);
    await Promise.resolve();
    expect(enabled).toBe(false);
    expect(sendCommand.mock.calls.filter(([method]) => method === 'chrome.debugger.attach')).toHaveLength(1);

    resolveDetach();
    await expect(Promise.all([disabling, enabling])).resolves.toEqual([{ result: {} }, { result: {} }]);
    expect(sendCommand.mock.calls.filter(([method]) => method === 'chrome.debugger.attach')).toHaveLength(2);
  });

  it('accepts a replacement extension connection after disconnect', async () => {
    vi.mocked(spawn).mockClear();
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const relay = new CDPRelayServer(server, 'chrome', undefined, '/tmp/chrome');
    const clientInfo = { name: 'test-client', version: '1.0.0' };
    let second: WebSocket | undefined;
    try {
      const first = new WebSocket(relay.extensionEndpoint());
      await once(first, 'open');
      first.send(JSON.stringify({ method: 'extension.initialized', params: [] }));
      await relay.ensureExtensionConnectionForMCPContext(clientInfo, new AbortController().signal, undefined);

      first.close();
      await once(first, 'close');
      await vi.waitFor(() => expect((relay as any)._extensionConnection).toBeNull());

      const reconnecting = relay.ensureExtensionConnectionForMCPContext(clientInfo, new AbortController().signal, undefined);
      let reconnected = false;
      void reconnecting.then(() => reconnected = true);
      expect(spawn).toHaveBeenCalledTimes(1);
      second = new WebSocket(relay.extensionEndpoint());
      await once(second, 'open');
      await Promise.resolve();
      expect(reconnected).toBe(false);
      second.send(JSON.stringify({ method: 'extension.initialized', params: [] }));
      await expect(reconnecting).resolves.toBeUndefined();
      expect(second.readyState).toBe(WebSocket.OPEN);
    } finally {
      second?.close();
      relay.stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('waits for extension approval and forwards the configured token', async () => {
    vi.mocked(spawn).mockClear();
    vi.stubEnv('PLAYWRIGHT_MCP_EXTENSION_TOKEN', 'test-token');
    vi.stubEnv('PWMCP_TEST_CONNECTION_TIMEOUT', '1');
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const relay = new CDPRelayServer(server, 'chrome', undefined, '/tmp/chrome');
    let extension: WebSocket | undefined;
    try {
      const aborted = new AbortController();
      aborted.abort(new Error('cancelled'));
      await expect(relay.ensureExtensionConnectionForMCPContext(
          { name: 'test-client', version: '1.0.0' }, aborted.signal, undefined)).rejects.toThrow('cancelled');
      expect(spawn).not.toHaveBeenCalled();

      const connecting = relay.ensureExtensionConnectionForMCPContext(
          { name: 'test-client', version: '1.0.0' },
          new AbortController().signal,
          undefined,
      );
      let settled = false;
      void connecting.then(() => settled = true, () => settled = true);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(settled).toBe(false);

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      expect(new URL(args.at(-1)!).searchParams.get('token')).toBe('test-token');

      extension = new WebSocket(relay.extensionEndpoint());
      await once(extension, 'open');
      extension.send(JSON.stringify({ method: 'extension.initialized', params: [] }));
      await expect(connecting).resolves.toBeUndefined();
    } finally {
      extension?.close();
      relay.stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
      vi.unstubAllEnvs();
    }
  });
});
