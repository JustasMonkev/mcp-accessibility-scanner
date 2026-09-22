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
import { Client } from '@modelcontextprotocol/client';
import { describe, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { wrapInProcess } from '../src/mcp/server.js';
import type { ServerBackendContext } from '../src/mcp/server.js';
import { ProxyBackend } from '../src/mcp/proxyBackend.js';
import { VSCodeProxyBackend } from '../src/vscode/host.js';
import type { CallToolRequestContext } from '../src/mcp/server.js';

describe('WebMCP proxy routing', () => {
  it('forwards tools/list metadata instead of falling back to the default page', async () => {
    let received: unknown;
    // SAFETY: this fixture exercises only listTools with an injected downstream client.
    const backend = Object.assign(Object.create(ProxyBackend.prototype), {
      _currentClient: { listTools: async (params: unknown) => { received = params; return { tools: [] }; } },
      _mcpProviders: [{}], _pendingToolLists: new Set(),
    }) as ProxyBackend;
    await backend.listTools({ _meta: { browserSessionId: 'bs_a' } });
    assert.deepEqual(received, { _meta: { browserSessionId: 'bs_a' } });
  });

  it('forwards request cancellation, metadata and progress without rewriting page arguments', async () => {
    let params: unknown;
    let options: { signal?: AbortSignal, onprogress?: (value: { progress: number }) => void } | undefined;
    const notifications: unknown[] = [];
    // SAFETY: callTool only uses the injected downstream client and switch-tool name.
    const backend = Object.assign(Object.create(ProxyBackend.prototype), {
      _contextSwitchTool: { name: 'browser_connect' },
      _currentClient: { callTool: async (p: unknown, o: typeof options) => { params = p; options = o; return { content: [] }; } },
    }) as ProxyBackend;
    const controller = new AbortController();
    const request: CallToolRequestContext = { signal: controller.signal, requestId: 1,
      sendNotification: async value => { notifications.push(value); },
      _meta: { browserSessionId: 'bs_a', progressToken: 'progress' },
    };
    const input = { browserSessionId: 42, _meta: 'page argument' };
    await backend.callTool('webmcp_echo_identity', input, request);
    assert.deepEqual(params, { name: 'webmcp_echo_identity', arguments: input, _meta: request._meta });
    assert.equal(options?.signal, controller.signal);
    options?.onprogress?.({ progress: 1 });
    assert.deepEqual(notifications, [{ method: 'notifications/progress', params: { progressToken: 'progress', progress: 1 } }]);
  });
});

function vscodeHarness() {
  const calls: { destination: string, params: unknown, options?: unknown }[] = [];
  const client = (destination: string) => ({
    listTools: async (params: unknown) => { calls.push({ destination, params }); return { tools: [] }; },
    callTool: async (params: unknown, options?: unknown) => { calls.push({ destination, params, options }); return { content: [] }; },
  });
  // SAFETY: list/call methods need only these injected current and host clients.
  const backend = Object.assign(Object.create(VSCodeProxyBackend.prototype), {
    _currentClient: client('switched'), _currentClientIsDefault: false,
    _sessionClient: Promise.resolve(client('host')), _pendingToolLists: new Set(), _contextSwitchTool: { name: 'browser_connect' },
  }) as VSCodeProxyBackend;
  return { backend, calls };
}

describe('WebMCP VS Code host routing', () => {
  it('lists explicit-session tools at the host even after switching providers', async () => {
    const { backend, calls } = vscodeHarness();
    await backend.listTools({ _meta: { browserSessionId: 'bs_host' } });
    assert.deepEqual(calls, [{ destination: 'host', params: { _meta: { browserSessionId: 'bs_host' } } }]);
  });

  it('keeps page-owned browserSessionId arguments on the switched provider', async () => {
    const { backend, calls } = vscodeHarness();
    await backend.callTool('webmcp_page_tool', { browserSessionId: 'page input', _meta: 'page metadata' });
    assert.equal(calls[0].destination, 'switched');
    assert.deepEqual(calls[0].params, { name: 'webmcp_page_tool', arguments: { browserSessionId: 'page input', _meta: 'page metadata' }, _meta: undefined });
  });

  it('routes dynamic calls by metadata and preserves cancellation and original arguments', async () => {
    const { backend, calls } = vscodeHarness();
    const signal = new AbortController().signal;
    const request: CallToolRequestContext = { signal, requestId: 1, sendNotification: async () => {}, _meta: { browserSessionId: 'bs_host' } };
    await backend.callTool('webmcp_page_tool', { browserSessionId: 42 }, request);
    assert.deepEqual(calls, [{ destination: 'host', params: { name: 'webmcp_page_tool', arguments: { browserSessionId: 42 }, _meta: request._meta }, options: { signal } }]);
  });
});

describe('WebMCP VS Code progress forwarding', () => {
  it('forwards progress for switched and host-routed calls without changing cancellation or page input', async () => {
    for (const sessionId of [undefined, 'bs_host']) {
      const { backend, calls } = vscodeHarness();
      const notifications: unknown[] = [];
      const signal = new AbortController().signal;
      const request: CallToolRequestContext = {
        signal, requestId: 1,
        sendNotification: async value => { notifications.push(value); },
        _meta: { ...(sessionId ? { browserSessionId: sessionId } : {}), progressToken: 0 },
      };
      const args = { browserSessionId: 'page-owned value', _meta: 'page-owned metadata' };
      await backend.callTool('webmcp_page_tool', args, request);
      assert.equal(calls[0].destination, sessionId ? 'host' : 'switched');
      assert.deepEqual(calls[0].params, { name: 'webmcp_page_tool', arguments: args, _meta: request._meta });
      // SAFETY: the injected client's options are the production callTool options captured by the fixture.
      const options = calls[0].options as { signal: AbortSignal, onprogress: (value: { progress: number; total?: number; message?: string }) => void };
      assert.equal(options.signal, signal);
      options.onprogress({ progress: 2, total: 3, message: 'Preparing audit' });
      await Promise.resolve();
      assert.deepEqual(notifications, [{ method: 'notifications/progress', params: { progressToken: 0, progress: 2, total: 3, message: 'Preparing audit' } }]);
    }
  });
});

describe('WebMCP VS Code notification races', () => {
  it('preserves notifications during the first and switched-client tool listing', async () => {
    let notifications = 0;
    const innerContexts: ServerBackendContext[] = [];
    let duringList: (() => Promise<void>) | undefined;
    const backend = new VSCodeProxyBackend(await resolveConfig({}), async () => wrapInProcess({
      initialize: async context => { innerContexts.push(context); },
      listTools: async () => {
        await duringList?.();
        return [];
      },
      callTool: async () => ({ content: [] }),
    }));
    try {
      await backend.initialize({ notifyToolListChanged: async () => { ++notifications; } }, { name: 'test', version: '1' });
      notifications = 0;
      duringList = () => innerContexts[0].notifyToolListChanged();
      await backend.listTools();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.ok(notifications > 0, 'the first listing must retain an in-flight notification');
      // Select the host-owned session client, as happens after a provider switch.
      Object.assign(backend, { _currentClientIsDefault: false });
      notifications = 0;
      duringList = () => innerContexts[1].notifyToolListChanged();
      await backend.listTools({ _meta: { browserSessionId: 'bs_host' } });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.ok(notifications > 0, 'the newly selected client must retain an in-flight notification');
      duringList = async () => { throw new Error('listing failed'); };
      await assert.rejects(backend.listTools(), /listing failed/);
      notifications = 0;
      await innerContexts[1].notifyToolListChanged();
      assert.equal(notifications, 1, 'failed listing must preserve the previous notification recipient');
    } finally {
      backend.serverClosed();
    }
  });
});

describe('WebMCP proxy notification ordering', () => {
  for (const kind of ['direct', 'VS Code']) {
    for (const outcome of ['response', 'error', 'closed']) {
      it(`${kind}: delivers an in-flight catalog change after the outer list ${outcome}`, async () => {
        let innerContext: ServerBackendContext;
        let duringList: (() => Promise<void>) | undefined;
        let toolName = 'old_tool';
        const connect = async () => wrapInProcess({
          initialize: async context => { innerContext = context; },
          listTools: async () => {
            const tools = [{ name: toolName, inputSchema: { type: 'object' as const } }];
            await duringList?.();
            return tools;
          },
          callTool: async () => ({ content: [] }),
        });
        const backend = kind === 'direct'
          ? new ProxyBackend([{ name: 'default', description: 'Default', connect }])
          : new VSCodeProxyBackend(await resolveConfig({}), connect);
        const client = new Client({ name: 'catalog-ordering-test', version: '1' });
        client.setRequestHandler('ping', () => ({}));
        try {
          await client.connect(await wrapInProcess(backend));
          await client.listTools();
          const events: string[] = [];
          client.setNotificationHandler('notifications/tools/list_changed', () => { events.push('list changed'); });
          duringList = async () => {
            // The list was captured before registration changed. A refresh
            // must follow its response or that stale list wins in the client.
            toolName = 'new_tool';
            await innerContext.notifyToolListChanged();
            await innerContext.notifyToolListChanged();
            if (outcome === 'error')
              throw new Error('listing failed');
          };
          if (outcome === 'error') {
            await assert.rejects(client.listTools(), /listing failed/);
            events.push('list error');
          } else {
            const result = await client.listTools();
            assert.equal(result.tools[0].name, 'old_tool');
            events.push('list response');
          }
          duringList = undefined;
          if (outcome === 'closed')
            await client.close();
          // Flush the deferred notification, including transport microtasks.
          await new Promise<void>(resolve => setImmediate(resolve));
          assert.deepEqual(events, outcome === 'closed' ? ['list response'] : [`list ${outcome}`, 'list changed']);
          if (outcome !== 'closed')
            assert.equal((await client.listTools()).tools[0].name, 'new_tool');
        } finally {
          await client.close();
        }
      });
    }
  }
});
