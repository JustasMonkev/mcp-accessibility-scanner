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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
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
});
