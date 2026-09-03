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

  it('re-attaches the tab when the extension recovers from an involuntary detach', async () => {
    const tab = { id: 7, index: 0, windowId: 1, url: 'https://example.com', active: true, pinned: false };
    const sendCommand = vi.fn(async (method: string, params: any[]) => {
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo')
        return { targetInfo: { targetId: 'target-7', type: 'page', url: tab.url } };
      return {};
    });
    const messages: CDPMessage[] = [];
    const handler = new ExtensionProtocolV2(sendCommand);
    handler.connectOverCDP(message => messages.push(message));
    handler.handleExtensionEvent('chrome.tabs.onCreated', [tab]);
    await handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: true }, undefined);

    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 7 }, 'target_closed']);
    expect(messages.at(-1)).toMatchObject({
      method: 'Target.detachedFromTarget',
      params: { sessionId: 'pw-tab-1', targetId: 'target-7' },
    });
    await expect(handler.forwardToExtension('Page.enable', undefined, 'pw-tab-1'))
        .rejects.toThrow('No tab found for sessionId: pw-tab-1');

    // The extension re-attaches an involuntarily detached tab by replaying
    // chrome.tabs.onCreated for it, so recovery runs through the normal
    // auto-attach path rather than anything keyed off the detach reason.
    handler.handleExtensionEvent('chrome.tabs.onCreated', [tab]);
    await vi.waitFor(() => expect(messages.at(-1)).toMatchObject({
      method: 'Target.attachedToTarget',
      params: { sessionId: 'pw-tab-2', targetInfo: { targetId: 'target-7', attached: true } },
    }));
    expect(sendCommand.mock.calls.filter(([method]) => method === 'chrome.debugger.attach')).toEqual([
      ['chrome.debugger.attach', [{ tabId: 7 }, '1.3']],
      ['chrome.debugger.attach', [{ tabId: 7 }, '1.3']],
    ]);
    await handler.forwardToExtension('Page.enable', undefined, 'pw-tab-2');
    expect(sendCommand).toHaveBeenLastCalledWith('chrome.debugger.sendCommand', [
      { tabId: 7, sessionId: undefined },
      'Page.enable',
    ]);
  });

  it('discards an attach that a detach cancelled while it was in flight', async () => {
    const tab = { id: 7, index: 0, windowId: 1, url: 'https://example.com', active: true, pinned: false };
    let resolveTargetInfo!: () => void;
    const targetInfo = new Promise<void>(resolve => resolveTargetInfo = resolve);
    const sendCommand = vi.fn(async (method: string, params: any[]) => {
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') {
        await targetInfo;
        return { targetInfo: { targetId: 'target-7', type: 'page', url: tab.url } };
      }
      return {};
    });
    const messages: CDPMessage[] = [];
    const handler = new ExtensionProtocolV2(sendCommand);
    handler.connectOverCDP(message => messages.push(message));
    handler.handleExtensionEvent('chrome.tabs.onCreated', [tab]);
    const autoAttach = handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: true }, undefined);
    await vi.waitFor(() => expect(sendCommand).toHaveBeenLastCalledWith('chrome.debugger.sendCommand', [
      { tabId: 7 },
      'Target.getTargetInfo',
    ]));

    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 7 }, 'target_closed']);
    resolveTargetInfo();
    // Playwright awaits this command while connecting, and the factory stops
    // the relay if the connection fails, so a cancelled attach must not fail
    // it — the tab is simply unattached until the extension replays it.
    await expect(autoAttach).resolves.toEqual({ result: {} });
    expect(messages).toEqual([]);

    handler.handleExtensionEvent('chrome.tabs.onCreated', [tab]);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({
      method: 'Target.attachedToTarget',
      params: { sessionId: 'pw-tab-1', targetInfo: { targetId: 'target-7', attached: true } },
    });
    // The abandoned attempt's successful attach was undone, so nothing was
    // left attached with no session behind it.
    expect(sendCommand.mock.calls.filter(([method]) => method === 'chrome.debugger.detach').length).toBeGreaterThanOrEqual(1);
  });

  it('treats a debugger call that fails after a detach as a cancelled attach', async () => {
    const tab = { id: 7, index: 0, windowId: 1, url: 'https://example.com', active: true, pinned: false };
    let rejectTargetInfo!: (error: Error) => void;
    const targetInfo = new Promise<never>((_, reject) => rejectTargetInfo = reject);
    let targetInfoCalls = 0;
    const sendCommand = vi.fn(async (method: string, params: any[]) => {
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') {
        if (++targetInfoCalls === 1)
          return await targetInfo;
        return { targetInfo: { targetId: 'target-7', type: 'page', url: tab.url } };
      }
      return {};
    });
    const messages: CDPMessage[] = [];
    const handler = new ExtensionProtocolV2(sendCommand);
    handler.connectOverCDP(message => messages.push(message));
    handler.handleExtensionEvent('chrome.tabs.onCreated', [tab]);
    const autoAttach = handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: true }, undefined);
    await vi.waitFor(() => expect(sendCommand).toHaveBeenLastCalledWith('chrome.debugger.sendCommand', [
      { tabId: 7 },
      'Target.getTargetInfo',
    ]));

    // Chrome tears the debuggee down before answering, so the in-flight command
    // fails rather than replying late. That is still the detach, not a failure
    // to attach, and it must not take the connection down with it.
    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 7 }, 'target_closed']);
    rejectTargetInfo(new Error('Debugger is not attached to the tab with id: 7'));
    await expect(autoAttach).resolves.toEqual({ result: {} });
    expect(messages).toEqual([]);

    handler.handleExtensionEvent('chrome.tabs.onCreated', [tab]);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({ method: 'Target.attachedToTarget', params: { sessionId: 'pw-tab-1' } });
  });

  it('keeps the first failure as the cause when the auto-attach retry also fails', async () => {
    let chromeAttached = false;
    let targetInfoCalls = 0;
    const sendCommand = vi.fn(async (method: string, params: any[]) => {
      if (method === 'chrome.debugger.attach') {
        if (chromeAttached)
          throw new Error('Another debugger is already attached');
        chromeAttached = true;
        return {};
      }
      if (method === 'chrome.debugger.detach') {
        if (!chromeAttached)
          throw new Error('Debugger is not attached to the tab with id: 7');
        chromeAttached = false;
        return {};
      }
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo')
        throw new Error(`Target.getTargetInfo timed out (call ${++targetInfoCalls})`);
      return {};
    });
    const handler = new ExtensionProtocolV2(sendCommand);
    handler.handleExtensionEvent('chrome.tabs.onCreated', [
      { id: 7, index: 0, windowId: 1, active: true, pinned: false },
    ]);

    // Both failures are the command's own — the debugger stays attached until
    // the undo detaches it, which is what lets the retry attach at all.
    const failure = await handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: true }, undefined)
        .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    // SAFETY: asserted to be an Error on the line above.
    const error = failure as Error;
    // The relay forwards only Error.message, so both failures have to be in it
    // for Playwright to see why the attach started failing.
    expect(error.message).toContain('Target.getTargetInfo timed out (call 2)');
    expect(error.message).toContain('Target.getTargetInfo timed out (call 1)');
    expect(`${error.cause}`).toContain('Target.getTargetInfo timed out (call 1)');
    expect(sendCommand.mock.calls.filter(([method]) => method === 'chrome.debugger.attach')).toHaveLength(2);
    expect(sendCommand.mock.calls.filter(([method]) => method === 'chrome.debugger.detach')).toHaveLength(2);
  });

  it('does not owe a detach that was consumed during the undo round trip', async () => {
    const tab = { id: 7, index: 0, windowId: 1, url: 'https://example.com', active: true, pinned: false };
    let chromeAttached = false;
    let releaseUndo!: () => void;
    const undoGate = new Promise<void>(resolve => releaseUndo = resolve);
    let detachCalls = 0;
    let targetInfoCalls = 0;
    const sendCommand = vi.fn(async (method: string, params: any[]) => {
      if (method === 'chrome.debugger.attach') {
        if (chromeAttached)
          throw new Error('Another debugger is already attached');
        chromeAttached = true;
        return {};
      }
      if (method === 'chrome.debugger.detach') {
        if (++detachCalls === 1)
          await undoGate;
        if (!chromeAttached)
          throw new Error('Debugger is not attached to the tab with id: 7');
        chromeAttached = false;
        return {};
      }
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') {
        if (++targetInfoCalls === 1) {
          chromeAttached = false;
          throw new Error('Detached while handling command.');
        }
        return { targetInfo: { targetId: 'target-7', type: 'page', url: tab.url } };
      }
      return {};
    });
    const messages: CDPMessage[] = [];
    const handler = new ExtensionProtocolV2(sendCommand);
    handler.connectOverCDP(message => messages.push(message));
    handler.handleExtensionEvent('chrome.tabs.onCreated', [tab]);
    const autoAttach = handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: true }, undefined);
    await vi.waitFor(() => expect(detachCalls).toBe(1));

    // The extension emitted the onDetach before the undo could reach it, so
    // the event lands during the undo's round trip: it is consumed as real
    // and cancels the attempt, and the undo's failure must not owe it again.
    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 7 }, 'target_closed']);
    releaseUndo();
    await expect(autoAttach).resolves.toEqual({ result: {} });

    handler.handleExtensionEvent('chrome.tabs.onCreated', [tab]);
    await vi.waitFor(() => expect(messages).toMatchObject([
      { method: 'Target.attachedToTarget', params: { sessionId: 'pw-tab-1' } },
    ]));

    // No owed count leaked: the next genuine detach still tears down.
    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 7 }, 'target_closed']);
    expect(messages.at(-1)).toMatchObject({
      method: 'Target.detachedFromTarget',
      params: { sessionId: 'pw-tab-1', targetId: 'target-7' },
    });
  });

  it('treats the tab closing during the undo as a cancellation, not a failure', async () => {
    const tab = { id: 7, index: 0, windowId: 1, url: 'https://example.com', active: true, pinned: false };
    let chromeAttached = false;
    let releaseUndo!: () => void;
    const undoGate = new Promise<void>(resolve => releaseUndo = resolve);
    const sendCommand = vi.fn(async (method: string, params: any[]) => {
      if (method === 'chrome.debugger.attach') {
        if (chromeAttached)
          throw new Error('Another debugger is already attached');
        chromeAttached = true;
        return {};
      }
      if (method === 'chrome.debugger.detach') {
        await undoGate;
        if (!chromeAttached)
          throw new Error('Debugger is not attached to the tab with id: 7');
        chromeAttached = false;
        return {};
      }
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo')
        throw new Error('Target.getTargetInfo timed out');
      return {};
    });
    const handler = new ExtensionProtocolV2(sendCommand);
    handler.handleExtensionEvent('chrome.tabs.onCreated', [tab]);
    const autoAttach = handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: true }, undefined);
    await vi.waitFor(() => expect(sendCommand.mock.calls.some(([method]) => method === 'chrome.debugger.detach')).toBe(true));

    // The tab closes while the genuine failure's undo is in flight. Retrying
    // the raw failure would attach a tab that no longer exists.
    handler.handleExtensionEvent('chrome.tabs.onRemoved', [7, { windowId: 1, isWindowClosing: false }]);
    releaseUndo();
    await expect(autoAttach).resolves.toEqual({ result: {} });
    expect(sendCommand.mock.calls.filter(([method]) => method === 'chrome.debugger.attach')).toHaveLength(1);
  });

  it('retries an attachment that a detach cancelled while creating a target', async () => {
    let targetInfoCalls = 0;
    let releaseFirstTargetInfo!: () => void;
    const firstTargetInfo = new Promise<void>(resolve => releaseFirstTargetInfo = resolve);
    const sendCommand = vi.fn(async (method: string, params: any[]) => {
      if (method === 'chrome.tabs.create')
        return { id: 8, index: 0, windowId: 1, url: params[0].url, active: true, pinned: false };
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') {
        if (++targetInfoCalls === 1)
          await firstTargetInfo;
        return { targetInfo: { targetId: 'target-8', type: 'page' } };
      }
      return {};
    });
    const handler = new ExtensionProtocolV2(sendCommand);
    handler.connectOverCDP(() => {});

    const created = handler.handleCDPCommand('Target.createTarget', { url: 'https://example.com' }, undefined);
    await vi.waitFor(() => expect(targetInfoCalls).toBe(1));
    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 8 }, 'target_closed']);
    releaseFirstTargetInfo();

    await expect(created).resolves.toEqual({ result: { targetId: 'target-8' } });
    expect(sendCommand.mock.calls.filter(([method]) => method === 'chrome.debugger.attach')).toEqual([
      ['chrome.debugger.attach', [{ tabId: 8 }, '1.3']],
      ['chrome.debugger.attach', [{ tabId: 8 }, '1.3']],
    ]);
  });

  it('retries a cancelled createTarget attachment once and surfaces why the retry failed', async () => {
    let targetInfoCalls = 0;
    let releaseFirstTargetInfo!: () => void;
    const firstTargetInfo = new Promise<void>(resolve => releaseFirstTargetInfo = resolve);
    const sendCommand = vi.fn(async (method: string, params: any[]) => {
      if (method === 'chrome.tabs.create')
        return { id: 8, index: 0, windowId: 1, url: params[0].url, active: true, pinned: false };
      if (method === 'chrome.debugger.attach' && targetInfoCalls > 0)
        throw new Error('No tab with given id: 8');
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') {
        if (++targetInfoCalls === 1)
          await firstTargetInfo;
        return { targetInfo: { targetId: 'target-8', type: 'page' } };
      }
      return {};
    });
    const handler = new ExtensionProtocolV2(sendCommand);

    const created = handler.handleCDPCommand('Target.createTarget', { url: 'https://example.com' }, undefined);
    await vi.waitFor(() => expect(targetInfoCalls).toBe(1));
    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 8 }, 'target_closed']);
    releaseFirstTargetInfo();

    await expect(created).rejects.toThrow('No tab with given id: 8');
    expect(sendCommand.mock.calls.filter(([method]) => method === 'chrome.debugger.attach')).toHaveLength(2);
  });

  it('ignores the stale detach of an attachment the retry replaced', async () => {
    const tab = { id: 7, index: 0, windowId: 1, url: 'https://example.com', active: true, pinned: false };
    let chromeAttached = false;
    let targetInfoCalls = 0;
    const sendCommand = vi.fn(async (method: string, params: any[]) => {
      if (method === 'chrome.debugger.attach') {
        if (chromeAttached)
          throw new Error('Another debugger is already attached');
        chromeAttached = true;
        return {};
      }
      if (method === 'chrome.debugger.detach') {
        if (!chromeAttached)
          throw new Error('Debugger is not attached to the tab with id: 7');
        chromeAttached = false;
        return {};
      }
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') {
        if (++targetInfoCalls === 1) {
          // Chrome force-detaches and answers the in-flight command with the
          // failure before delivering the onDetach event.
          chromeAttached = false;
          throw new Error('Detached while handling command.');
        }
        return { targetInfo: { targetId: 'target-7', type: 'page', url: tab.url } };
      }
      return {};
    });
    const messages: CDPMessage[] = [];
    const handler = new ExtensionProtocolV2(sendCommand);
    handler.connectOverCDP(message => messages.push(message));
    handler.handleExtensionEvent('chrome.tabs.onCreated', [tab]);
    await handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: true }, undefined);
    expect(messages).toMatchObject([{ method: 'Target.attachedToTarget', params: { sessionId: 'pw-tab-1' } }]);

    // The detach behind the first failure is delivered only now, after the
    // retry attached: it ends the replaced attachment, not the live one.
    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 7 }, 'target_closed']);
    expect(messages.filter(message => message.method === 'Target.detachedFromTarget')).toHaveLength(0);
    await handler.forwardToExtension('Page.enable', undefined, 'pw-tab-1');
    expect(sendCommand).toHaveBeenLastCalledWith('chrome.debugger.sendCommand', [
      { tabId: 7, sessionId: undefined },
      'Page.enable',
    ]);

    // Only one stale event is owed; the next detach ends the live attachment.
    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 7 }, 'target_closed']);
    expect(messages.at(-1)).toMatchObject({
      method: 'Target.detachedFromTarget',
      params: { sessionId: 'pw-tab-1', targetId: 'target-7' },
    });
  });

  it('does not let a stale attempt detach the replacement that took the tab over', async () => {
    const tab = { id: 7, index: 0, windowId: 1, url: 'https://example.com', active: true, pinned: false };
    let chromeAttached = false;
    let releaseFirstTargetInfo!: (error: Error) => void;
    const firstTargetInfo = new Promise<never>((_, reject) => releaseFirstTargetInfo = reject);
    let targetInfoCalls = 0;
    const sendCommand = vi.fn(async (method: string, params: any[]) => {
      if (method === 'chrome.debugger.attach') {
        if (chromeAttached)
          throw new Error('Another debugger is already attached');
        chromeAttached = true;
        return {};
      }
      if (method === 'chrome.debugger.detach') {
        if (!chromeAttached)
          throw new Error('Debugger is not attached to the tab with id: 7');
        chromeAttached = false;
        return {};
      }
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') {
        if (++targetInfoCalls === 1)
          return await firstTargetInfo;
        return { targetInfo: { targetId: 'target-7', type: 'page', url: tab.url } };
      }
      return {};
    });
    const messages: CDPMessage[] = [];
    const handler = new ExtensionProtocolV2(sendCommand);
    handler.connectOverCDP(message => messages.push(message));
    handler.handleExtensionEvent('chrome.tabs.onCreated', [tab]);
    const autoAttach = handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: true }, undefined);
    await vi.waitFor(() => expect(targetInfoCalls).toBe(1));

    // Chrome force-detaches; the event cancels the first attempt while its
    // Target.getTargetInfo response is still outstanding, and the extension's
    // replay attaches a replacement that installs a session.
    chromeAttached = false;
    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 7 }, 'target_closed']);
    handler.handleExtensionEvent('chrome.tabs.onCreated', [tab]);
    await vi.waitFor(() => expect(messages).toMatchObject([
      { method: 'Target.attachedToTarget', params: { sessionId: 'pw-tab-1' } },
    ]));

    // The first attempt's reply settles only now. Its undo names the tab, not
    // the attempt, so issuing it would end the replacement's attachment.
    releaseFirstTargetInfo(new Error('Detached while handling command.'));
    await expect(autoAttach).resolves.toEqual({ result: {} });
    expect(sendCommand.mock.calls.filter(([method]) => method === 'chrome.debugger.detach')).toHaveLength(0);
    expect(messages.filter(message => message.method === 'Target.detachedFromTarget')).toHaveLength(0);
    await handler.forwardToExtension('Page.enable', undefined, 'pw-tab-1');
    expect(sendCommand).toHaveBeenLastCalledWith('chrome.debugger.sendCommand', [
      { tabId: 7, sessionId: undefined },
      'Page.enable',
    ]);
  });

  it('consumes the owed detach while the retry is still attaching', async () => {
    const tab = { id: 7, index: 0, windowId: 1, url: 'https://example.com', active: true, pinned: false };
    let chromeAttached = false;
    let attachCalls = 0;
    let releaseSecondAttach!: () => void;
    const secondAttach = new Promise<void>(resolve => releaseSecondAttach = resolve);
    let targetInfoCalls = 0;
    const sendCommand = vi.fn(async (method: string, params: any[]) => {
      if (method === 'chrome.debugger.attach') {
        if (++attachCalls === 2)
          await secondAttach;
        if (chromeAttached)
          throw new Error('Another debugger is already attached');
        chromeAttached = true;
        return {};
      }
      if (method === 'chrome.debugger.detach') {
        if (!chromeAttached)
          throw new Error('Debugger is not attached to the tab with id: 7');
        chromeAttached = false;
        return {};
      }
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') {
        if (++targetInfoCalls === 1) {
          chromeAttached = false;
          throw new Error('Detached while handling command.');
        }
        return { targetInfo: { targetId: 'target-7', type: 'page', url: tab.url } };
      }
      return {};
    });
    const messages: CDPMessage[] = [];
    const handler = new ExtensionProtocolV2(sendCommand);
    handler.connectOverCDP(message => messages.push(message));
    handler.handleExtensionEvent('chrome.tabs.onCreated', [tab]);
    const autoAttach = handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: true }, undefined);
    await vi.waitFor(() => expect(attachCalls).toBe(2));

    // The owed event lands while the retry's own attach is in flight. It ends
    // the attachment the failed undo already proved gone, so it must not
    // cancel the retry, which goes on to install the session.
    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 7 }, 'target_closed']);
    releaseSecondAttach();
    await expect(autoAttach).resolves.toEqual({ result: {} });
    expect(messages).toMatchObject([{ method: 'Target.attachedToTarget', params: { sessionId: 'pw-tab-1' } }]);
    expect(sendCommand.mock.calls.filter(([method]) => method === 'chrome.debugger.detach')).toHaveLength(1);
  });

  it('holds Target.setAutoAttach(false) until an abandoned undo settles', async () => {
    const tab = { id: 7, index: 0, windowId: 1, url: 'https://example.com', active: true, pinned: false };
    let releaseFirstTargetInfo!: () => void;
    const firstTargetInfo = new Promise<void>(resolve => releaseFirstTargetInfo = resolve);
    let releaseUndo!: () => void;
    const undoGate = new Promise<void>(resolve => releaseUndo = resolve);
    let targetInfoCalls = 0;
    const sendCommand = vi.fn(async (method: string, params: any[]) => {
      if (method === 'chrome.debugger.detach') {
        await undoGate;
        return {};
      }
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') {
        if (++targetInfoCalls === 1)
          await firstTargetInfo;
        return { targetInfo: { targetId: 'target-7', type: 'page', url: tab.url } };
      }
      return {};
    });
    const handler = new ExtensionProtocolV2(sendCommand);
    handler.connectOverCDP(() => {});
    handler.handleExtensionEvent('chrome.tabs.onCreated', [tab]);
    const autoAttach = handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: true }, undefined);
    await vi.waitFor(() => expect(targetInfoCalls).toBe(1));

    // Cancel the attempt, then let its reply settle: the abandoned attempt
    // fires an undo detach that is still in flight when disable is queued.
    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 7 }, 'target_closed']);
    releaseFirstTargetInfo();
    await expect(autoAttach).resolves.toEqual({ result: {} });

    const disabling = handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: false }, undefined);
    let disabled = false;
    void disabling.then(() => disabled = true);
    await new Promise(resolve => setImmediate(resolve));
    // Disable's contract is that nothing is in flight when it resolves, and
    // the undo is in flight.
    expect(disabled).toBe(false);

    releaseUndo();
    await expect(disabling).resolves.toEqual({ result: {} });
  });

  it('holds Target.setAutoAttach(false) until a replacement attachment is torn down', async () => {
    let rejectFirstTargetInfo!: (error: Error) => void;
    const firstTargetInfo = new Promise<never>((_, reject) => rejectFirstTargetInfo = reject);
    let targetInfoCalls = 0;
    const sendCommand = vi.fn(async (method: string, params: any[]) => {
      if (method === 'chrome.tabs.create')
        return { id: 8, index: 0, windowId: 1, url: params[0].url, active: true, pinned: false };
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') {
        if (++targetInfoCalls === 1)
          return await firstTargetInfo;
        return { targetInfo: { targetId: 'target-8', type: 'page' } };
      }
      return {};
    });
    const messages: CDPMessage[] = [];
    const handler = new ExtensionProtocolV2(sendCommand);
    handler.connectOverCDP(message => messages.push(message));

    const created = handler.handleCDPCommand('Target.createTarget', { url: 'https://example.com' }, undefined);
    await vi.waitFor(() => expect(targetInfoCalls).toBe(1));
    const disabling = handler.handleCDPCommand('Target.setAutoAttach', { autoAttach: false }, undefined);

    // Cancel the original attempt while the disable barrier waits on it; the
    // retry replacing it registers only once the original settles, which is
    // exactly when a one-shot snapshot would have stopped waiting.
    handler.handleExtensionEvent('chrome.debugger.onDetach', [{ tabId: 8 }, 'target_closed']);
    rejectFirstTargetInfo(new Error('Detached while handling command.'));

    await expect(created).resolves.toEqual({ result: { targetId: 'target-8' } });
    await expect(disabling).resolves.toEqual({ result: {} });
    expect(messages).toMatchObject([
      { method: 'Target.attachedToTarget', params: { sessionId: 'pw-tab-1' } },
      { method: 'Target.detachedFromTarget', params: { sessionId: 'pw-tab-1' } },
    ]);
  });

  it('retries a createTarget attachment that failed for its own reason and keeps the cause', async () => {
    let chromeAttached = false;
    let targetInfoCalls = 0;
    const sendCommand = vi.fn(async (method: string, params: any[]) => {
      if (method === 'chrome.tabs.create')
        return { id: 8, index: 0, windowId: 1, url: params[0].url, active: true, pinned: false };
      if (method === 'chrome.debugger.attach') {
        if (chromeAttached)
          throw new Error('Another debugger is already attached');
        chromeAttached = true;
        return {};
      }
      if (method === 'chrome.debugger.detach') {
        if (!chromeAttached)
          throw new Error('Debugger is not attached to the tab with id: 8');
        chromeAttached = false;
        return {};
      }
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo')
        throw new Error(`Target.getTargetInfo timed out (call ${++targetInfoCalls})`);
      return {};
    });
    const handler = new ExtensionProtocolV2(sendCommand);

    const failure = await handler.handleCDPCommand('Target.createTarget', { url: 'https://example.com' }, undefined)
        .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    // SAFETY: asserted to be an Error on the line above.
    const error = failure as Error;
    expect(error.message).toContain('Target.getTargetInfo timed out (call 2)');
    expect(error.message).toContain('Target.getTargetInfo timed out (call 1)');
    expect(`${error.cause}`).toContain('Target.getTargetInfo timed out (call 1)');
    expect(sendCommand.mock.calls.filter(([method]) => method === 'chrome.debugger.attach')).toHaveLength(2);
    expect(sendCommand.mock.calls.filter(([method]) => method === 'chrome.debugger.detach')).toHaveLength(2);
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

  it('requires the configured token on the CDP endpoint upgrade', async () => {
    vi.stubEnv('PLAYWRIGHT_MCP_EXTENSION_TOKEN', 'test-token');
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const relay = new CDPRelayServer(server, 'chrome', undefined, '/tmp/chrome');
    const cdpEndpoint = relay.cdpEndpoint();
    const cdpPath = cdpEndpoint.slice(0, cdpEndpoint.indexOf('?token='));
    expect(new URL(cdpEndpoint).searchParams.get('token')).toBe('test-token');

    const expectRejected = (url: string) => new Promise<void>(resolve => {
      const socket = new WebSocket(url);
      socket.once('unexpected-response', () => resolve());
      socket.once('error', () => resolve());
      socket.once('open', () => {
        socket.close();
        throw new Error(`Expected the upgrade to ${url} to be rejected`);
      });
    });
    try {
      await expectRejected(cdpPath);
      await expectRejected(`${cdpPath}?token=wrong`);
      const authorized = new WebSocket(cdpEndpoint);
      // The upgrade itself proves the token gate; the relay may already be
      // closing this connection ("extension not connected") by the time the
      // open event is observed, so readyState must not be asserted here.
      await once(authorized, 'open');
      authorized.close();
      await once(authorized, 'close');
    } finally {
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
