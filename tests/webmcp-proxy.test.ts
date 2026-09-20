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
import { describe, it } from 'vitest';
import { ProxyBackend } from '../src/mcp/proxyBackend.js';
import { VSCodeProxyBackend } from '../src/vscode/host.js';
import type { CallToolRequestContext } from '../src/mcp/server.js';

describe('WebMCP proxy routing', () => {
  it('forwards tools/list metadata instead of falling back to the default page', async () => {
    let received: unknown;
    // SAFETY: this fixture exercises only listTools with an injected downstream client.
    const backend = Object.assign(Object.create(ProxyBackend.prototype), {
      _currentClient: { listTools: async (params: unknown) => { received = params; return { tools: [] }; } },
      _mcpProviders: [{}],
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
    _sessionClient: Promise.resolve(client('host')), _contextSwitchTool: { name: 'browser_connect' },
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
