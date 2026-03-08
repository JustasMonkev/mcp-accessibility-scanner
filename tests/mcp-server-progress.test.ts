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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { PingRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { wrapInProcess } from '../src/mcp/server.js';

describe('mcp server progress plumbing', () => {
  it('passes request context into backend tool calls and delivers progress notifications', async () => {
    const backend = {
      initialize: vi.fn(async () => undefined),
      listTools: vi.fn(async () => []),
      callTool: vi.fn(async (_name: string, _args: Record<string, unknown> | undefined, requestContext?: any) => {
        await requestContext?.sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken: requestContext?._meta?.progressToken,
            progress: 1,
            total: 1,
            message: 'Complete',
          },
        });
        return {
          content: [{ type: 'text', text: '### Result\nok' }],
        };
      }),
    };

    const transport = await wrapInProcess(backend as any);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    client.setRequestHandler(PingRequestSchema, () => ({}));
    await client.connect(transport);

    try {
      const onprogress = vi.fn();
      const result = await client.callTool({
        name: 'audit_site',
        arguments: {},
      }, undefined, { onprogress });

      expect(result.isError).not.toBe(true);
      expect(backend.callTool).toHaveBeenCalledTimes(1);
      expect(backend.callTool.mock.calls[0][2]).toMatchObject({
        _meta: expect.objectContaining({
          progressToken: expect.any(Number),
        }),
      });
      expect(onprogress).toHaveBeenCalledWith(expect.objectContaining({
        progress: 1,
        total: 1,
        message: 'Complete',
      }));
    } finally {
      await client.close();
    }
  });
});
