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
import type { Transport } from '@modelcontextprotocol/client';
import { describe, it, vi } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { wrapInProcess } from '../src/mcp/server.js';
import type { ServerBackendContext } from '../src/mcp/server.js';
import { SharedClientSlot } from '../src/mcp/sharedClientSlot.js';
import { ToolRelay } from '../src/mcp/toolRelay.js';
import { ProxyBackend } from '../src/mcp/proxyBackend.js';
import { VSCodeProxyBackend } from '../src/vscode/host.js';
import type { CallToolRequestContext } from '../src/mcp/server.js';

async function routingHarness(kind: string, switched = false) {
  const calls: { destination: string, name?: string, args?: unknown, _meta?: CallToolRequestContext['_meta'] }[] = [];
  const connect = async (destination: string) => wrapInProcess({
    listTools: async request => { calls.push({ destination, _meta: request?._meta }); return []; },
    callTool: async (name, args, request) => {
      calls.push({ destination, name, args, _meta: request?._meta });
      const progressToken = request?._meta?.progressToken;
      if (progressToken !== undefined)
        await request!.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: 2, total: 3, message: 'Preparing audit' } });
      return { content: [] };
    },
  });
  const slot = switched ? new SharedClientSlot() : undefined;
  if (slot) {
    await slot.replace(async () => {
      const client = new Client({ name: 'switched-provider', version: '1' });
      client.setRequestHandler('ping', () => ({}));
      await client.connect(await connect('switched'));
      return client;
    });
  }
  const backend = kind === 'direct'
    ? new ProxyBackend([{ name: 'default', description: 'Default', connect: () => connect('host') }])
    : new VSCodeProxyBackend(await resolveConfig({}), () => connect('host'), slot);
  await backend.initialize({ notifyToolListChanged: async () => {} }, { name: 'test', version: '1' });
  return { backend, calls, close: async () => { backend.serverClosed(); await slot?.dispose(); } };
}

describe('WebMCP proxy routing', () => {
  for (const kind of ['direct', 'VS Code']) {
    it(`${kind}: forwards listing metadata and page arguments unchanged through MCP`, async () => {
      const { backend, calls, close } = await routingHarness(kind);
      try {
        const _meta = { browserSessionId: 'bs_host' };
        await backend.listTools({ _meta });
        const args = { browserSessionId: 42, _meta: 'page-owned metadata' };
        const request: CallToolRequestContext = { signal: new AbortController().signal, requestId: 1, sendNotification: async () => {}, _meta };
        await backend.callTool('webmcp_page_tool', args, request);
        assert.deepEqual(calls, [
          { destination: 'host', _meta },
          { destination: 'host', name: 'webmcp_page_tool', args, _meta },
        ]);
      } finally {
        await close();
      }
    });

    it(`${kind}: forwards zero-valued progress tokens through MCP`, async () => {
      const { backend, calls, close } = await routingHarness(kind);
      const notifications: unknown[] = [];
      try {
        const _meta = { progressToken: 0 };
        const args = { browserSessionId: 'page input', _meta: 'page metadata' };
        await backend.callTool('webmcp_page_tool', args, { signal: new AbortController().signal, requestId: 1,
          sendNotification: async value => { notifications.push(value); }, _meta });
        // The SDK assigns a downstream token for onprogress. The relay must
        // restore the original upstream token, including zero.
        assert.equal(typeof calls[0]._meta?.progressToken, 'number');
        assert.deepEqual(calls[0].args, args);
        assert.deepEqual(notifications, [{ method: 'notifications/progress', params: { progressToken: 0, progress: 2, total: 3, message: 'Preparing audit' } }]);
      } finally {
        await close();
      }
    });
  }
});

describe('WebMCP VS Code host routing', () => {
  it('keeps metadata-routed tools at the host and page-owned arguments on the switched provider', async () => {
    const { backend, calls, close } = await routingHarness('VS Code', true);
    try {
      await backend.listTools({ _meta: { browserSessionId: 'bs_host' } });
      await backend.callTool('webmcp_page_tool', { browserSessionId: 'page input', _meta: 'page metadata' });
      const _meta = { browserSessionId: 'bs_host', progressToken: 'host-progress' };
      const notifications: unknown[] = [];
      const args = { browserSessionId: 42 };
      await backend.callTool('webmcp_page_tool', args, { signal: new AbortController().signal, requestId: 1,
        sendNotification: async value => { notifications.push(value); }, _meta });
      assert.deepEqual(calls, [
        { destination: 'host', _meta: { browserSessionId: 'bs_host' } },
        { destination: 'switched', name: 'webmcp_page_tool', args: { browserSessionId: 'page input', _meta: 'page metadata' }, _meta: undefined },
        { destination: 'host', name: 'webmcp_page_tool', args, _meta: { ..._meta, progressToken: calls[2]._meta?.progressToken } },
      ]);
      assert.deepEqual(notifications, [{ method: 'notifications/progress', params: { progressToken: 'host-progress', progress: 2, total: 3, message: 'Preparing audit' } }]);
    } finally {
      await close();
    }
  });
});

describe('WebMCP proxy notification races', () => {
  it('VS Code: a settled old-provider listing cannot restore its notification recipient during a switch', async () => {
    let notifications = 0;
    let connections = 0;
    let oldContext: ServerBackendContext;
    let emitChange = false;
    let switchAfterResponse = false;
    let switched: Promise<unknown> | undefined;
    const connect = async () => {
      const provider = connections++;
      const inner = await wrapInProcess({
        initialize: async context => {
          if (provider === 0)
            oldContext = context;
        },
        listTools: async () => {
          if (provider === 0 && emitChange)
            await oldContext.notifyToolListChanged();
          return [{ name: `tool_${provider}`, inputSchema: { type: 'object' as const } }];
        },
        callTool: async () => ({ content: [] }),
      });
      const transport: Transport = {
        start: async () => {
          inner.onmessage = (message, extra) => {
            transport.onmessage?.(message, extra);
            // The SDK has resolved the response, but the backend's listing
            // continuation has not run when the provider switch starts.
            if (provider === 0 && switchAfterResponse && 'result' in message && 'tools' in message.result) {
              switchAfterResponse = false;
              switched = backend.callTool('browser_connect', {});
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
    const backend = new VSCodeProxyBackend(await resolveConfig({}), connect);
    try {
      await backend.initialize({ notifyToolListChanged: async () => { ++notifications; } }, { name: 'test', version: '1' });
      await backend.listTools();
      emitChange = switchAfterResponse = true;
      const oldTools = await backend.listTools();
      assert.equal(oldTools[0].name, 'tool_0');
      assert.ok(switched, 'the transport starts the switch after delivering the old response');
      await switched;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(notifications, 1, 'only the provider switch announces a catalog change');
      const newTools = await backend.listTools();
      assert.equal(newTools[0].name, 'tool_1');
    } finally {
      await switched;
      backend.serverClosed();
    }
  });

  for (const kind of ['direct', 'VS Code']) {
    it.each([
      { replacement: false, changed: false },
      { replacement: false, changed: true },
      { replacement: true, changed: false },
      { replacement: true, changed: true },
    ])(`${kind}: finishes discovery after the listing continuation (replacement: $replacement, changed: $changed)`, async ({ replacement, changed }) => {
      const events: string[] = [];
      let innerContext!: ServerBackendContext;
      const connect = async () => wrapInProcess({
        initialize: async context => { innerContext = context; },
        listTools: async () => [{ name: 'page_tool', inputSchema: { type: 'object' as const } }],
        callTool: async () => ({ content: [] }),
      });
      const backend = kind === 'direct'
        ? new ProxyBackend([{ name: 'default', description: 'Default', connect }, { name: 'replacement', description: 'Replacement', connect }])
        : new VSCodeProxyBackend(await resolveConfig({}), connect);
      const listTools = Client.prototype.listTools;
      let spy: ReturnType<typeof vi.spyOn> | undefined;
      try {
        await backend.initialize({ notifyToolListChanged: async () => { events.push('list changed'); } }, { name: 'test', version: '1' });
        if (replacement) {
          await backend.listTools();
          await backend.callTool('browser_connect', kind === 'direct' ? { name: 'replacement' } : {});
          events.length = 0;
        }
        // Resolve the actual downstream read, then deliver a notification.
        // The SDK queues its handler after the relay's finalizer but before
        // the adapter can accept the returned catalog and its recipient.
        spy = vi.spyOn(Client.prototype, 'listTools').mockImplementation(function(this: Client, ...args) {
          const response = Promise.withResolvers<Awaited<ReturnType<Client['listTools']>>>();
          void listTools.apply(this, args).then(result => {
            response.resolve(result);
            if (changed)
              void innerContext.notifyToolListChanged();
          }, response.reject);
          return response.promise;
        });
        const tools = await backend.listTools();
        events.push('list returned');
        assert.equal(tools[0].name, 'page_tool');
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepEqual(events, changed ? ['list returned', 'list changed'] : ['list returned']);
        events.length = 0;
        await innerContext.notifyToolListChanged();
        assert.deepEqual(events, ['list changed'], 'completed discovery no longer buffers idle changes');
      } finally {
        spy?.mockRestore();
        backend.serverClosed();
      }
    });

    for (const startSecond of ['overlapping', 'before deferred notification']) {
      it(`${kind}: retains catalog changes until ${startSecond} listings settle`, async () => {
        let notifications = 0;
        let innerContext!: ServerBackendContext;
        let call = 0;
        const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
        const finish = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
        const connect = async () => wrapInProcess({
          initialize: async context => { innerContext = context; },
          listTools: async () => {
            const index = call++;
            started[index].resolve();
            await finish[index].promise;
            return [];
          },
          callTool: async () => ({ content: [] }),
        });
        const backend = kind === 'direct'
          ? new ProxyBackend([{ name: 'default', description: 'Default', connect }])
          : new VSCodeProxyBackend(await resolveConfig({}), connect);
        try {
          await backend.initialize({ notifyToolListChanged: async () => { ++notifications; } }, { name: 'test', version: '1' });
          const first = backend.listTools();
          await started[0].promise;
          await innerContext.notifyToolListChanged();
          let second: Promise<unknown>;
          if (startSecond === 'overlapping') {
            second = backend.listTools();
            await started[1].promise;
            finish[0].resolve();
            await first;
          } else {
            finish[0].resolve();
            await first;
            // The first listing has scheduled setImmediate, but this new
            // listing starts before that timer is allowed to run.
            second = backend.listTools();
            await started[1].promise;
          }
          await new Promise<void>(resolve => setImmediate(resolve));
          assert.equal(notifications, 0);
          finish[1].resolve();
          await second;
          await new Promise<void>(resolve => setImmediate(resolve));
          assert.equal(notifications, 1, 'the dirty flag survives the intervening listing');
        } finally {
          finish.forEach(gate => gate.resolve());
          backend.serverClosed();
        }
      });
    }

    it(`${kind}: preserves changes on first and replacement-provider listings and after rejected lists`, async () => {
      let notifications = 0;
      const innerContexts: ServerBackendContext[] = [];
      let duringList: (() => Promise<void>) | undefined;
      const connect = async () => wrapInProcess({
        initialize: async context => { innerContexts.push(context); },
        listTools: async () => { await duringList?.(); return []; },
        callTool: async () => ({ content: [] }),
      });
      const backend = kind === 'direct'
        ? new ProxyBackend([{ name: 'default', description: 'Default', connect }, { name: 'replacement', description: 'Replacement', connect }])
        : new VSCodeProxyBackend(await resolveConfig({}), connect);
      try {
        await backend.initialize({ notifyToolListChanged: async () => { ++notifications; } }, { name: 'test', version: '1' });
        duringList = () => innerContexts[0].notifyToolListChanged();
        await backend.listTools();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(notifications, 1);
        await backend.callTool('browser_connect', kind === 'direct' ? { name: 'replacement' } : {});
        notifications = 0;
        duringList = () => innerContexts[1].notifyToolListChanged();
        await backend.listTools();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(notifications, 1);
        duringList = async () => { await innerContexts[1].notifyToolListChanged(); throw new Error('listing failed'); };
        notifications = 0;
        await assert.rejects(backend.listTools(), /listing failed/);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(notifications, 1, 'failed listing retains its buffered change');
        notifications = 0;
        await innerContexts[1].notifyToolListChanged();
        assert.equal(notifications, 1, 'failed listing preserves the previous recipient');
      } finally {
        backend.serverClosed();
      }
    });
  }
});

describe('downstream tool relay lifetime', () => {
  it('ignores obsolete-client changes and clears buffered notifications on shutdown', async () => {
    const clients: Client[] = [];
    const contexts: ServerBackendContext[] = [];
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let selected: Client | undefined;
    let notifications = 0;
    const relay = new ToolRelay(client => selected === client ? Promise.resolve().then(() => { ++notifications; }) : undefined, error => { throw error; });
    try {
      for (let index = 0; index < 2; ++index) {
        const client = new Client({ name: 'relay-client', version: '1' });
        client.setRequestHandler('ping', () => ({}));
        relay.observe(client);
        await client.connect(await wrapInProcess({
          initialize: async context => { contexts[index] = context; },
          listTools: async () => { await gates[index].promise; return []; },
          callTool: async () => ({ content: [] }),
        }));
        clients.push(client);
      }
      selected = clients[0];
      gates[0].resolve();
      await relay.listTools(clients[0]);
      await contexts[0].notifyToolListChanged();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(notifications, 1);
      const pending = relay.listTools(clients[1]);
      // Begin initialization/discovery on the second client without changing
      // the previous completed recipient until it is ready.
      await new Promise<void>(resolve => setImmediate(resolve));
      await contexts[1].notifyToolListChanged();
      gates[1].resolve();
      await pending;
      selected = clients[1];
      await contexts[0].notifyToolListChanged();
      assert.equal(notifications, 1, 'an obsolete client cannot notify the new recipient');
      relay.close();
      await new Promise<void>(resolve => setImmediate(resolve));
      await contexts[0].notifyToolListChanged();
      await contexts[1].notifyToolListChanged();
      assert.equal(notifications, 1, 'shutdown suppresses late and buffered changes');
    } finally {
      gates.forEach(gate => gate.resolve());
      relay.close();
      await Promise.all(clients.map(client => client.close()));
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

describe('WebMCP proxy list cancellation', () => {
  for (const kind of ['direct', 'VS Code']) {
    it(`${kind}: cancels downstream discovery and accepts the next request`, async () => {
      const started = Promise.withResolvers<AbortSignal | undefined>();
      const finished = Promise.withResolvers<void>();
      let holdList = false;
      let discoveryStopped = false;
      const connect = async () => wrapInProcess({
        listTools: async requestContext => {
          if (holdList) {
            const signal = requestContext?.signal;
            const stop = () => finished.resolve();
            started.resolve(signal);
            signal?.addEventListener('abort', stop, { once: true });
            await finished.promise;
            signal?.removeEventListener('abort', stop);
            discoveryStopped = true;
          }
          return [];
        },
        callTool: async () => ({ content: [] }),
      });
      const backend = kind === 'direct'
        ? new ProxyBackend([{ name: 'default', description: 'Default', connect }])
        : new VSCodeProxyBackend(await resolveConfig({}), connect);
      const client = new Client({ name: 'list-cancellation-test', version: '1' });
      client.setRequestHandler('ping', () => ({}));
      const controller = new AbortController();
      try {
        await client.connect(await wrapInProcess(backend));
        await client.listTools();
        holdList = true;
        const rejected = assert.rejects(client.listTools(undefined, { signal: controller.signal }), /cancelled discovery/);
        const downstreamSignal = await started.promise;
        controller.abort(new Error('cancelled discovery'));
        await rejected;
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.ok(downstreamSignal, 'the server passes the request signal to discovery');
        assert.equal(downstreamSignal.aborted, true, 'cancellation reaches the inner server across both MCP transports');
        assert.equal(discoveryStopped, true, 'cancelled discovery has released its work');
        holdList = false;
        await client.listTools();
      } finally {
        controller.abort();
        finished.resolve();
        await client.close();
      }
    });
  }
});

describe('WebMCP proxy call cancellation', () => {
  for (const kind of ['direct', 'VS Code']) {
    it(`${kind}: cancels downstream invocation without retrying the page action`, async () => {
      const started = Promise.withResolvers<AbortSignal>();
      const finished = Promise.withResolvers<void>();
      let invocations = 0;
      const args = { browserSessionId: 42, _meta: 'page-owned' };
      const connect = async () => wrapInProcess({
        listTools: async () => [],
        callTool: async (_name, received, request) => {
          ++invocations;
          assert.deepEqual(received, args);
          assert.equal(request?._meta?.browserSessionId, 'bs_host');
          const signal = request!.signal;
          const stop = () => finished.resolve();
          signal.addEventListener('abort', stop, { once: true });
          started.resolve(signal);
          await finished.promise;
          signal.removeEventListener('abort', stop);
          return { content: [] };
        },
      });
      const backend = kind === 'direct'
        ? new ProxyBackend([{ name: 'default', description: 'Default', connect }])
        : new VSCodeProxyBackend(await resolveConfig({}), connect);
      const controller = new AbortController();
      try {
        await backend.initialize({ notifyToolListChanged: async () => {} }, { name: 'test', version: '1' });
        const outcome = backend.callTool('webmcp_page_tool', args, {
          signal: controller.signal, requestId: 1, sendNotification: async () => {}, _meta: { browserSessionId: 'bs_host' },
        }).then(() => 'completed without cancellation', String);
        const signal = await started.promise;
        controller.abort(new Error('cancelled action'));
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(signal.aborted, true);
        assert.match(await outcome, /cancelled action/);
        assert.equal(invocations, 1, 'an uncertain page action is never retried');
      } finally {
        controller.abort();
        finished.resolve();
        backend.serverClosed();
      }
    });
  }
});
