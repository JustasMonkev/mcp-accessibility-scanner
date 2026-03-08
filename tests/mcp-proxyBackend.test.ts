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

import { describe, expect, it, vi } from 'vitest';
import { ProxyBackend } from '../src/mcp/proxyBackend.js';

describe('ProxyBackend', () => {
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
});
