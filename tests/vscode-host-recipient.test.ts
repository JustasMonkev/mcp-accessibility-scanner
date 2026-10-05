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

import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import type { Transport } from '@modelcontextprotocol/client';
import { resolveConfig } from '../src/config.js';
import { wrapInProcess } from '../src/mcp/server.js';
import type { ServerBackendContext } from '../src/mcp/server.js';
import { VSCodeProxyBackend } from '../src/vscode/host.js';

const stdio = vi.hoisted(() => {
  const state: { transport?: Transport } = {};
  return state;
});
// Child-process creation is outside this fixture; routing and recipient lifetime
// run through the production backend and real in-process MCP transports.
vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: vi.fn(function() {
    assert.ok(stdio.transport, 'the switched provider transport is prepared');
    return stdio.transport;
  }),
}));

describe('host-session discovery recipient survives provider generation changes', () => {
  it.each([
    { listDefault: false, duringReturn: false },
    { listDefault: true, duringReturn: false },
    { listDefault: false, duringReturn: true },
    { listDefault: true, duringReturn: true },
  ])('does not restore a host-session recipient after returning to default (new listing: $listDefault, during return: $duringReturn)', async ({ listDefault, duringReturn }) => {
    let notifications = 0;
    let defaults = 0;
    let holdSessionListing = false;
    const contexts: ServerBackendContext[] = [];
    let listingStarted!: () => void;
    const started = new Promise<void>(resolve => { listingStarted = resolve; });
    let releaseListing!: () => void;
    const released = new Promise<void>(resolve => { releaseListing = resolve; });
    let reconnectStarted!: () => void;
    const reconnecting = new Promise<void>(resolve => { reconnectStarted = resolve; });
    let releaseReconnect!: () => void;
    const reconnected = new Promise<void>(resolve => { releaseReconnect = resolve; });
    const backend = new VSCodeProxyBackend(await resolveConfig({}), async () => {
      const provider = defaults++;
      return wrapInProcess({
        initialize: async context => {
          contexts[provider] = context;
          if (provider === 2) {
            reconnectStarted();
            await reconnected;
          }
        },
        listTools: async () => {
          if (provider === 1 && holdSessionListing) {
            listingStarted();
            await released;
          }
          return [{ name: `host_${provider}`, inputSchema: { type: 'object' as const } }];
        },
        callTool: async () => ({ content: [] }),
      });
    });
    stdio.transport = await wrapInProcess({
      listTools: async () => [{ name: 'switched', inputSchema: { type: 'object' as const } }],
      callTool: async () => ({ content: [] }),
    });
    let pendingListing: Promise<unknown> | undefined;
    let switched: Promise<unknown> | undefined;
    try {
      await backend.initialize({ notifyToolListChanged: async () => { ++notifications; } }, { name: 'host-recipient-test', version: '1' });
      await backend.callTool('browser_connect', { connectionString: 'ws://127.0.0.1:1234/', lib: 'playwright' });
      const sessionContext = { _meta: { browserSessionId: 'bs_host' } };
      const sessionTools = await backend.listTools(sessionContext);
      assert.equal(sessionTools[0].name, 'host_1');
      if (duringReturn) {
        switched = backend.callTool('browser_connect', {});
        await reconnecting;
      }
      holdSessionListing = true;
      pendingListing = backend.listTools(sessionContext);
      await started;
      await contexts[1].notifyToolListChanged();
      if (!duringReturn) {
        switched = backend.callTool('browser_connect', {});
        await reconnecting;
      }
      releaseReconnect();
      await switched;
      if (listDefault) {
        const tools = await backend.listTools(sessionContext);
        assert.equal(tools[0].name, 'host_2', 'session traffic now uses the current default provider');
      }
      notifications = 0;
      releaseListing();
      await pendingListing;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(notifications, 0, 'the buffered obsolete host-session change is suppressed');
      await contexts[1].notifyToolListChanged();
      assert.equal(notifications, 0, 'the obsolete host-session client cannot publish catalog changes');
      await contexts[2].notifyToolListChanged();
      assert.equal(notifications, listDefault ? 1 : 0, 'only a listed current default provider can publish catalog changes');
    } finally {
      releaseListing();
      releaseReconnect();
      await pendingListing;
      await switched;
      backend.serverClosed();
      stdio.transport = undefined;
    }
  });

  it('publishes the first host-session recipient after a concurrent child-provider switch', async () => {
    let notifications = 0;
    let defaults = 0;
    let hostContext!: ServerBackendContext;
    let switchAfterResponse = false;
    let switched: Promise<unknown> | undefined;
    const connectDefault = async () => {
      const provider = defaults++;
      const inner = await wrapInProcess({
        initialize: async context => {
          if (provider === 1)
            hostContext = context;
        },
        listTools: async () => {
          if (provider === 1 && switchAfterResponse)
            await hostContext.notifyToolListChanged();
          return [{ name: `host_${provider}`, inputSchema: { type: 'object' as const } }];
        },
        callTool: async () => ({ content: [] }),
      });
      const transport: Transport = {
        start: async () => {
          inner.onmessage = (message, extra) => {
            transport.onmessage?.(message, extra);
            if (provider === 1 && switchAfterResponse && 'result' in message && 'tools' in message.result) {
              switchAfterResponse = false;
              switched = backend.callTool('browser_connect', { connectionString: 'ws://127.0.0.1:5678/', lib: 'playwright' });
            }
          };
          inner.onclose = () => transport.onclose?.();
          inner.onerror = error => transport.onerror?.(error);
          await inner.start();
        },
        send: (message, options) => inner.send(message, options),
        close: () => inner.close(),
      };
      return transport;
    };
    const backend = new VSCodeProxyBackend(await resolveConfig({}), connectDefault);
    stdio.transport = await wrapInProcess({
      listTools: async () => [{ name: 'switched', inputSchema: { type: 'object' as const } }],
      callTool: async () => ({ content: [] }),
    });
    try {
      await backend.initialize({ notifyToolListChanged: async () => { ++notifications; } }, { name: 'host-recipient-test', version: '1' });
      await backend.callTool('browser_connect', { connectionString: 'ws://127.0.0.1:1234/', lib: 'playwright' });
      await backend.listTools();
      stdio.transport = await wrapInProcess({
        listTools: async () => [{ name: 'next_switched', inputSchema: { type: 'object' as const } }],
        callTool: async () => ({ content: [] }),
      });
      notifications = 0;
      switchAfterResponse = true;
      const tools = await backend.listTools({ _meta: { browserSessionId: 'bs_host' } });
      assert.equal(tools[0].name, 'host_1');
      assert.ok(switched);
      await switched;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(notifications, 2, 'provider switch and buffered host-session change both arrive');
      await hostContext.notifyToolListChanged();
      assert.equal(notifications, 3, 'the host-session client remains the discovery recipient');
    } finally {
      await switched;
      backend.serverClosed();
      stdio.transport = undefined;
    }
  });
});
