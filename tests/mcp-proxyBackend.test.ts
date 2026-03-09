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
import { ProxyBackend } from '../src/mcp/proxyBackend.js';

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
    const callTool = vi.fn(async (_params: any, _schema: any, options?: { onprogress?: (params: { progress: number; total?: number; message?: string }) => void }) => {
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
        undefined,
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
});
