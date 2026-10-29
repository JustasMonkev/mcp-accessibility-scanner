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

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { assertNetworkPolicySupported, ensureNetworkPolicyRoutes } from '../src/networkPolicy.js';
import { resolveConfig } from '../src/config.js';
import { createConnection } from '../src/index.js';
import type { FullConfig } from '../src/config.js';
import type { BrowserContext } from 'playwright';

function createMockContext() {
  const session = Object.assign(new EventEmitter(), {
    send: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
  });
  const browser = {
    browserType: () => ({ name: () => 'chromium' }),
    newBrowserCDPSession: vi.fn().mockResolvedValue(session),
  };
  const context = { browser: () => browser, routeWebSocket: vi.fn().mockResolvedValue(undefined) };
  return { context: context as unknown as BrowserContext, routeWebSocket: context.routeWebSocket, browser, session };
}

const restrictedConfig = { browser: { browserName: 'chromium' }, network: { allowedOrigins: ['*.example'], blockedOrigins: ['tracker.example'] } } as FullConfig;

describe('ensureNetworkPolicyRoutes', () => {
  it('touches nothing when no policy is configured', async () => {
    const { context, browser, routeWebSocket } = createMockContext();
    await ensureNetworkPolicyRoutes({ network: undefined } as FullConfig, context);
    expect(browser.newBrowserCDPSession).not.toHaveBeenCalled();
    expect(routeWebSocket).not.toHaveBeenCalled();
  });

  it('shares installation across simultaneous callers and contexts in the owned browser', async () => {
    const { context, browser, routeWebSocket, session } = createMockContext();
    const sibling = { browser: () => browser, routeWebSocket: vi.fn().mockResolvedValue(undefined) } as unknown as BrowserContext;
    await Promise.all([
      ensureNetworkPolicyRoutes(restrictedConfig, context),
      ensureNetworkPolicyRoutes(restrictedConfig, context),
      ensureNetworkPolicyRoutes(restrictedConfig, sibling),
    ]);
    expect(browser.newBrowserCDPSession).toHaveBeenCalledTimes(1);
    expect(routeWebSocket).toHaveBeenCalledTimes(1);
    expect(session.send).toHaveBeenCalledWith('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    for (const [url, allowed] of [['https://app.example/path', true], ['https://tracker.example/path', false], ['https://elsewhere.test/path', false]] as const) {
      session.emit('Fetch.requestPaused', { requestId: url, request: { url } });
      expect(session.send).toHaveBeenLastCalledWith(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
        requestId: url, ...(!allowed && { errorReason: 'BlockedByClient' }),
      });
    }
    expect(session.detach).not.toHaveBeenCalled();
  });

  it('detaches a failed browser installation and permits retry', async () => {
    const { context, browser, session, routeWebSocket } = createMockContext();
    session.send.mockRejectedValueOnce(new Error('Fetch setup failed'));
    await expect(ensureNetworkPolicyRoutes(restrictedConfig, context)).rejects.toThrow('Fetch setup failed');
    expect(session.detach).toHaveBeenCalledTimes(1);
    expect(routeWebSocket).not.toHaveBeenCalled();
    await ensureNetworkPolicyRoutes(restrictedConfig, context);
    expect(browser.newBrowserCDPSession).toHaveBeenCalledTimes(2);
    expect(routeWebSocket).toHaveBeenCalledTimes(1);
  });

  it('does not forward blocked sockets and forwards allowed sockets without message rewriting', async () => {
    const { context, routeWebSocket } = createMockContext();
    await ensureNetworkPolicyRoutes(restrictedConfig, context);
    const handler = routeWebSocket.mock.calls[0][1];
    for (const [url, allowed] of [['wss://app.example/socket', true], ['ws://tracker.example/socket', false]] as const) {
      const socket = { url: () => url, close: vi.fn().mockResolvedValue(undefined), connectToServer: vi.fn() };
      await handler(socket);
      expect(socket.connectToServer).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(socket.close).toHaveBeenCalledTimes(allowed ? 0 : 1);
    }
  });

  it.each(['firefox', 'webkit'] as const)('rejects restricted %s but preserves unrestricted use', async browserName => {
    await expect(resolveConfig({ browser: { browserName }, network: { blockedOrigins: ['example.com'] } })).rejects.toThrow('locally launched Chromium');
    await expect(resolveConfig({ browser: { browserName } })).resolves.toMatchObject({ browser: { browserName } });
  });

  it.each([
    { cdpEndpoint: 'http://localhost:9222' },
    { remoteEndpoint: 'ws://localhost:1234' },
    { cdpLaunch: { command: 'owned-fixture' } },
  ])('rejects configured external connections before acquisition: %j', async browser => {
    await expect(resolveConfig({ browser, network: { allowedOrigins: ['example.com'] } })).rejects.toThrow('locally launched Chromium');
  });

  it('rejects a custom context getter before invoking it and rejects external factory ownership', async () => {
    const getter = vi.fn();
    await expect(createConnection({ network: { blockedOrigins: ['example.com'] } }, getter)).rejects.toThrow('custom-context');
    expect(getter).not.toHaveBeenCalled();
    expect(() => assertNetworkPolicySupported(restrictedConfig, false)).toThrow('external browser');
  });
});
