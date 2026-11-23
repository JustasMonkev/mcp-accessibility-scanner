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
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { BrowserSessionRegistry } from '../src/browserSessions.js';
import { outputFile, resolveConfig } from '../src/config.js';
import { Context } from '../src/context.js';
import { SharedClientSlot } from '../src/mcp/sharedClientSlot.js';
import { wrapInProcess } from '../src/mcp/server.js';
import { VSCodeProxyBackend } from '../src/vscode/host.js';

// A minimal browser-context factory, matching the one in
// browserSessions.test.ts: enough for browser_tabs to run without a browser.
function makeFakeContextFactory(sessionsUnsupportedReason?: string) {
  const createContext = vi.fn(async (..._args: any[]) => {
    const browserContext: any = new EventEmitter();
    browserContext.newPage = vi.fn(async () => {
      // Like Playwright, announce the page through 'page' so its tab registers.
      const page = Object.assign(new EventEmitter(), { setDefaultNavigationTimeout: vi.fn(), setDefaultTimeout: vi.fn(), url: () => 'about:blank' });
      browserContext.emit('page', page);
      return page;
    });
    browserContext.pages = vi.fn().mockReturnValue([]);
    browserContext.route = vi.fn().mockResolvedValue(undefined);
    return { browserContext, close: vi.fn().mockResolvedValue(undefined) };
  });
  return { createContext, sessionsUnsupportedReason } as any;
}

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

describe('VSCodeProxyBackend', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Context.disposeAll();
  });

  it('notifies clients when the exposed tool list changes after switching clients', async () => {
    const defaultInner = makeInnerBackend('scan_page');
    const child = makeInnerBackend('audit_site');
    const defaultListTools = vi.spyOn(defaultInner, 'listTools');
    const childListTools = vi.spyOn(child, 'listTools');
    const backend = new VSCodeProxyBackend(await resolveConfig({}), async () => wrapInProcess(defaultInner));
    const context = { notifyToolListChanged: vi.fn(async () => undefined) };
    await backend.initialize(context, { name: 'vitest', version: '1.0.0' });
    vi.spyOn(backend as any, '_createSwitchTransport').mockImplementation(async () => wrapInProcess(child));

    const switched = await backend.callTool('browser_connect', { connectionString: 'ws://127.0.0.1:1234/', lib: 'playwright' });

    expect(switched.isError).not.toBe(true);
    expect(defaultInner.closed).toBe(1);
    expect(defaultListTools).not.toHaveBeenCalled();
    expect(childListTools).not.toHaveBeenCalled();
    expect(context.notifyToolListChanged).toHaveBeenCalledTimes(1);
    backend.serverClosed?.();
  });

  // A switch connects the replacement before publishing it and only then
  // closes the provider it replaced: a failed handshake must not strand the
  // connection without the provider that was working.
  describe('switching the per-connection provider', () => {
    const connectArgs = { connectionString: 'ws://127.0.0.1:1234/', lib: 'playwright' };

    async function makeBackend() {
      const defaultInner = makeInnerBackend('tool_default');
      const backend = new VSCodeProxyBackend(await resolveConfig({}), async () => wrapInProcess(defaultInner));
      const context = { notifyToolListChanged: vi.fn(async () => undefined) };
      await backend.initialize(context, { name: 'vitest', version: '1.0.0' });
      return { backend, defaultInner, context };
    }

    const refusingTransport = () => ({
      start: async () => {
        throw new Error('handshake refused');
      },
      send: async () => {},
      close: async () => {},
    });

    it('keeps the working provider when the replacement handshake fails', async () => {
      const { backend, defaultInner, context } = await makeBackend();
      vi.spyOn(backend as any, '_createSwitchTransport').mockImplementation(async () => refusingTransport());

      await expect(backend.callTool('browser_connect', connectArgs)).rejects.toThrow('handshake refused');

      expect(defaultInner.closed).toBe(0);
      expect(context.notifyToolListChanged).not.toHaveBeenCalled();
      const after = await backend.callTool('tool_default', {});
      expect((after.content?.[0] as any).text).toBe('tool_default');
      expect(defaultInner.calls).toEqual(['tool_default']);
      backend.serverClosed?.();
      await vi.waitFor(() => expect(defaultInner.closed).toBe(1));
    });

    it('serves from the working provider while a replacement connects, and applies overlapping switches in call order', async () => {
      const { backend, defaultInner } = await makeBackend();
      const first = makeInnerBackend('tool_first');
      const second = makeInnerBackend('tool_second');
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
      const firstTransport = await wrapInProcess(first);
      const gatedStart = firstTransport.start.bind(firstTransport);
      firstTransport.start = async () => {
        await firstGate;
        await gatedStart();
      };
      vi.spyOn(backend as any, '_createSwitchTransport')
          .mockImplementationOnce(async () => firstTransport)
          .mockImplementationOnce(async () => wrapInProcess(second));

      const switchingFirst = backend.callTool('browser_connect', connectArgs);
      const switchingSecond = backend.callTool('browser_connect', connectArgs);
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

    it('lets a call routed to the working provider finish when the replacement handshake completes first, then closes it', async () => {
      // An owned provider was published without a lease, so the replacement
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
      const backend = new VSCodeProxyBackend(await resolveConfig({}), async () => wrapInProcess(defaultInner));
      await backend.initialize({ notifyToolListChanged: vi.fn(async () => undefined) }, { name: 'vitest', version: '1.0.0' });
      const child = makeInnerBackend('tool_child');
      let releaseHandshake!: () => void;
      const handshakeGate = new Promise<void>(resolve => { releaseHandshake = resolve; });
      const childTransport = await wrapInProcess(child);
      const start = childTransport.start.bind(childTransport);
      childTransport.start = async () => {
        await handshakeGate;
        await start();
      };
      vi.spyOn(backend as any, '_createSwitchTransport').mockImplementation(async () => childTransport);

      const switching = backend.callTool('browser_connect', connectArgs);
      const inFlight = backend.callTool('tool_default', {});
      await vi.waitFor(() => expect(callStarted).toBe(true));

      releaseHandshake();
      expect((await switching).isError).not.toBe(true);
      const fresh = await backend.callTool('tool_child', {});
      expect((fresh.content?.[0] as any).text).toBe('tool_child');
      expect(defaultInner.closed).toBe(0);

      releaseCall();
      const result = await inFlight;
      expect(result.isError).not.toBe(true);
      expect((result.content?.[0] as any).text).toBe('late result');
      await vi.waitFor(() => expect(defaultInner.closed).toBe(1));
      backend.serverClosed?.();
      await vi.waitFor(() => expect(child.closed).toBe(1));
    });

    it('keeps the working provider when an overlapping switch fails, and applies the one that succeeds', async () => {
      const { backend, defaultInner } = await makeBackend();
      const second = makeInnerBackend('tool_second');
      vi.spyOn(backend as any, '_createSwitchTransport')
          .mockImplementationOnce(async () => refusingTransport())
          .mockImplementationOnce(async () => wrapInProcess(second));

      const [failed, succeeded] = await Promise.allSettled([
        backend.callTool('browser_connect', connectArgs),
        backend.callTool('browser_connect', connectArgs),
      ]);

      expect(failed.status).toBe('rejected');
      expect(succeeded.status).toBe('fulfilled');
      const after = await backend.callTool('tool_second', {});
      expect((after.content?.[0] as any).text).toBe('tool_second');
      expect(defaultInner.closed).toBe(1);
      backend.serverClosed?.();
    });
  });

  it('serializes the resolved fallback output dir into the spawned provider config', async () => {
    // The fallback output dir is memoized on the config OBJECT; the JSON
    // round-trip into the spawned VS Code provider mints a new object, so an
    // unmaterialized config gave the child a second temp root and scattered
    // one run's artifacts across the provider switch.
    const config = await resolveConfig({ server: { authToken: 'child-argv-secret' } });
    const parentFile = await outputFile(config, 'parent.txt');

    const backend = new VSCodeProxyBackend(config, vi.fn(async () => ({ id: 'default-transport' } as any)));
    const setCurrentClient = vi.spyOn(backend as any, '_setCurrentClient').mockResolvedValue(undefined);

    await backend.callTool('browser_connect', { connectionString: 'ws://127.0.0.1:1234/', lib: 'playwright' });

    expect(setCurrentClient).toHaveBeenCalledTimes(1);
    const transport = setCurrentClient.mock.calls[0][0] as any;
    const childConfig = JSON.parse(transport._serverParams.args[1]);
    expect(childConfig.outputDir).toBe(path.dirname(parentFile));
    expect(childConfig.server?.authToken).toBeUndefined();
    expect(JSON.stringify(transport._serverParams.args)).not.toContain('child-argv-secret');
    // The deserialized child config writes into the parent's directory.
    const childFile = await outputFile(childConfig, 'child.txt');
    expect(path.dirname(childFile)).toBe(path.dirname(parentFile));
  });

  it.each(['1', 'true', 'yes', '', undefined])('passes remote opt-in %s to the real child without leaking other settings', async optIn => {
    vi.stubEnv('PLAYWRIGHT_MCP_VSCODE_ALLOW_REMOTE', optIn);
    vi.stubEnv('PLAYWRIGHT_MCP_AUTH_TOKEN', 'parent-only-secret');
    const backend = new VSCodeProxyBackend(await resolveConfig({}), vi.fn());
    const transport = await (backend as any)._createSwitchTransport('ws://localhost:1234/', 'playwright');
    // Probe the real transport's child environment without starting a browser.
    transport._serverParams.args = ['-e', `console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{optIn:process.env.PLAYWRIGHT_MCP_VSCODE_ALLOW_REMOTE,secret:process.env.PLAYWRIGHT_MCP_AUTH_TOKEN}}))`];
    const message = new Promise(resolve => { transport.onmessage = resolve; });
    try {
      await transport.start();
      await expect(message).resolves.toEqual({ jsonrpc: '2.0', id: 1, result: { optIn: optIn ?? '' } });
    } finally {
      await transport.close();
    }
  });

  it('rejects a profile-conflicted browser_connect without tearing down the working provider', async () => {
    // The child's factory would only surface the --storage-state plus
    // --user-data-dir contradiction on its first browser operation — after
    // the working provider was already closed, stranding the session on a
    // provider that can never create a context.
    const config = {
      browser: {
        userDataDir: '/home/user/my-profile',
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    };
    const backend = new VSCodeProxyBackend(config as any, vi.fn(async () => ({ id: 'default-transport' } as any)));

    const close = vi.fn(async () => undefined);
    const callTool = vi.fn(async () => ({ content: [] }));
    (backend as any)._currentClient = {
      listTools: vi.fn(async () => ({ tools: [{ name: 'scan_page' }] })),
      callTool,
      close,
    };

    const result = await backend.callTool('browser_connect', { connectionString: 'ws://127.0.0.1:1234/', lib: 'playwright' });

    expect(result.isError).toBe(true);
    expect(String((result.content as any[])[0].text)).toContain('contradict each other');
    // The working provider was neither closed nor replaced: regular tools
    // still route to it.
    expect(close).not.toHaveBeenCalled();
    await backend.callTool('scan_page', {});
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it.each([{ lib: 0 }, { connectionString: 123, lib: 'playwright' }])('rejects mistyped browser_connect arguments %o without disconnecting', async args => {
    const defaultTransportFactory = vi.fn();
    const backend = new VSCodeProxyBackend(await resolveConfig({}), defaultTransportFactory);
    const close = vi.fn(async () => undefined);
    (backend as any)._currentClient = { close };

    await expect(backend.callTool('browser_connect', args)).rejects.toThrow(/^Invalid input for tool "browser_connect":\n/);

    expect(close).not.toHaveBeenCalled();
    expect(defaultTransportFactory).not.toHaveBeenCalled();
  });

  it.each([
    { connectionString: 'ws://127.0.0.1:1234/' },
    { lib: 'playwright' },
    { connectionString: '', lib: 'playwright' },
    { connectionString: 'ws://127.0.0.1:1234/', lib: '' },
    { connectionString: '   ', lib: 'playwright' },
    { connectionString: 'ws://127.0.0.1:1234/', lib: ' \t' },
    { connectionString: ' ', lib: ' ' },
  ])('rejects partial or blank browser_connect arguments %o and keeps the working provider', async args => {
    const defaultInner = makeInnerBackend('tool_default');
    const defaultTransportFactory = vi.fn(async () => wrapInProcess(defaultInner));
    const backend = new VSCodeProxyBackend(await resolveConfig({}), defaultTransportFactory);
    const context = { notifyToolListChanged: vi.fn(async () => undefined) };
    await backend.initialize(context, { name: 'vitest', version: '1.0.0' });
    const createSwitchTransport = vi.spyOn(backend as any, '_createSwitchTransport');

    const result = await backend.callTool('browser_connect', args);

    expect(result.isError).toBe(true);
    expect((result.content?.[0] as any).text).toContain('needs both `connectionString` and `lib`');
    expect((result.content?.[0] as any).text).not.toContain('disconnected');
    expect(defaultTransportFactory).toHaveBeenCalledTimes(1);
    expect(createSwitchTransport).not.toHaveBeenCalled();
    expect(context.notifyToolListChanged).not.toHaveBeenCalled();
    expect(defaultInner.closed).toBe(0);
    const after = await backend.callTool('tool_default', {});
    expect((after.content?.[0] as any).text).toBe('tool_default');
    backend.serverClosed?.();
  });

  it('treats an empty browser_connect request as an intentional disconnect', async () => {
    const defaults: ReturnType<typeof makeInnerBackend>[] = [];
    const backend = new VSCodeProxyBackend(await resolveConfig({}), async () => {
      const inner = makeInnerBackend('tool_default');
      defaults.push(inner);
      return wrapInProcess(inner);
    });
    await backend.initialize({ notifyToolListChanged: vi.fn(async () => undefined) }, { name: 'vitest', version: '1.0.0' });

    const result = await backend.callTool('browser_connect', {});

    expect(result.isError).not.toBe(true);
    expect((result.content?.[0] as any).text).toContain('Successfully disconnected');
    expect(defaults).toHaveLength(2);
    expect(defaults[0].closed).toBe(1);
    backend.serverClosed?.();
  });

  it('rejects a browser_connect request with only unknown fields instead of disconnecting', async () => {
    // Parsing strips unknown keys, so `{ name: 'extension' }` used to reach
    // the empty-request branch as `{}` and disconnect the working provider
    // while reporting success.
    const defaults: ReturnType<typeof makeInnerBackend>[] = [];
    const backend = new VSCodeProxyBackend(await resolveConfig({}), async () => {
      const inner = makeInnerBackend('tool_default');
      defaults.push(inner);
      return wrapInProcess(inner);
    });
    const context = { notifyToolListChanged: vi.fn(async () => undefined) };
    await backend.initialize(context, { name: 'vitest', version: '1.0.0' });

    const result = await backend.callTool('browser_connect', { name: 'extension' });

    expect(result.isError).toBe(true);
    expect((result.content?.[0] as any).text).toContain('`name`');
    expect(defaults).toHaveLength(1);
    expect(defaults[0].closed).toBe(0);
    expect(context.notifyToolListChanged).not.toHaveBeenCalled();
    const after = await backend.callTool('tool_default', {});
    expect((after.content?.[0] as any).text).toBe('tool_default');
    backend.serverClosed?.();
  });

  it('keeps session handles at the host across a browser_connect provider switch', async () => {
    // The switched VS Code provider is a separate server process whose
    // BrowserServerBackend builds its own registry — forwarding handle-routed
    // calls there answered "Unknown browserSessionId" while the session's
    // context stayed alive in the host until its TTL. Session traffic must
    // resolve against the host's registry regardless of the selected
    // provider; only session-less traffic follows the switch.
    const config = await resolveConfig({});
    const registry = new BrowserSessionRegistry();
    const factory = makeFakeContextFactory();
    const backend = new VSCodeProxyBackend(
        config,
        async () => wrapInProcess(new BrowserServerBackend(config, factory, registry)),
    );
    await backend.initialize(
        { notifyToolListChanged: async () => {} },
        { name: 'vitest', version: '1.0.0' },
    );

    const opened = await backend.callTool('browser_session_open', {});
    expect(opened.isError).not.toBe(true);
    const id = (opened.structuredContent as any)?.browserSessionId;
    expect(id).toMatch(/^bs_/);

    // The switched child mirrors main.ts: its own backend, its own registry,
    // and a factory that vetoes sessions like VSCodeBrowserContextFactory.
    const childBackend = new BrowserServerBackend(
        config,
        makeFakeContextFactory('the VS Code extension supplies the browser\'s existing context.'),
    );
    const childCallTool = vi.spyOn(childBackend, 'callTool');
    vi.spyOn(backend as any, '_createSwitchTransport').mockImplementation(async () => wrapInProcess(childBackend));
    const switched = await backend.callTool('browser_connect', { connectionString: 'ws://127.0.0.1:1234/', lib: 'playwright' });
    expect(switched.isError).not.toBe(true);

    // Session-less traffic follows the switch...
    await backend.callTool('browser_tabs', { action: 'list' });
    expect(childCallTool).toHaveBeenCalledWith('browser_tabs', { action: 'list' }, expect.anything());

    // ...while handle-routed calls keep resolving at the host...
    const routed = await backend.callTool('browser_tabs', { action: 'list', browserSessionId: id });
    expect(routed.isError).not.toBe(true);

    // ...opening a new session works despite the child's veto (host-minted)...
    const openedWhileSwitched = await backend.callTool('browser_session_open', {});
    expect(openedWhileSwitched.isError).not.toBe(true);
    const idWhileSwitched = (openedWhileSwitched.structuredContent as any)?.browserSessionId;
    expect(idWhileSwitched).toMatch(/^bs_/);

    // ...and both handles close cleanly instead of "Unknown browserSessionId".
    for (const handle of [id, idWhileSwitched]) {
      const closed = await backend.callTool('browser_session_close', { browserSessionId: handle });
      expect(closed.isError).not.toBe(true);
    }
    // None of the session traffic leaked into the switched provider.
    expect(childCallTool.mock.calls.every(([name, args]) =>
      name !== 'browser_session_open' && name !== 'browser_session_close' && (args as any)?.browserSessionId === undefined)).toBe(true);

    backend.serverClosed?.();
  });

  // Stateless HTTP serves every handshake-free POST with a throwaway
  // VSCodeProxyBackend; a browser_connect switch must therefore be published
  // process-wide, or it reports success while the child it launched is killed
  // with the response and the next request reverts to the default provider.
  describe('process-scoped provider selection for stateless serving', () => {
    async function makeSharedSetup() {
      const config = await resolveConfig({});
      const slot = new SharedClientSlot();
      const defaults: ReturnType<typeof makeInnerBackend>[] = [];
      const defaultTransportFactory = async () => {
        const inner = makeInnerBackend('tool_default');
        defaults.push(inner);
        return await wrapInProcess(inner);
      };
      const backendContext = { notifyToolListChanged: vi.fn(async () => undefined) };
      const clientVersion = { name: 'vitest', version: '1.0.0' };
      const makeRequestBackend = () => new VSCodeProxyBackend(config, defaultTransportFactory, slot);
      return { config, slot, defaults, backendContext, clientVersion, makeRequestBackend };
    }

    it('keeps a browser_connect switch in force for later per-request backends', async () => {
      const { defaults, backendContext, clientVersion, makeRequestBackend } = await makeSharedSetup();
      const child = makeInnerBackend('tool_child');

      const request1 = makeRequestBackend();
      await request1.initialize(backendContext, clientVersion);
      vi.spyOn(request1 as any, '_createSwitchTransport').mockImplementation(() => wrapInProcess(child));
      const switched = await request1.callTool('browser_connect', { connectionString: 'ws://127.0.0.1:1234/', lib: 'playwright' });
      expect(switched.isError).not.toBe(true);
      // Response cleanup of the switching request must not tear down the
      // process-scoped child client.
      request1.serverClosed?.();
      expect(child.closed).toBe(0);

      const request2 = makeRequestBackend();
      await request2.initialize(backendContext, clientVersion);
      const result = await request2.callTool('tool_child', {});
      expect((result.content?.[0] as any).text).toBe('tool_child');
      expect(child.calls).toContain('tool_child');
      request2.serverClosed?.();
      expect(child.closed).toBe(0);

      // Disconnecting closes the shared child exactly once and returns later
      // requests to the per-request default provider.
      const request3 = makeRequestBackend();
      await request3.initialize(backendContext, clientVersion);
      const disconnected = await request3.callTool('browser_connect', {});
      expect(disconnected.isError).not.toBe(true);
      expect(child.closed).toBe(1);
      request3.serverClosed?.();
      expect(child.closed).toBe(1);

      const request4 = makeRequestBackend();
      await request4.initialize(backendContext, clientVersion);
      await request4.callTool('tool_default', {});
      expect(defaults.at(-1)!.calls).toContain('tool_default');
    });

    it('applies a switch that overlaps a still-connecting disconnect without stranding a closed client', async () => {
      // The shared publication used to set the current client and then queue
      // the owned-slot clear behind the owned default replacement still
      // connecting; that replacement published itself, and the queued clear
      // then closed it, leaving the backend pointed at a closed client.
      const config = await resolveConfig({});
      const slot = new SharedClientSlot();
      const defaults: ReturnType<typeof makeInnerBackend>[] = [];
      let gate: Promise<void> | undefined;
      const backend = new VSCodeProxyBackend(config, async () => {
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
      }, slot);
      await backend.initialize({ notifyToolListChanged: vi.fn(async () => undefined) }, { name: 'vitest', version: '1.0.0' });
      const child = makeInnerBackend('tool_child');
      vi.spyOn(backend as any, '_createSwitchTransport').mockImplementation(() => wrapInProcess(child));

      let releaseDefault!: () => void;
      gate = new Promise<void>(resolve => { releaseDefault = resolve; });
      const disconnecting = backend.callTool('browser_connect', {});
      await vi.waitFor(() => expect(defaults).toHaveLength(2));
      gate = undefined;
      const switching = backend.callTool('browser_connect', { connectionString: 'ws://127.0.0.1:1234/', lib: 'playwright' });
      await new Promise(resolve => setTimeout(resolve, 10));

      releaseDefault();
      expect((await disconnecting).isError).not.toBe(true);
      expect((await switching).isError).not.toBe(true);

      const result = await backend.callTool('tool_child', {});
      expect(result.isError).not.toBe(true);
      expect((result.content?.[0] as any).text).toBe('tool_child');
      expect(child.closed).toBe(0);
      await vi.waitFor(() => expect(defaults.map(inner => inner.closed)).toEqual([1, 1]));
      backend.serverClosed?.();
      await slot.dispose();
    });

    it('does not probe a shared provider while publishing its switch', async () => {
      const { slot, backendContext, clientVersion, makeRequestBackend } = await makeSharedSetup();
      const child = makeInnerBackend('tool_child');
      child.listTools = vi.fn(async () => { throw new Error('browser endpoint is not live yet'); });
      const request = makeRequestBackend();
      await request.initialize(backendContext, clientVersion);
      vi.spyOn(request as any, '_createSwitchTransport').mockImplementation(() => wrapInProcess(child));

      const switched = await request.callTool('browser_connect', { connectionString: 'ws://127.0.0.1:9/never-connected', lib: 'playwright' });

      expect(switched.isError).not.toBe(true);
      expect(child.listTools).not.toHaveBeenCalled();
      request.serverClosed?.();
      await slot.dispose();
    });

    // A request can close while its own browser_connect is still connecting
    // the replacement, or still queued behind another switch.
    describe('closing a request during its switch', () => {
      const connectArgs = { connectionString: 'ws://127.0.0.1:1234/', lib: 'playwright' };

      async function makeGatedSetup() {
        const config = await resolveConfig({});
        const slot = new SharedClientSlot();
        const children: ReturnType<typeof makeInnerBackend>[] = [];
        const defaults: { inner: ReturnType<typeof makeInnerBackend>, started: boolean }[] = [];
        const handshake: { childGate?: Promise<void>, defaultGate?: Promise<void>, childEntered: number, defaultEntered: number } = { childEntered: 0, defaultEntered: 0 };
        const defaultTransportFactory = async () => {
          handshake.defaultEntered++;
          if (handshake.defaultGate)
            await handshake.defaultGate;
          const entry = { inner: makeInnerBackend('tool_default'), started: false };
          defaults.push(entry);
          const transport = await wrapInProcess(entry.inner);
          const start = transport.start.bind(transport);
          transport.start = async () => {
            entry.started = true;
            await start();
          };
          return transport;
        };
        // Pauses the next child (or default) handshakes until the returned
        // callback runs.
        const hold = (key: 'childGate' | 'defaultGate') => {
          let release!: () => void;
          handshake[key] = new Promise<void>(resolve => { release = resolve; });
          return () => {
            handshake[key] = undefined;
            release();
          };
        };
        const backendContext = { notifyToolListChanged: vi.fn(async () => undefined) };
        const clientVersion = { name: 'vitest', version: '1.0.0' };
        const makeRequestBackend = () => {
          const backend = new VSCodeProxyBackend(config, defaultTransportFactory, slot);
          vi.spyOn(backend as any, '_createSwitchTransport').mockImplementation(async () => {
            handshake.childEntered++;
            if (handshake.childGate)
              await handshake.childGate;
            const inner = makeInnerBackend('tool_child');
            children.push(inner);
            return await wrapInProcess(inner);
          });
          return backend;
        };
        return { slot, children, defaults, handshake, hold, backendContext, clientVersion, makeRequestBackend };
      }

      it('releases the replacement a switch publishes after its request closed', async () => {
        const { slot, children, handshake, hold, backendContext, clientVersion, makeRequestBackend } = await makeGatedSetup();

        const request1 = makeRequestBackend();
        await request1.initialize(backendContext, clientVersion);
        const releaseHandshake = hold('childGate');
        const switching = request1.callTool('browser_connect', connectArgs);
        await vi.waitFor(() => expect(handshake.childEntered).toBe(1));
        request1.serverClosed?.();
        releaseHandshake();
        // The switch still applies process-wide.
        expect((await switching).isError).not.toBe(true);

        const request2 = makeRequestBackend();
        await request2.initialize(backendContext, clientVersion);
        expect((await request2.callTool('tool_child', {})).isError).not.toBe(true);
        expect((await request2.callTool('browser_connect', {})).isError).not.toBe(true);
        await vi.waitFor(() => expect(children[0].closed).toBe(1));
        request2.serverClosed?.();
        await slot.dispose();
        expect(children.map(inner => inner.closed)).toEqual([1]);
      });

      it('does not drop another request\'s lease when a closed request\'s switch settles', async () => {
        const { slot, children, handshake, hold, backendContext, clientVersion, makeRequestBackend } = await makeGatedSetup();

        const request0 = makeRequestBackend();
        await request0.initialize(backendContext, clientVersion);
        await request0.callTool('browser_connect', connectArgs);

        const request1 = makeRequestBackend();
        await request1.initialize(backendContext, clientVersion);
        const releaseHandshake = hold('childGate');
        const switching = request1.callTool('browser_connect', connectArgs);
        await vi.waitFor(() => expect(handshake.childEntered).toBe(2));
        request1.serverClosed?.();
        releaseHandshake();
        expect((await switching).isError).not.toBe(true);
        expect(children).toHaveLength(2);
        await new Promise(resolve => setTimeout(resolve, 0));

        // request0 still holds its lease on the retired child and can use it.
        expect(children[0].closed).toBe(0);
        expect((await request0.callTool('tool_child', {})).isError).not.toBe(true);
        expect(children[0].calls).toContain('tool_child');
        request0.serverClosed?.();
        await vi.waitFor(() => expect(children[0].closed).toBe(1));

        // The replacement stayed published without a leftover lease.
        expect(children[1].closed).toBe(0);
        const request2 = makeRequestBackend();
        await request2.initialize(backendContext, clientVersion);
        expect((await request2.callTool('browser_connect', {})).isError).not.toBe(true);
        await vi.waitFor(() => expect(children[1].closed).toBe(1));
        request2.serverClosed?.();
        await slot.dispose();
        expect(children.map(inner => inner.closed)).toEqual([1, 1]);
      });

      it('neither double-releases nor opens a default provider for a disconnect that settles after its request closed', async () => {
        const { slot, children, defaults, handshake, hold, backendContext, clientVersion, makeRequestBackend } = await makeGatedSetup();

        const request0 = makeRequestBackend();
        await request0.initialize(backendContext, clientVersion);
        await request0.callTool('browser_connect', connectArgs);

        const request1 = makeRequestBackend();
        await request1.initialize(backendContext, clientVersion);
        const defaultsBefore = handshake.defaultEntered;
        const releaseDefault = hold('defaultGate');
        const disconnecting = request1.callTool('browser_connect', {});
        await vi.waitFor(() => expect(handshake.defaultEntered).toBe(defaultsBefore + 1));
        request1.serverClosed?.();
        releaseDefault();
        expect((await disconnecting).isError).not.toBe(true);
        await new Promise(resolve => setTimeout(resolve, 0));

        // request0's lease keeps the retired child open until it closes.
        expect(children[0].closed).toBe(0);
        expect((await request0.callTool('tool_child', {})).isError).not.toBe(true);
        request0.serverClosed?.();
        await vi.waitFor(() => expect(children[0].closed).toBe(1));

        // No default provider was connected into the closed request's
        // disposed slot; every one that started was closed.
        await slot.dispose();
        await vi.waitFor(() => expect(defaults.filter(entry => entry.started).map(entry => entry.inner.closed)).toEqual(defaults.filter(entry => entry.started).map(() => 1)));
        expect(defaults.at(-1)!.started).toBe(false);
      });

      it('skips a switch still queued when its request closes', async () => {
        const { slot, children, handshake, hold, backendContext, clientVersion, makeRequestBackend } = await makeGatedSetup();

        const request1 = makeRequestBackend();
        await request1.initialize(backendContext, clientVersion);
        const releaseHandshake = hold('childGate');
        const first = request1.callTool('browser_connect', connectArgs);
        await vi.waitFor(() => expect(handshake.childEntered).toBe(1));
        const queued = request1.callTool('browser_connect', connectArgs);
        request1.serverClosed?.();
        releaseHandshake();

        expect((await first).isError).not.toBe(true);
        await expect(queued).rejects.toThrow('closed before the switch could run');
        expect(handshake.childEntered).toBe(1);
        expect(children).toHaveLength(1);

        // Only the first switch's replacement is published, and no lease on
        // it is left behind.
        const request2 = makeRequestBackend();
        await request2.initialize(backendContext, clientVersion);
        expect((await request2.callTool('browser_connect', {})).isError).not.toBe(true);
        await vi.waitFor(() => expect(children[0].closed).toBe(1));
        request2.serverClosed?.();
        await slot.dispose();
        expect(children.map(inner => inner.closed)).toEqual([1]);
      });
    });
  });
});
