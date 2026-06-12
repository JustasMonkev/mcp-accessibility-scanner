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
import { ErrorCode, McpError, PingRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { wrapInProcess } from '../src/mcp/server.js';

async function connectClient(backend: unknown) {
  const transport = await wrapInProcess(backend as any);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  client.setRequestHandler(PingRequestSchema, () => ({}));
  await client.connect(transport);
  return client;
}

describe('mcp server error mapping', () => {
  it('surfaces McpError from the backend as a protocol error', async () => {
    const backend = {
      initialize: vi.fn(async () => undefined),
      listTools: vi.fn(async () => []),
      callTool: vi.fn(async () => {
        throw new McpError(ErrorCode.InvalidParams, 'Tool "missing_tool" not found');
      }),
    };

    const client = await connectClient(backend);
    try {
      await expect(client.callTool({ name: 'missing_tool', arguments: {} }))
          .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    } finally {
      await client.close();
    }
  });

  it('converts ordinary backend errors into isError tool results', async () => {
    const backend = {
      initialize: vi.fn(async () => undefined),
      listTools: vi.fn(async () => []),
      callTool: vi.fn(async () => {
        throw new Error('tool execution exploded');
      }),
    };

    const client = await connectClient(backend);
    try {
      const result = await client.callTool({ name: 'some_tool', arguments: {} });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string, text: string }>)[0].text).toContain('tool execution exploded');
    } finally {
      await client.close();
    }
  });

  it('exposes server title and instructions to the client', async () => {
    const backend = {
      initialize: vi.fn(async () => undefined),
      listTools: vi.fn(async () => []),
      callTool: vi.fn(async () => ({ content: [] })),
    };

    const { createServer } = await import('../src/mcp/server.js');
    const { InProcessTransport } = await import('../src/mcp/inProcessTransport.js');
    const server = createServer('Test', '1.0.0', backend as any, false, {
      title: 'Test Title',
      instructions: 'Use the tools wisely.',
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    client.setRequestHandler(PingRequestSchema, () => ({}));
    await client.connect(new InProcessTransport(server));
    try {
      expect(client.getInstructions()).toBe('Use the tools wisely.');
      expect(client.getServerVersion()).toMatchObject({ name: 'Test', title: 'Test Title' });
    } finally {
      await client.close();
    }
  });
});
