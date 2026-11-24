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

describe('ProxyBackend', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards progress metadata and relays downstream progress notifications', async () => {
    const backend = new ProxyBackend([{
      name: 'default',
      description: 'Default provider',
      connect: vi.fn(),
    }]);

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
    const defaultInner = makeInnerBackend('scan_page');
    const alternateInner = makeInnerBackend('scan_page');
    const defaultListTools = vi.spyOn(defaultInner, 'listTools');
    const alternateListTools = vi.spyOn(alternateInner, 'listTools');
    const backend = new ProxyBackend([
      { name: 'default', description: 'Default provider', connect: async () => wrapInProcess(defaultInner) },
      { name: 'alternate', description: 'Alternate provider', connect: async () => wrapInProcess(alternateInner) },
    ]);
    const context = { notifyToolListChanged: vi.fn(async () => undefined) };
    await backend.initialize(context, { name: 'vitest', version: '1' });

    const switched = await backend.callTool('browser_connect', { name: 'alternate' });

    expect(switched.isError).not.toBe(true);
    expect(defaultInner.closed).toBe(1);
    // Announced even with matching built-in names: page tools depend on the
    // browser, and listing either provider would run page discovery.
    expect(context.notifyToolListChanged).toHaveBeenCalledTimes(1);
    expect(defaultListTools).not.toHaveBeenCalled();
    expect(alternateListTools).not.toHaveBeenCalled();
    backend.serverClosed?.();
  });

  // A switch connects the replacement before publishing it and only then
  // closes the client it replaced: a failed handshake must not strand the
  // connection without the client that was working.
  describe('switching the per-connection provider', () => {
    async function makeBackend(alternates: Record<string, () => Promise<any>>) {
      const defaultInner = makeInnerBackend('tool_default');
      const backend = new ProxyBackend([
        { name: 'default', description: 'Default provider', connect: async () => wrapInProcess(defaultInner) },
        ...Object.entries(alternates).map(([name, connect]) => ({ name, description: name, connect })),
      ]);
      const context = { notifyToolListChanged: vi.fn(async () => undefined) };
      await backend.initialize(context, { name: 'vitest', version: '1' });
      return { backend, defaultInner, context };
    }

    const refusingTransport = () => ({
      start: async () => {
        throw new Error('handshake refused');
      },
      send: async () => {},
      close: async () => {},
    });

    it('keeps the working client when the replacement handshake fails', async () => {
      const { backend, defaultInner, context } = await makeBackend({ alternate: async () => refusingTransport() });

      const result = await backend.callTool('browser_connect', { name: 'alternate' });

      expect(result.isError).toBe(true);
      expect(result.content?.[0]).toMatchObject({ type: 'text', text: expect.stringContaining('handshake refused') });
      expect(defaultInner.closed).toBe(0);
      expect(context.notifyToolListChanged).not.toHaveBeenCalled();
      const after = await backend.callTool('tool_default', {});
      expect((after.content?.[0] as any).text).toBe('tool_default');
      expect(defaultInner.calls).toEqual(['tool_default']);
      backend.serverClosed?.();
      await vi.waitFor(() => expect(defaultInner.closed).toBe(1));
    });

    it('serves from the working client while a replacement connects, and applies overlapping switches in call order', async () => {
      const first = makeInnerBackend('tool_first');
      const second = makeInnerBackend('tool_second');
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
      const { backend, defaultInner } = await makeBackend({
        first: async () => {
          await firstGate;
          return wrapInProcess(first);
        },
        second: async () => wrapInProcess(second),
      });

      const switchingFirst = backend.callTool('browser_connect', { name: 'first' });
      const switchingSecond = backend.callTool('browser_connect', { name: 'second' });
      // While the first replacement is still connecting, the working client
      // stays published and open.
      const during = await backend.callTool('tool_default', {});
      expect((during.content?.[0] as any).text).toBe('tool_default');
      expect(defaultInner.closed).toBe(0);

      releaseFirst();
      expect((await switchingFirst).isError).not.toBe(true);
      expect((await switchingSecond).isError).not.toBe(true);

      const after = await backend.callTool('tool_second', {});
      expect((after.content?.[0] as any).text).toBe('tool_second');
      expect(defaultInner.closed).toBe(1);
      expect(first.closed).toBe(1);
      expect(second.closed).toBe(0);
      backend.serverClosed?.();
      await vi.waitFor(() => expect(second.closed).toBe(1));
    });

    it('lets a call routed to the working client finish when the replacement handshake completes first, then closes it', async () => {
      // An owned client was published without a lease, so the replacement
      // closed it the moment its handshake finished, failing a scan that had
      // been routed to it while the handshake was pending.
      let releaseCall!: () => void;
      const callGate = new Promise<void>(resolve => { releaseCall = resolve; });
      let callStarted = false;
      const defaultInner = {
        closed: 0,
        listTools: async () => [{ name: 'tool_default', description: 'd', inputSchema: { type: 'object' as const, properties: {} } }],
        callTool: async () => {
          callStarted = true;
          await callGate;
          return { content: [{ type: 'text' as const, text: 'late result' }] };
        },
        serverClosed: () => {
          defaultInner.closed++;
        },
      };
      const alternate = makeInnerBackend('tool_alternate');
      let releaseHandshake!: () => void;
      const handshakeGate = new Promise<void>(resolve => { releaseHandshake = resolve; });
      const backend = new ProxyBackend([
        { name: 'default', description: 'd', connect: async () => wrapInProcess(defaultInner) },
        {
          name: 'alternate',
          description: 'a',
          connect: async () => {
            await handshakeGate;
            return wrapInProcess(alternate);
          },
        },
      ]);
      await backend.initialize({ notifyToolListChanged: vi.fn(async () => undefined) }, { name: 'vitest', version: '1' });

      const switching = backend.callTool('browser_connect', { name: 'alternate' });
      const inFlight = backend.callTool('tool_default', {});
      await vi.waitFor(() => expect(callStarted).toBe(true));

      releaseHandshake();
      expect((await switching).isError).not.toBe(true);
      // The new client serves new calls while the old one drains.
      const fresh = await backend.callTool('tool_alternate', {});
      expect((fresh.content?.[0] as any).text).toBe('tool_alternate');
      expect(defaultInner.closed).toBe(0);

      releaseCall();
      const result = await inFlight;
      expect(result.isError).not.toBe(true);
      expect((result.content?.[0] as any).text).toBe('late result');
      await vi.waitFor(() => expect(defaultInner.closed).toBe(1));
      backend.serverClosed?.();
      await vi.waitFor(() => expect(alternate.closed).toBe(1));
    });

    it('keeps the working client when an overlapping switch fails, and applies the one that succeeds', async () => {
      const second = makeInnerBackend('tool_second');
      const { backend, defaultInner } = await makeBackend({
        broken: async () => refusingTransport(),
        second: async () => wrapInProcess(second),
      });

      const [failed, succeeded] = await Promise.all([
        backend.callTool('browser_connect', { name: 'broken' }),
        backend.callTool('browser_connect', { name: 'second' }),
      ]);

      expect(failed.isError).toBe(true);
      expect(succeeded.isError).not.toBe(true);
      const after = await backend.callTool('tool_second', {});
      expect((after.content?.[0] as any).text).toBe('tool_second');
      expect(defaultInner.closed).toBe(1);
      backend.serverClosed?.();
    });

    it('does not connect a replacement once the connection closes', async () => {
      const alternates: ReturnType<typeof makeInnerBackend>[] = [];
      const { backend, defaultInner } = await makeBackend({
        alternate: async () => {
          const inner = makeInnerBackend('tool_alternate');
          alternates.push(inner);
          return wrapInProcess(inner);
        },
      });

      const switching = backend.callTool('browser_connect', { name: 'alternate' });
      backend.serverClosed?.();

      const result = await switching;
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as any).text).toContain('disposed before the replacement could be published');
      expect(alternates).toHaveLength(0);
      await vi.waitFor(() => expect(defaultInner.closed).toBe(1));
    });
  });

  it('neither lists tools nor notifies while connecting the first provider', async () => {
    const backend = new ProxyBackend([
      {
        name: 'default',
        description: 'Default provider',
        connect: vi.fn(async () => ({ id: 'default-transport' })),
      },
    ] as any);
    const context = { notifyToolListChanged: vi.fn(async () => undefined) };
    vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
    const listTools = vi.spyOn(Client.prototype, 'listTools');

    await backend.initialize(context, { name: 'vitest', version: '1' });

    expect(listTools).not.toHaveBeenCalled();
    expect(context.notifyToolListChanged).not.toHaveBeenCalled();
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
            return wrapInProcess(inner);
          },
        },
        {
          name: 'alternate',
          description: 'Alternate provider',
          connect: async () => {
            const inner = makeInnerBackend('tool_alternate');
            alternates.push(inner);
            return wrapInProcess(inner);
          },
        },
      ];
      const shared: SharedProxySelection = { slot: new SharedClientSlot(), providers: makeProviders() };
      const backendContext = { notifyToolListChanged: vi.fn(async () => undefined) };
      const clientVersion = { name: 'vitest', version: '1.0.0' };
      const makeRequestBackend = () => new ProxyBackend(makeProviders(), shared);
      return { shared, defaults, alternates, backendContext, clientVersion, makeRequestBackend };
    }

    it('keeps a browser_connect switch in force for later per-request backends', async () => {
      const { alternates, backendContext, clientVersion, makeRequestBackend } = makeSharedSetup();

      const request1 = makeRequestBackend();
      await request1.initialize(backendContext, clientVersion);
      const switched = await request1.callTool('browser_connect', { name: 'alternate' });
      expect(switched.isError).not.toBe(true);
      // Response cleanup of the switching request must not tear down the
      // process-scoped client.
      request1.serverClosed?.();
      expect(alternates).toHaveLength(1);
      expect(alternates[0].closed).toBe(0);

      const request2 = makeRequestBackend();
      await request2.initialize(backendContext, clientVersion);
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
      await request1.initialize(backendContext, clientVersion);
      await request1.callTool('browser_connect', { name: 'alternate' });
      request1.serverClosed?.();

      const request2 = makeRequestBackend();
      await request2.initialize(backendContext, clientVersion);
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
      await request3.initialize(backendContext, clientVersion);
      expect((await request3.listTools()).map(tool => tool.name)).toContain('tool_default');
      // Per-request default clients again: request2's and request3's.
      expect(defaults.length).toBeGreaterThanOrEqual(2);
    });

    it('lets an in-flight call finish on the outgoing shared client, closing it exactly once after the drain', async () => {
      // slot.replace() used to close the previous client as soon as the swap
      // was published, failing a request that had adopted it and was still
      // inside a long callTool. The close is now deferred until every
      // adopter has released its lease.
      const backendContext = { notifyToolListChanged: vi.fn(async () => undefined) };
      const clientVersion = { name: 'vitest', version: '1.0.0' };
      let releaseCall: (() => void) | undefined;
      const alternateInner = {
        closed: 0,
        listTools: async () => [{ name: 'tool_alternate', description: 'a', inputSchema: { type: 'object' as const, properties: {} } }],
        callTool: async () => {
          await new Promise<void>(resolve => { releaseCall = resolve; });
          return { content: [{ type: 'text' as const, text: 'late result' }] };
        },
        serverClosed: () => {
          alternateInner.closed++;
        },
      };
      const makeProviders = () => [
        { name: 'default', description: 'd', connect: async () => wrapInProcess(makeInnerBackend('tool_default')) },
        { name: 'alternate', description: 'a', connect: async () => wrapInProcess(alternateInner) },
      ];
      const shared: SharedProxySelection = { slot: new SharedClientSlot(), providers: makeProviders() };
      const makeRequestBackend = () => new ProxyBackend(makeProviders(), shared);

      const request1 = makeRequestBackend();
      await request1.initialize(backendContext, clientVersion);
      await request1.callTool('browser_connect', { name: 'alternate' });
      request1.serverClosed?.();

      // request2 adopts the shared client and starts a long tool call.
      const request2 = makeRequestBackend();
      await request2.initialize(backendContext, clientVersion);
      const inFlight = request2.callTool('tool_alternate', {});
      await vi.waitFor(() => expect(releaseCall).toBeDefined());

      // request3 switches back to default while request2's call is still in
      // flight: the outgoing client must stay open for it.
      const request3 = makeRequestBackend();
      await request3.initialize(backendContext, clientVersion);
      const back = await request3.callTool('browser_connect', { name: 'default' });
      expect(back.isError).not.toBe(true);
      expect(alternateInner.closed).toBe(0);
      request3.serverClosed?.();

      releaseCall!();
      const result = await inFlight;
      expect((result.content?.[0] as any).text).toBe('late result');

      // request2's response cleanup releases the last lease, which runs the
      // deferred close — exactly once; a straggling repeat is a no-op.
      request2.serverClosed?.();
      await vi.waitFor(() => expect(alternateInner.closed).toBe(1));
      request2.serverClosed?.();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(alternateInner.closed).toBe(1);
    });

    it('keeps an adopter arriving mid-switch on the live outgoing client, and later adopters on the new one', async () => {
      // The swap is atomic for adopters: a request initializing while the
      // replacement is still connecting adopts the outgoing client — which
      // must stay usable until that request releases it — and a request
      // arriving after the swap adopts the replacement.
      const backendContext = { notifyToolListChanged: vi.fn(async () => undefined) };
      const clientVersion = { name: 'vitest', version: '1.0.0' };
      const alternates: ReturnType<typeof makeInnerBackend>[] = [];
      const gateRef: { gate?: Promise<void> } = {};
      const makeProviders = () => [
        { name: 'default', description: 'd', connect: async () => wrapInProcess(makeInnerBackend('tool_default')) },
        {
          name: 'alternate',
          description: 'a',
          connect: async () => {
            if (gateRef.gate)
              await gateRef.gate;
            const inner = makeInnerBackend('tool_alternate');
            alternates.push(inner);
            return wrapInProcess(inner);
          },
        },
      ];
      const shared: SharedProxySelection = { slot: new SharedClientSlot(), providers: makeProviders() };
      const makeRequestBackend = () => new ProxyBackend(makeProviders(), shared);

      const request1 = makeRequestBackend();
      await request1.initialize(backendContext, clientVersion);
      await request1.callTool('browser_connect', { name: 'alternate' });
      request1.serverClosed?.();

      // request2 re-switches to a fresh alternate connection; its connect
      // blocks on the gate.
      let releaseGate: () => void;
      gateRef.gate = new Promise<void>(resolve => { releaseGate = resolve; });
      const request2 = makeRequestBackend();
      await request2.initialize(backendContext, clientVersion);
      const switching = request2.callTool('browser_connect', { name: 'alternate' });

      // request3 arrives mid-switch and adopts the still-published old client.
      const request3 = makeRequestBackend();
      await request3.initialize(backendContext, clientVersion);

      releaseGate!();
      const switched = await switching;
      expect(switched.isError).not.toBe(true);
      expect(alternates).toHaveLength(2);

      // The old client request3 adopted survived the swap and still serves it.
      const result = await request3.callTool('tool_alternate', {});
      expect((result.content?.[0] as any).text).toBe('tool_alternate');
      expect(alternates[0].calls).toContain('tool_alternate');
      expect(alternates[0].closed).toBe(0);

      // Its release drains the retired client; the replacement stays live for
      // the requests that come after the swap.
      request3.serverClosed?.();
      await vi.waitFor(() => expect(alternates[0].closed).toBe(1));
      request2.serverClosed?.();

      const request4 = makeRequestBackend();
      await request4.initialize(backendContext, clientVersion);
      const late = await request4.callTool('tool_alternate', {});
      expect((late.content?.[0] as any).text).toBe('tool_alternate');
      expect(alternates[1].calls).toContain('tool_alternate');
      expect(alternates[1].closed).toBe(0);
    });

    it('dispose closes the shared client even while adopters still hold leases', async () => {
      // Exit cleanup must not wait for a drain: a hung request would stall
      // process shutdown forever, and nothing outlives the process anyway.
      const { alternates, backendContext, clientVersion, shared, makeRequestBackend } = makeSharedSetup();

      const request1 = makeRequestBackend();
      await request1.initialize(backendContext, clientVersion);
      await request1.callTool('browser_connect', { name: 'alternate' });
      request1.serverClosed?.();

      const request2 = makeRequestBackend();
      await request2.initialize(backendContext, clientVersion);

      await shared.slot.dispose();
      expect(alternates[0].closed).toBe(1);

      // request2's straggling release must not double-close.
      request2.serverClosed?.();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(alternates[0].closed).toBe(1);
    });

    it('applies an alternate switch that overlaps a still-connecting default switch without stranding a closed client', async () => {
      // The shared publication used to set the current client and then queue
      // the owned-slot clear behind the owned default replacement still
      // connecting; that replacement published itself, and the queued clear
      // then closed it, leaving the backend pointed at a closed client.
      const alternates: ReturnType<typeof makeInnerBackend>[] = [];
      const defaults: ReturnType<typeof makeInnerBackend>[] = [];
      let gate: Promise<void> | undefined;
      const makeProviders = () => [
        {
          name: 'default',
          description: 'd',
          connect: async () => {
            const inner = makeInnerBackend('tool_default');
            defaults.push(inner);
            const transport = await wrapInProcess(inner);
            const pending = gate;
            if (pending) {
              const start = transport.start.bind(transport);
              transport.start = async () => {
                await pending;
                await start();
              };
            }
            return transport;
          },
        },
        {
          name: 'alternate',
          description: 'a',
          connect: async () => {
            const inner = makeInnerBackend('tool_alternate');
            alternates.push(inner);
            return wrapInProcess(inner);
          },
        },
      ];
      const shared: SharedProxySelection = { slot: new SharedClientSlot(), providers: makeProviders() };
      const backend = new ProxyBackend(makeProviders(), shared);
      await backend.initialize({ notifyToolListChanged: vi.fn(async () => undefined) }, { name: 'vitest', version: '1.0.0' });
      expect(defaults).toHaveLength(1);

      let releaseDefault!: () => void;
      gate = new Promise<void>(resolve => { releaseDefault = resolve; });
      const toDefault = backend.callTool('browser_connect', { name: 'default' });
      await vi.waitFor(() => expect(defaults).toHaveLength(2));
      gate = undefined;
      const toAlternate = backend.callTool('browser_connect', { name: 'alternate' });
      // Let the alternate switch get as far as it can before the default
      // handshake completes.
      await new Promise(resolve => setTimeout(resolve, 10));

      releaseDefault();
      expect((await toDefault).isError).not.toBe(true);
      expect((await toAlternate).isError).not.toBe(true);

      // The later switch wins, and the backend serves from a live client.
      const result = await backend.callTool('tool_alternate', {});
      expect(result.isError).not.toBe(true);
      expect((result.content?.[0] as any).text).toBe('tool_alternate');
      expect(alternates).toHaveLength(1);
      expect(alternates[0].closed).toBe(0);
      await vi.waitFor(() => expect(defaults.map(inner => inner.closed)).toEqual([1, 1]));
      backend.serverClosed?.();
      await shared.slot.dispose();
    });

    it('never lets a slow switch back to the default erase a later request\'s alternate selection', async () => {
      // The default used to be readied before the switch joined the
      // process-wide queue: while its handshake waited, another request
      // switched to the alternate and reported success, and the earlier
      // switch then cleared that newer selection. Switches now apply in the
      // order they enter the queue.
      const alternates: ReturnType<typeof makeInnerBackend>[] = [];
      const defaults: ReturnType<typeof makeInnerBackend>[] = [];
      let gate: Promise<void> | undefined;
      const makeProviders = () => [
        {
          name: 'default',
          description: 'd',
          connect: async () => {
            const inner = makeInnerBackend('tool_default');
            defaults.push(inner);
            const transport = await wrapInProcess(inner);
            const pending = gate;
            if (pending) {
              const start = transport.start.bind(transport);
              transport.start = async () => {
                await pending;
                await start();
              };
            }
            return transport;
          },
        },
        {
          name: 'alternate',
          description: 'a',
          connect: async () => {
            const inner = makeInnerBackend('tool_alternate');
            alternates.push(inner);
            return wrapInProcess(inner);
          },
        },
      ];
      const shared: SharedProxySelection = { slot: new SharedClientSlot(), providers: makeProviders() };
      const backendContext = { notifyToolListChanged: vi.fn(async () => undefined) };
      const clientVersion = { name: 'vitest', version: '1.0.0' };
      const makeRequestBackend = () => new ProxyBackend(makeProviders(), shared);

      const request0 = makeRequestBackend();
      await request0.initialize(backendContext, clientVersion);
      expect((await request0.callTool('browser_connect', { name: 'alternate' })).isError).not.toBe(true);
      request0.serverClosed?.();

      const request1 = makeRequestBackend();
      await request1.initialize(backendContext, clientVersion);
      const request2 = makeRequestBackend();
      await request2.initialize(backendContext, clientVersion);
      const defaultsBefore = defaults.length;
      let releaseDefault!: () => void;
      gate = new Promise<void>(resolve => { releaseDefault = resolve; });
      const toDefault = request1.callTool('browser_connect', { name: 'default' });
      await vi.waitFor(() => expect(defaults).toHaveLength(defaultsBefore + 1));
      gate = undefined;
      const toAlternate = request2.callTool('browser_connect', { name: 'alternate' });
      await new Promise(resolve => setTimeout(resolve, 10));
      // The later switch waits its turn behind the default handshake.
      expect(alternates).toHaveLength(1);

      releaseDefault();
      expect((await toDefault).isError).not.toBe(true);
      expect((await toAlternate).isError).not.toBe(true);

      // The later selection stands for new requests.
      const request3 = makeRequestBackend();
      await request3.initialize(backendContext, clientVersion);
      expect((await request3.listTools()).map(tool => tool.name)).toContain('tool_alternate');
      expect(((await request3.callTool('tool_alternate', {})).content?.[0] as any).text).toBe('tool_alternate');
      expect(alternates).toHaveLength(2);
      expect(alternates[1].calls).toContain('tool_alternate');
      expect(alternates[1].closed).toBe(0);
      // request1 serves from the default it switched to.
      expect(((await request1.callTool('tool_default', {})).content?.[0] as any).text).toBe('tool_default');

      request1.serverClosed?.();
      request2.serverClosed?.();
      request3.serverClosed?.();
      await vi.waitFor(() => expect(alternates[0].closed).toBe(1));
      await shared.slot.dispose();
      expect(alternates.map(inner => inner.closed)).toEqual([1, 1]);
    });

    it('keeps the previous shared selection when connecting the new provider fails', async () => {
      const { alternates, backendContext, clientVersion, shared, makeRequestBackend } = makeSharedSetup();

      const request1 = makeRequestBackend();
      await request1.initialize(backendContext, clientVersion);
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
        ],
      });
      await failing.initialize(backendContext, clientVersion);
      const result = await failing.callTool('browser_connect', { name: 'alternate' });
      expect(result.isError).toBe(true);
      // The previously shared client was neither closed nor replaced.
      expect(alternates[0].closed).toBe(0);
      const request2 = makeRequestBackend();
      await request2.initialize(backendContext, clientVersion);
      expect((await request2.listTools()).map(tool => tool.name)).toContain('tool_alternate');
    });

    it.each([
      ['cannot create its transport', async () => { throw new Error('default provider failed'); }],
      ['fails its handshake', async () => ({
        start: async () => { throw new Error('default provider failed'); },
        send: async () => {},
        close: async () => {},
      })],
    ])('keeps the shared selection for new requests when switching back fails because the default %s', async (_label, failingDefault) => {
      // The shared selection used to be cleared before the default was
      // ready: the switch failed, yet the next request already started on
      // the default provider.
      const alternates: ReturnType<typeof makeInnerBackend>[] = [];
      const defaults: ReturnType<typeof makeInnerBackend>[] = [];
      let failDefault = false;
      const makeProviders = () => [
        {
          name: 'default',
          description: 'd',
          connect: async (): Promise<any> => {
            if (failDefault)
              return await failingDefault();
            const inner = makeInnerBackend('tool_default');
            defaults.push(inner);
            return wrapInProcess(inner);
          },
        },
        {
          name: 'alternate',
          description: 'a',
          connect: async () => {
            const inner = makeInnerBackend('tool_alternate');
            alternates.push(inner);
            return wrapInProcess(inner);
          },
        },
      ];
      const shared: SharedProxySelection = { slot: new SharedClientSlot(), providers: makeProviders() };
      const backendContext = { notifyToolListChanged: vi.fn(async () => undefined) };
      const clientVersion = { name: 'vitest', version: '1.0.0' };
      const makeRequestBackend = () => new ProxyBackend(makeProviders(), shared);

      const request0 = makeRequestBackend();
      await request0.initialize(backendContext, clientVersion);
      expect((await request0.callTool('browser_connect', { name: 'alternate' })).isError).not.toBe(true);
      request0.serverClosed?.();

      const request1 = makeRequestBackend();
      await request1.initialize(backendContext, clientVersion);
      const defaultsBefore = defaults.length;
      failDefault = true;
      const failed = await request1.callTool('browser_connect', { name: 'default' });
      failDefault = false;
      expect(failed.isError).toBe(true);
      expect((failed.content?.[0] as any).text).toContain('default provider failed');

      // The first request after the failure still starts on the shared
      // selection...
      const request2 = makeRequestBackend();
      await request2.initialize(backendContext, clientVersion);
      expect((await request2.listTools()).map(tool => tool.name)).toContain('tool_alternate');
      // ...and so does the request whose switch failed.
      expect(((await request1.callTool('tool_alternate', {})).content?.[0] as any).text).toBe('tool_alternate');
      expect(alternates).toHaveLength(1);
      expect(alternates[0].closed).toBe(0);
      expect(defaults).toHaveLength(defaultsBefore);

      request1.serverClosed?.();
      request2.serverClosed?.();
      await shared.slot.dispose();
      expect(alternates[0].closed).toBe(1);
    });

    // A request can close while its own browser_connect is still connecting
    // the replacement, or still queued behind another switch.
    describe('closing a request during its switch', () => {
      function makeGatedSetup() {
        const alternates: ReturnType<typeof makeInnerBackend>[] = [];
        const handshake: { gate?: Promise<void>, entered: number, defaults: number } = { entered: 0, defaults: 0 };
        const makeProviders = () => [
          {
            name: 'default',
            description: 'd',
            connect: async () => {
              handshake.defaults++;
              return wrapInProcess(makeInnerBackend('tool_default'));
            },
          },
          {
            name: 'alternate',
            description: 'a',
            connect: async () => {
              handshake.entered++;
              if (handshake.gate)
                await handshake.gate;
              const inner = makeInnerBackend('tool_alternate');
              alternates.push(inner);
              return wrapInProcess(inner);
            },
          },
        ];
        // Pauses the next alternate handshakes until the returned callback runs.
        const holdHandshake = () => {
          let release!: () => void;
          handshake.gate = new Promise<void>(resolve => { release = resolve; });
          return () => {
            handshake.gate = undefined;
            release();
          };
        };
        const shared: SharedProxySelection = { slot: new SharedClientSlot(), providers: makeProviders() };
        const backendContext = { notifyToolListChanged: vi.fn(async () => undefined) };
        const clientVersion = { name: 'vitest', version: '1.0.0' };
        const makeRequestBackend = () => new ProxyBackend(makeProviders(), shared);
        return { shared, alternates, handshake, holdHandshake, backendContext, clientVersion, makeRequestBackend };
      }

      it('releases the replacement a switch publishes after its request closed', async () => {
        // serverClosed() used to release whatever was current at close time;
        // the switch then published the replacement with a lease nobody
        // released, so switching back to default retired it forever.
        const { alternates, handshake, holdHandshake, backendContext, clientVersion, makeRequestBackend, shared } = makeGatedSetup();

        const request1 = makeRequestBackend();
        await request1.initialize(backendContext, clientVersion);
        const releaseHandshake = holdHandshake();
        const switching = request1.callTool('browser_connect', { name: 'alternate' });
        await vi.waitFor(() => expect(handshake.entered).toBe(1));
        request1.serverClosed?.();
        releaseHandshake();
        // The switch still applies process-wide.
        expect((await switching).isError).not.toBe(true);

        const request2 = makeRequestBackend();
        await request2.initialize(backendContext, clientVersion);
        expect((await request2.listTools()).map(tool => tool.name)).toContain('tool_alternate');
        expect((await request2.callTool('browser_connect', { name: 'default' })).isError).not.toBe(true);
        await vi.waitFor(() => expect(alternates[0].closed).toBe(1));
        request2.serverClosed?.();
        await shared.slot.dispose();
        expect(alternates.map(inner => inner.closed)).toEqual([1]);
      });

      it('does not drop another request\'s lease when a closed request\'s switch settles', async () => {
        // serverClosed() released the adopted client, and the switch, which
        // had captured it as the client it replaces, released it again: the
        // second release took another request's lease and closed the client
        // under it.
        const { alternates, handshake, holdHandshake, backendContext, clientVersion, makeRequestBackend, shared } = makeGatedSetup();

        const request0 = makeRequestBackend();
        await request0.initialize(backendContext, clientVersion);
        await request0.callTool('browser_connect', { name: 'alternate' });

        const request1 = makeRequestBackend();
        await request1.initialize(backendContext, clientVersion);
        const releaseHandshake = holdHandshake();
        const switching = request1.callTool('browser_connect', { name: 'alternate' });
        await vi.waitFor(() => expect(handshake.entered).toBe(2));
        request1.serverClosed?.();
        releaseHandshake();
        expect((await switching).isError).not.toBe(true);
        expect(alternates).toHaveLength(2);
        await new Promise(resolve => setTimeout(resolve, 0));

        // request0 still holds its lease on the retired client and can use it.
        expect(alternates[0].closed).toBe(0);
        const result = await request0.callTool('tool_alternate', {});
        expect(result.isError).not.toBe(true);
        expect(alternates[0].calls).toContain('tool_alternate');
        request0.serverClosed?.();
        await vi.waitFor(() => expect(alternates[0].closed).toBe(1));

        // The replacement stayed published without a leftover lease: the next
        // switch back to default closes it.
        expect(alternates[1].closed).toBe(0);
        const request2 = makeRequestBackend();
        await request2.initialize(backendContext, clientVersion);
        expect((await request2.callTool('browser_connect', { name: 'default' })).isError).not.toBe(true);
        await vi.waitFor(() => expect(alternates[1].closed).toBe(1));
        request2.serverClosed?.();
        await shared.slot.dispose();
        expect(alternates.map(inner => inner.closed)).toEqual([1, 1]);
      });

      it('skips a switch queued behind another request\'s switch when its request closes', async () => {
        // The closed check ran only before the switch joined the process-wide
        // queue, so a request closed while queued there still connected its
        // provider and published it.
        const { alternates, handshake, holdHandshake, backendContext, clientVersion, makeRequestBackend, shared } = makeGatedSetup();

        const request0 = makeRequestBackend();
        await request0.initialize(backendContext, clientVersion);
        const request1 = makeRequestBackend();
        await request1.initialize(backendContext, clientVersion);
        const releaseHandshake = holdHandshake();
        const first = request0.callTool('browser_connect', { name: 'alternate' });
        await vi.waitFor(() => expect(handshake.entered).toBe(1));
        const queued = request1.callTool('browser_connect', { name: 'alternate' });
        await new Promise(resolve => setTimeout(resolve, 0));
        request1.serverClosed?.();
        releaseHandshake();

        expect((await first).isError).not.toBe(true);
        const skipped = await queued;
        expect(skipped.isError).toBe(true);
        expect((skipped.content?.[0] as any).text).toContain('closed before the switch could run');
        expect(handshake.entered).toBe(1);
        expect(alternates).toHaveLength(1);

        request0.serverClosed?.();
        await shared.slot.dispose();
        expect(alternates.map(inner => inner.closed)).toEqual([1]);
      });

      it('keeps the shared selection when a queued switch back to the default belongs to a closed request', async () => {
        const { alternates, handshake, holdHandshake, backendContext, clientVersion, makeRequestBackend, shared } = makeGatedSetup();

        const request0 = makeRequestBackend();
        await request0.initialize(backendContext, clientVersion);
        const request1 = makeRequestBackend();
        await request1.initialize(backendContext, clientVersion);
        const defaultsBefore = handshake.defaults;
        const releaseHandshake = holdHandshake();
        const first = request0.callTool('browser_connect', { name: 'alternate' });
        await vi.waitFor(() => expect(handshake.entered).toBe(1));
        const queued = request1.callTool('browser_connect', { name: 'default' });
        await new Promise(resolve => setTimeout(resolve, 0));
        request1.serverClosed?.();
        releaseHandshake();

        expect((await first).isError).not.toBe(true);
        expect((await queued).isError).toBe(true);
        expect(handshake.defaults).toBe(defaultsBefore);

        // request0's alternate selection is still in force for new requests.
        const request2 = makeRequestBackend();
        await request2.initialize(backendContext, clientVersion);
        expect((await request2.listTools()).map(tool => tool.name)).toContain('tool_alternate');
        expect(alternates[0].closed).toBe(0);
        request0.serverClosed?.();
        request2.serverClosed?.();
        await shared.slot.dispose();
        expect(alternates.map(inner => inner.closed)).toEqual([1]);
      });

      it('skips a switch still queued when its request closes', async () => {
        const { alternates, handshake, holdHandshake, backendContext, clientVersion, makeRequestBackend, shared } = makeGatedSetup();

        const request1 = makeRequestBackend();
        await request1.initialize(backendContext, clientVersion);
        const releaseHandshake = holdHandshake();
        const first = request1.callTool('browser_connect', { name: 'alternate' });
        await vi.waitFor(() => expect(handshake.entered).toBe(1));
        const queued = request1.callTool('browser_connect', { name: 'alternate' });
        request1.serverClosed?.();
        releaseHandshake();

        expect((await first).isError).not.toBe(true);
        const skipped = await queued;
        expect(skipped.isError).toBe(true);
        expect((skipped.content?.[0] as any).text).toContain('closed before the switch could run');
        expect(handshake.entered).toBe(1);
        expect(alternates).toHaveLength(1);

        // Only the first switch's replacement is published, and no lease on
        // it is left behind.
        const request2 = makeRequestBackend();
        await request2.initialize(backendContext, clientVersion);
        expect((await request2.callTool('browser_connect', { name: 'default' })).isError).not.toBe(true);
        await vi.waitFor(() => expect(alternates[0].closed).toBe(1));
        request2.serverClosed?.();
        await shared.slot.dispose();
        expect(alternates.map(inner => inner.closed)).toEqual([1]);
      });
    });
  });
});
