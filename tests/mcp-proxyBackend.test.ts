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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { ProxyBackend } from '../src/mcp/proxyBackend.js';
import { SharedClientSlot } from '../src/mcp/sharedClientSlot.js';
import { wrapInProcess } from '../src/mcp/server.js';

import type { SharedProxySelection } from '../src/mcp/proxyBackend.js';

describe('ProxyBackend', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards progress metadata and relays downstream progress notifications', async () => {
    const backend = new ProxyBackend([{
      name: 'default',
      description: 'Default provider',
      connect: vi.fn(),
    } as any]);

    const sendNotification = vi.fn(async () => undefined);
    const callTool = vi.fn(async (_params: any, options?: { onprogress?: (params: { progress: number; total?: number; message?: string }) => void }) => {
      options?.onprogress?.({
        progress: 1,
        total: 2,
        message: 'Scanning',
      });
      return {
        content: [{ type: 'text', text: '### Result\nok' }],
      };
    });
    (backend as any)._currentClient = { callTool };

    await backend.callTool('audit_site', { startUrl: 'https://example.com' }, {
      _meta: { progressToken: 'progress-123' },
      sendNotification,
    } as any);

    expect(callTool).toHaveBeenCalledWith(
        {
          name: 'audit_site',
          arguments: { startUrl: 'https://example.com' },
          _meta: { progressToken: 'progress-123' },
        },
        expect.objectContaining({
          onprogress: expect.any(Function),
        }),
    );
    expect(sendNotification).toHaveBeenCalledWith({
      method: 'notifications/progress',
      params: {
        progressToken: 'progress-123',
        progress: 1,
        total: 2,
        message: 'Scanning',
      },
    });
  });

  it('notifies clients when the exposed tool list changes after switching providers', async () => {
    const backend = new ProxyBackend([
      {
        name: 'default',
        description: 'Default provider',
        connect: vi.fn(async () => ({ id: 'default-transport' })),
      },
      {
        name: 'alternate',
        description: 'Alternate provider',
        connect: vi.fn(async () => ({ id: 'alternate-transport' })),
      },
    ] as any);

    const close = vi.fn(async () => undefined);
    (backend as any)._currentClient = {
      listTools: vi.fn(async () => ({ tools: [{ name: 'scan_page' }] })),
      close,
    };
    (backend as any)._backendContext = {
      notifyToolListChanged: vi.fn(async () => undefined),
    };

    vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({
      tools: [{ name: 'audit_site' }] as any[],
    } as any);

    await (backend as any)._setCurrentClient((backend as any)._mcpProviders[1], true);

    expect(close).toHaveBeenCalledTimes(1);
    expect((backend as any)._backendContext.notifyToolListChanged).toHaveBeenCalledTimes(1);
  });

  it('skips tool list change notifications when the exposed tools stay the same', async () => {
    const backend = new ProxyBackend([
      {
        name: 'default',
        description: 'Default provider',
        connect: vi.fn(async () => ({ id: 'default-transport' })),
      },
      {
        name: 'alternate',
        description: 'Alternate provider',
        connect: vi.fn(async () => ({ id: 'alternate-transport' })),
      },
    ] as any);

    (backend as any)._currentClient = {
      listTools: vi.fn(async () => ({ tools: [{ name: 'scan_page' }] })),
      close: vi.fn(async () => undefined),
    };
    (backend as any)._backendContext = {
      notifyToolListChanged: vi.fn(async () => undefined),
    };

    vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({
      tools: [{ name: 'scan_page' }] as any[],
    } as any);

    await (backend as any)._setCurrentClient((backend as any)._mcpProviders[1], true);

    expect((backend as any)._backendContext.notifyToolListChanged).not.toHaveBeenCalled();
  });

  it('keeps the current provider connected when a switch fails validation', async () => {
    // validate() runs before the current client is torn down: a provider that
    // cannot serve the configuration (extension + storage state) must reject
    // the switch without stranding the session with no provider at all.
    const extensionConnect = vi.fn(async () => ({ id: 'extension-transport' }));
    const backend = new ProxyBackend([
      {
        name: 'default',
        description: 'Default provider',
        connect: vi.fn(async () => ({ id: 'default-transport' })),
      },
      {
        name: 'extension',
        description: 'Extension provider',
        validate: () => {
          throw new Error('Storage state cannot be applied in this mode. Stay on the "default" method.');
        },
        connect: extensionConnect,
      },
    ] as any);

    const currentClient = {
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
      close: vi.fn(async () => undefined),
    };
    (backend as any)._currentClient = currentClient;

    const result = await backend.callTool('browser_connect', { name: 'extension' });

    expect(result.isError).toBe(true);
    expect(result.content?.[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Storage state cannot be applied') });
    // The doomed switch never began: nothing was closed, nothing connected.
    expect(currentClient.close).not.toHaveBeenCalled();
    expect(extensionConnect).not.toHaveBeenCalled();
    // The session still serves tools through the previous provider.
    await backend.callTool('scan_page', {});
    expect(currentClient.callTool).toHaveBeenCalled();
  });

  // Stateless HTTP serves every handshake-free POST with a throwaway
  // ProxyBackend; a browser_connect switch must therefore be published
  // process-wide, or it reports success and silently reverts to the default
  // provider on the very next request.
  describe('process-scoped provider selection for stateless serving', () => {
    function makeInnerBackend(toolName: string) {
      const backend = {
        toolName,
        closed: 0,
        calls: [] as string[],
        listTools: async () => [{ name: toolName, description: toolName, inputSchema: { type: 'object' as const, properties: {} } }],
        callTool: async (name: string) => {
          backend.calls.push(name);
          return { content: [{ type: 'text' as const, text: toolName }] };
        },
        serverClosed: () => {
          backend.closed++;
        },
      };
      return backend;
    }

    function makeSharedSetup() {
      const defaults: ReturnType<typeof makeInnerBackend>[] = [];
      const alternates: ReturnType<typeof makeInnerBackend>[] = [];
      const makeProviders = () => [
        {
          name: 'default',
          description: 'Default provider',
          connect: async () => {
            const inner = makeInnerBackend('tool_default');
            defaults.push(inner);
            return wrapInProcess(inner as any);
          },
        },
        {
          name: 'alternate',
          description: 'Alternate provider',
          connect: async () => {
            const inner = makeInnerBackend('tool_alternate');
            alternates.push(inner);
            return wrapInProcess(inner as any);
          },
        },
      ];
      const shared: SharedProxySelection = { slot: new SharedClientSlot(), providers: makeProviders() as any };
      const backendContext = { notifyToolListChanged: vi.fn(async () => undefined) };
      const clientVersion = { name: 'vitest', version: '1.0.0' };
      const makeRequestBackend = () => new ProxyBackend(makeProviders() as any, shared);
      return { shared, defaults, alternates, backendContext, clientVersion, makeRequestBackend };
    }

    it('keeps a browser_connect switch in force for later per-request backends', async () => {
      const { alternates, backendContext, clientVersion, makeRequestBackend } = makeSharedSetup();

      const request1 = makeRequestBackend();
      await request1.initialize(backendContext as any, clientVersion);
      const switched = await request1.callTool('browser_connect', { name: 'alternate' });
      expect(switched.isError).not.toBe(true);
      // Response cleanup of the switching request must not tear down the
      // process-scoped client.
      request1.serverClosed?.();
      expect(alternates).toHaveLength(1);
      expect(alternates[0].closed).toBe(0);

      const request2 = makeRequestBackend();
      await request2.initialize(backendContext as any, clientVersion);
      const tools = await request2.listTools();
      expect(tools.map(tool => tool.name)).toContain('tool_alternate');
      const result = await request2.callTool('tool_alternate', {});
      expect((result.content?.[0] as any).text).toBe('tool_alternate');
      expect(alternates[0].calls).toContain('tool_alternate');
      // No second alternate connection was made, and this response's cleanup
      // leaves the shared client alive too.
      expect(alternates).toHaveLength(1);
      request2.serverClosed?.();
      expect(alternates[0].closed).toBe(0);
    });

    it('closes the shared client exactly once when switching back to the default provider', async () => {
      const { defaults, alternates, backendContext, clientVersion, makeRequestBackend } = makeSharedSetup();

      const request1 = makeRequestBackend();
      await request1.initialize(backendContext as any, clientVersion);
      await request1.callTool('browser_connect', { name: 'alternate' });
      request1.serverClosed?.();

      const request2 = makeRequestBackend();
      await request2.initialize(backendContext as any, clientVersion);
      const back = await request2.callTool('browser_connect', { name: 'default' });
      expect(back.isError).not.toBe(true);
      expect(alternates[0].closed).toBe(1);
      // The rest of this exchange runs on an owned per-request default
      // client, closed with the response.
      const tools = await request2.listTools();
      expect(tools.map(tool => tool.name)).toContain('tool_default');
      request2.serverClosed?.();
      expect(alternates[0].closed).toBe(1);

      const request3 = makeRequestBackend();
      await request3.initialize(backendContext as any, clientVersion);
      expect((await request3.listTools()).map(tool => tool.name)).toContain('tool_default');
      // Per-request default clients again: request2's and request3's.
      expect(defaults.length).toBeGreaterThanOrEqual(2);
    });

    it('keeps the previous shared selection when connecting the new provider fails', async () => {
      const { alternates, backendContext, clientVersion, shared, makeRequestBackend } = makeSharedSetup();

      const request1 = makeRequestBackend();
      await request1.initialize(backendContext as any, clientVersion);
      await request1.callTool('browser_connect', { name: 'alternate' });
      request1.serverClosed?.();

      const failing = new ProxyBackend([
        { name: 'default', description: 'd', connect: vi.fn(async () => ({ id: 'default-transport' })) },
        { name: 'alternate', description: 'a', connect: vi.fn(async () => ({ id: 'alternate-transport' })) },
      ] as any, {
        slot: shared.slot,
        providers: [
          { name: 'default', description: 'd', connect: vi.fn() },
          { name: 'alternate', description: 'a', connect: vi.fn(async () => { throw new Error('connect exploded'); }) },
        ] as any,
      });
      await failing.initialize(backendContext as any, clientVersion);
      const result = await failing.callTool('browser_connect', { name: 'alternate' });
      expect(result.isError).toBe(true);
      // The previously shared client was neither closed nor replaced.
      expect(alternates[0].closed).toBe(0);
      const request2 = makeRequestBackend();
      await request2.initialize(backendContext as any, clientVersion);
      expect((await request2.listTools()).map(tool => tool.name)).toContain('tool_alternate');
    });
  });
});
