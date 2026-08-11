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

import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { outputFile, resolveConfig } from '../src/config.js';
import { SharedClientSlot } from '../src/mcp/sharedClientSlot.js';
import { wrapInProcess } from '../src/mcp/server.js';
import { VSCodeProxyBackend } from '../src/vscode/host.js';

describe('VSCodeProxyBackend', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('notifies clients when the exposed tool list changes after switching clients', async () => {
    const backend = new VSCodeProxyBackend({} as any, vi.fn(async () => ({ id: 'default-transport' } as any)));

    const close = vi.fn(async () => undefined);
    (backend as any)._currentClient = {
      listTools: vi.fn(async () => ({ tools: [{ name: 'scan_page' }] })),
      close,
    };
    (backend as any)._backendContext = {
      notifyToolListChanged: vi.fn(async () => undefined),
    };
    (backend as any)._clientVersion = { name: 'vitest', version: '1.0.0' };

    vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({
      tools: [{ name: 'audit_site' }] as any[],
    } as any);

    await (backend as any)._setCurrentClient({ id: 'alternate-transport' } as any, true);

    expect(close).toHaveBeenCalledTimes(1);
    expect((backend as any)._backendContext.notifyToolListChanged).toHaveBeenCalledTimes(1);
  });

  it('serializes the resolved fallback output dir into the spawned provider config', async () => {
    // The fallback output dir is memoized on the config OBJECT; the JSON
    // round-trip into the spawned VS Code provider mints a new object, so an
    // unmaterialized config gave the child a second temp root and scattered
    // one run's artifacts across the provider switch.
    const config = await resolveConfig({});
    const parentFile = await outputFile(config, 'parent.txt');

    const backend = new VSCodeProxyBackend(config, vi.fn(async () => ({ id: 'default-transport' } as any)));
    const setCurrentClient = vi.spyOn(backend as any, '_setCurrentClient').mockResolvedValue(undefined);

    await backend.callTool('browser_connect', { connectionString: 'ws://127.0.0.1:1234/', lib: 'playwright' });

    expect(setCurrentClient).toHaveBeenCalledTimes(1);
    const transport = setCurrentClient.mock.calls[0][0] as any;
    const childConfig = JSON.parse(transport._serverParams.args[1]);
    expect(childConfig.outputDir).toBe(path.dirname(parentFile));
    // The deserialized child config writes into the parent's directory.
    const childFile = await outputFile(childConfig, 'child.txt');
    expect(path.dirname(childFile)).toBe(path.dirname(parentFile));
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

  // Stateless HTTP serves every handshake-free POST with a throwaway
  // VSCodeProxyBackend; a browser_connect switch must therefore be published
  // process-wide, or it reports success while the child it launched is killed
  // with the response and the next request reverts to the default provider.
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

    async function makeSharedSetup() {
      const config = await resolveConfig({});
      const slot = new SharedClientSlot();
      const defaults: ReturnType<typeof makeInnerBackend>[] = [];
      const defaultTransportFactory = async () => {
        const inner = makeInnerBackend('tool_default');
        defaults.push(inner);
        return await wrapInProcess(inner as any);
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
      await request1.initialize(backendContext as any, clientVersion);
      vi.spyOn(request1 as any, '_createSwitchTransport').mockImplementation(() => wrapInProcess(child as any));
      const switched = await request1.callTool('browser_connect', { connectionString: 'ws://127.0.0.1:1234/', lib: 'playwright' });
      expect(switched.isError).not.toBe(true);
      // Response cleanup of the switching request must not tear down the
      // process-scoped child client.
      request1.serverClosed?.();
      expect(child.closed).toBe(0);

      const request2 = makeRequestBackend();
      await request2.initialize(backendContext as any, clientVersion);
      const result = await request2.callTool('tool_child', {});
      expect((result.content?.[0] as any).text).toBe('tool_child');
      expect(child.calls).toContain('tool_child');
      request2.serverClosed?.();
      expect(child.closed).toBe(0);

      // Disconnecting closes the shared child exactly once and returns later
      // requests to the per-request default provider.
      const request3 = makeRequestBackend();
      await request3.initialize(backendContext as any, clientVersion);
      const disconnected = await request3.callTool('browser_connect', {});
      expect(disconnected.isError).not.toBe(true);
      expect(child.closed).toBe(1);
      request3.serverClosed?.();
      expect(child.closed).toBe(1);

      const request4 = makeRequestBackend();
      await request4.initialize(backendContext as any, clientVersion);
      await request4.callTool('tool_default', {});
      expect(defaults.at(-1)!.calls).toContain('tool_default');
    });
  });
});
