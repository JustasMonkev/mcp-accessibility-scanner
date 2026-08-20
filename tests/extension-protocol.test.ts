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
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import * as playwright from 'playwright';
import { CDPRelayServer } from '../src/extension/cdpRelay.js';
import { ExtensionContextFactory } from '../src/extension/extensionContextFactory.js';
import { ExtensionProtocolV2 } from '../src/extension/cdpRelayV2.js';
import { REATTACH_COOLDOWN_MS, REATTACH_DELAY_MS } from '../src/extension/browserModel.js';
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

  it('best-effort removes only this relay\'s seed while it is still on the connect page', async () => {
    const connectPage = new URL(`chrome-extension://${EXTENSION_ID}/connect.html`);
    connectPage.searchParams.set('mcpRelayUrl', 'ws://127.0.0.1/current');
    const connectPagePrefix = connectPage.toString();
    const sendCommand = vi.fn(async (method: string, params: any[]) => {
      if (method === 'chrome.tabs.create')
        return { id: 8, url: params[0].url };
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') {
        const tabId = params[0].tabId;
        const url = tabId === 7 ? `${connectPagePrefix}&client=current` : tabId === 10 ? 'https://example.com' : undefined;
        return { targetInfo: { targetId: `target-${tabId}`, type: 'page', url } };
      }
      if (method === 'chrome.tabs.remove')
        throw new Error('tab already closed');
      return {};
    });
    const handler = new ExtensionProtocolV2(sendCommand, connectPagePrefix);
    handler.handleExtensionEvent('chrome.tabs.onCreated', [
      { id: 7, url: `${connectPagePrefix}&client=current` },
      { id: 9, url: `chrome-extension://${EXTENSION_ID}/connect.html?mcpRelayUrl=ws%3A%2F%2F127.0.0.1%2Fother` },
      { id: 10, url: `${connectPagePrefix}&client=current` },
    ]);

    await handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: true }, undefined);
    await expect(handler.handleCDPCommand('Target.createTarget', {}, undefined))
        .resolves.toEqual({ result: { targetId: 'target-8' } });

    expect(sendCommand).toHaveBeenCalledWith('chrome.tabs.remove', [7]);
    expect(sendCommand).not.toHaveBeenCalledWith('chrome.tabs.remove', [9]);
    expect(sendCommand).not.toHaveBeenCalledWith('chrome.tabs.remove', [10]);
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

  it('releases the relay HTTP server port on stop, and stop is idempotent', async () => {
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())));
    const relay = new CDPRelayServer(server, 'chrome', undefined, '/tmp/chrome');
    expect(server.listening).toBe(true);

    relay.stop();
    expect(server.listening).toBe(false);
    expect(() => relay.stop()).not.toThrow();
  });

  it('stops the relay when CDP attachment fails', async () => {
    onTestFinished(() => vi.restoreAllMocks());
    const ensure = vi.spyOn(CDPRelayServer.prototype, 'ensureExtensionConnectionForMCPContext').mockResolvedValue(undefined);
    const stop = vi.spyOn(CDPRelayServer.prototype, 'stop');
    vi.spyOn(playwright.chromium, 'connectOverCDP').mockRejectedValue(new Error('attach failed'));
    onTestFinished(() => (ensure.mock.instances[0] as CDPRelayServer | undefined)?.stop());

    const factory = new ExtensionContextFactory('chrome', undefined, '/tmp/chrome');
    await expect(factory.createContext(
        { name: 'test-client', version: '1.0.0' }, new AbortController().signal, undefined)).rejects.toThrow('attach failed');
    expect(stop).toHaveBeenCalledTimes(1);
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

  it('launches the profile containing the extension', async () => {
    vi.mocked(spawn).mockClear();
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-extension-profile-'));
    await fs.mkdir(path.join(userDataDir, 'Default', 'Extensions', EXTENSION_ID), { recursive: true });
    await fs.mkdir(path.join(userDataDir, 'Profile 1', 'Extensions', EXTENSION_ID), { recursive: true });
    await fs.writeFile(path.join(userDataDir, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 1' } }));
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const relay = new CDPRelayServer(server, 'chrome', userDataDir, '/tmp/chrome');
    let extension: WebSocket | undefined;
    try {
      const connecting = relay.ensureExtensionConnectionForMCPContext(
          { name: 'test-client', version: '1.0.0' },
          new AbortController().signal,
          undefined,
      );
      await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
      expect(vi.mocked(spawn).mock.calls[0][1]).toContain('--profile-directory=Profile 1');

      extension = new WebSocket(relay.extensionEndpoint());
      await once(extension, 'open');
      extension.send(JSON.stringify({ method: 'extension.initialized', params: [] }));
      await expect(connecting).resolves.toBeUndefined();
    } finally {
      extension?.close();
      relay.stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.rm(userDataDir, { recursive: true });
    }
  });

  it('does not launch Chrome when cancelled during profile discovery', async () => {
    vi.mocked(spawn).mockClear();
    let finishScan!: () => void;
    const scan = new Promise<void>(resolve => finishScan = resolve);
    const readdir = vi.spyOn(fs, 'readdir').mockImplementationOnce(async () => {
      await scan;
      return [] as any;
    });
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const relay = new CDPRelayServer(server, 'chrome', '/tmp/profile', '/tmp/chrome');
    try {
      const controller = new AbortController();
      const connecting = relay.ensureExtensionConnectionForMCPContext(
          { name: 'test-client', version: '1.0.0' },
          controller.signal,
          undefined,
      );
      await vi.waitFor(() => expect(readdir).toHaveBeenCalled());
      controller.abort(new Error('cancelled during profile discovery'));

      await expect(connecting).rejects.toThrow('cancelled during profile discovery');
      expect(spawn).not.toHaveBeenCalled();
      finishScan();
      await Promise.resolve();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      readdir.mockRestore();
      relay.stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe('involuntary debugger detach recovery', () => {
  // Drains the microtask chain of an in-flight async attach without relying
  // on real timers (the tests below run under fake timers).
  async function flushMicrotasks() {
    for (let i = 0; i < 20; i++)
      await Promise.resolve();
  }

  function attachCount(sendCommand: ReturnType<typeof vi.fn>) {
    return sendCommand.mock.calls.filter(([method]) => method === 'chrome.debugger.attach').length;
  }

  // Creates a handler with tab 7 attached under sessionId pw-tab-1, so each
  // test starts from a live debugger session it can then knock out.
  async function createAttachedHandler(overrides: { attach?: (call: number) => void } = {}) {
    vi.useFakeTimers();
    onTestFinished(() => vi.useRealTimers());
    let attachCalls = 0;
    const sendCommand = vi.fn(async (method: string, params: any[]) => {
      if (method === 'chrome.debugger.attach') {
        attachCalls++;
        overrides.attach?.(attachCalls);
        return undefined;
      }
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo')
        return { targetInfo: { targetId: `target-${params[0].tabId}`, type: 'page' } };
      return {};
    });
    const messages: CDPMessage[] = [];
    const handler = new ExtensionProtocolV2(sendCommand);
    handler.connectOverCDP(message => messages.push(message));
    handler.handleExtensionEvent('chrome.tabs.onCreated', [
      { id: 7, index: 0, windowId: 1, active: true, pinned: false },
    ]);
    await handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: true }, undefined);
    expect(messages.at(-1)).toMatchObject({ method: 'Target.attachedToTarget', params: { sessionId: 'pw-tab-1' } });
    return { handler, sendCommand, messages };
  }

  it('still tears down the session on a voluntary detach', async () => {
    const { handler, sendCommand, messages } = await createAttachedHandler();

    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 7 }, 'canceled_by_user']);
    expect(messages.at(-1)).toMatchObject({
      method: 'Target.detachedFromTarget',
      params: { sessionId: 'pw-tab-1', targetId: 'target-7' },
    });

    await vi.advanceTimersByTimeAsync(REATTACH_COOLDOWN_MS);
    await flushMicrotasks();
    expect(attachCount(sendCommand)).toBe(1);
    await expect(handler.forwardToExtension('Runtime.evaluate', {}, 'pw-tab-1'))
        .rejects.toThrow('No tab found for sessionId: pw-tab-1');
  });

  it('re-attaches the tab under a fresh session after a target_closed detach', async () => {
    const { handler, sendCommand, messages } = await createAttachedHandler();

    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 7 }, 'target_closed']);
    expect(messages.at(-1)).toMatchObject({
      method: 'Target.detachedFromTarget',
      params: { sessionId: 'pw-tab-1', targetId: 'target-7' },
    });
    expect(attachCount(sendCommand)).toBe(1);

    await vi.advanceTimersByTimeAsync(REATTACH_DELAY_MS);
    await flushMicrotasks();
    expect(attachCount(sendCommand)).toBe(2);
    expect(messages.at(-1)).toMatchObject({
      method: 'Target.attachedToTarget',
      params: { sessionId: 'pw-tab-2', targetInfo: { targetId: 'target-7', attached: true } },
    });

    await handler.forwardToExtension('Runtime.evaluate', { expression: '1 + 1' }, 'pw-tab-2');
    expect(sendCommand).toHaveBeenLastCalledWith('chrome.debugger.sendCommand', [
      { tabId: 7, sessionId: undefined },
      'Runtime.evaluate',
      { expression: '1 + 1' },
    ]);
  });

  it('treats "already attached" during recovery as the extension having recovered on its own', async () => {
    const { handler, sendCommand, messages } = await createAttachedHandler({
      attach: call => {
        if (call === 2)
          throw new Error('Another debugger is already attached to the tab with id: 7.');
      },
    });

    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 7 }, 'target_closed']);
    await vi.advanceTimersByTimeAsync(REATTACH_DELAY_MS);
    await flushMicrotasks();

    expect(attachCount(sendCommand)).toBe(2);
    expect(messages.at(-1)).toMatchObject({
      method: 'Target.attachedToTarget',
      params: { sessionId: 'pw-tab-2', targetInfo: { targetId: 'target-7', attached: true } },
    });
  });

  it('keeps "already attached" fatal outside of recovery', async () => {
    vi.useFakeTimers();
    onTestFinished(() => vi.useRealTimers());
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'chrome.debugger.attach')
        throw new Error('Another debugger is already attached to the tab with id: 7.');
      return {};
    });
    const handler = new ExtensionProtocolV2(sendCommand);
    handler.handleExtensionEvent('chrome.tabs.onCreated', [
      { id: 7, index: 0, windowId: 1, active: true, pinned: false },
    ]);

    await expect(handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: true }, undefined))
        .rejects.toThrow('already attached');
  });

  it('gives up instead of looping when the page keeps forcing detaches within the cooldown', async () => {
    const { handler, sendCommand, messages } = await createAttachedHandler();

    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 7 }, 'target_closed']);
    await vi.advanceTimersByTimeAsync(REATTACH_DELAY_MS);
    await flushMicrotasks();
    expect(attachCount(sendCommand)).toBe(2);

    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 7 }, 'target_closed']);
    expect(messages.at(-1)).toMatchObject({
      method: 'Target.detachedFromTarget',
      params: { sessionId: 'pw-tab-2' },
    });
    await vi.advanceTimersByTimeAsync(REATTACH_COOLDOWN_MS);
    await flushMicrotasks();
    expect(attachCount(sendCommand)).toBe(2);

    await handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: true }, undefined);
    expect(attachCount(sendCommand)).toBe(3);
    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 7 }, 'target_closed']);
    await vi.advanceTimersByTimeAsync(REATTACH_DELAY_MS);
    await flushMicrotasks();
    expect(attachCount(sendCommand)).toBe(4);
  });

  it('does not re-attach when the tab closes before the recovery delay elapses', async () => {
    const { handler, sendCommand, messages } = await createAttachedHandler();

    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 7 }, 'target_closed']);
    handler.handleExtensionEvent('chrome.tabs.onRemoved', [7, { windowId: 1, isWindowClosing: false }]);

    await vi.advanceTimersByTimeAsync(REATTACH_COOLDOWN_MS);
    await flushMicrotasks();
    expect(attachCount(sendCommand)).toBe(1);
    expect(messages.filter(message => message.method === 'Target.attachedToTarget')).toHaveLength(1);
  });

  it('cancels a pending recovery when auto-attach is disabled', async () => {
    const { handler, sendCommand } = await createAttachedHandler();

    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 7 }, 'target_closed']);
    await handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: false }, undefined);

    await vi.advanceTimersByTimeAsync(REATTACH_COOLDOWN_MS);
    await flushMicrotasks();
    expect(attachCount(sendCommand)).toBe(1);
  });

  it('cancels a pending recovery when the extension disconnects', async () => {
    const { handler, sendCommand } = await createAttachedHandler();

    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 7 }, 'target_closed']);
    handler.onExtensionDisconnect('extension websocket closed');

    await vi.advanceTimersByTimeAsync(REATTACH_COOLDOWN_MS);
    await flushMicrotasks();
    expect(attachCount(sendCommand)).toBe(1);
  });

  it('drops the session when the recovery attach fails for another reason', async () => {
    const { handler, sendCommand, messages } = await createAttachedHandler({
      attach: call => {
        if (call === 2)
          throw new Error('No tab with given id 7.');
      },
    });

    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 7 }, 'target_closed']);
    await vi.advanceTimersByTimeAsync(REATTACH_DELAY_MS);
    await flushMicrotasks();

    expect(attachCount(sendCommand)).toBe(2);
    expect(messages.filter(message => message.method === 'Target.attachedToTarget')).toHaveLength(1);
    await expect(handler.forwardToExtension('Runtime.evaluate', {}, 'pw-tab-1'))
        .rejects.toThrow('No tab found for sessionId: pw-tab-1');
  });
});

describe('cdp relay upgrade hardening', () => {
  async function startRelay() {
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const relay = new CDPRelayServer(server, 'chrome', undefined, '/tmp/chrome');
    onTestFinished(async () => {
      relay.stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP server address');
    return { relay, port: address.port };
  }

  // Attempts the WebSocket upgrade and resolves with whether it opened or the
  // HTTP status the relay answered the upgrade with when it rejected it.
  function attemptUpgrade(endpoint: string, headers: Record<string, string>) {
    return new Promise<{ opened: boolean, statusCode?: number }>((resolve, reject) => {
      const ws = new WebSocket(endpoint, { headers });
      ws.on('open', () => {
        ws.close();
        resolve({ opened: true });
      });
      ws.on('unexpected-response', (_req, res) => {
        ws.terminate();
        resolve({ opened: false, statusCode: res.statusCode });
      });
      ws.on('error', reject);
    });
  }

  it('rejects an upgrade with a non-loopback Host header', async () => {
    const { relay, port } = await startRelay();
    const result = await attemptUpgrade(relay.extensionEndpoint(), { host: `evil.example:${port}` });
    expect(result).toEqual({ opened: false, statusCode: 403 });
  });

  it('rejects an upgrade with a non-loopback Host even if the relay is reachable there', async () => {
    // The allowlist is loopback-only and never widens to the bind address, so a
    // relay reachable on a LAN/public interface still rejects that Host.
    const { relay, port } = await startRelay();
    const result = await attemptUpgrade(relay.extensionEndpoint(), { host: `192.168.1.10:${port}` });
    expect(result).toEqual({ opened: false, statusCode: 403 });
  });

  it('rejects an upgrade carrying a web-page Origin', async () => {
    const { relay, port } = await startRelay();
    const result = await attemptUpgrade(relay.extensionEndpoint(), {
      host: `127.0.0.1:${port}`,
      origin: 'https://evil.example',
    });
    expect(result).toEqual({ opened: false, statusCode: 403 });
  });

  it('accepts an upgrade from the extension chrome-extension:// Origin', async () => {
    const { relay } = await startRelay();
    const result = await attemptUpgrade(relay.extensionEndpoint(), {
      origin: `chrome-extension://${EXTENSION_ID}`,
    });
    expect(result).toEqual({ opened: true });
  });

  it('accepts an upgrade from the local Playwright client without an Origin', async () => {
    const { relay } = await startRelay();
    const result = await attemptUpgrade(relay.extensionEndpoint(), {});
    expect(result).toEqual({ opened: true });
  });
});
