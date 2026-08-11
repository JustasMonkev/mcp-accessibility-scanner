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
});
