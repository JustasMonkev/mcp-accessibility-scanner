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
import { createServer, wrapInProcess } from '../src/mcp/server.js';
import { InProcessTransport } from '../src/mcp/inProcessTransport.js';

async function connectClient(backend: unknown) {
  const transport = await wrapInProcess(backend as any);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  client.setRequestHandler(PingRequestSchema, () => ({}));
  await client.connect(transport);
  return client;
}

async function connectHeartbeatClient(backend: unknown, pingHandler: () => object | Promise<object>) {
  const server = createServer('Test', '1.0.0', backend as any, true);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  client.setRequestHandler(PingRequestSchema, pingHandler);
  await client.connect(new InProcessTransport(server));
  return { client, server };
}

async function waitForAssertion(assertion: () => void) {
  const deadline = Date.now() + 1000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

async function withPingTimeout<T>(value: string, callback: () => Promise<T>) {
  const previous = process.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS;
  process.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS = value;
  try {
    return await callback();
  } finally {
    if (previous === undefined)
      delete process.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS;
    else
      process.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS = previous;
  }
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

  it('closes the server when heartbeat ping times out', async () => {
    await withPingTimeout('20', async () => {
      const backend = {
        initialize: vi.fn(async () => undefined),
        listTools: vi.fn(async () => []),
        callTool: vi.fn(async () => ({ content: [] })),
        serverClosed: vi.fn(),
      };

      const { client } = await connectHeartbeatClient(backend, () => new Promise<object>(() => {}));
      try {
        await client.callTool({ name: 'some_tool', arguments: {} });
        await waitForAssertion(() => expect(backend.serverClosed).toHaveBeenCalledTimes(1));
      } finally {
        await client.close();
      }
    });
  });

  it('does not run heartbeat when ping timeout is non-positive', async () => {
    await withPingTimeout('0', async () => {
      const backend = {
        initialize: vi.fn(async () => undefined),
        listTools: vi.fn(async () => []),
        callTool: vi.fn(async () => ({ content: [] })),
        serverClosed: vi.fn(),
      };

      const { client } = await connectHeartbeatClient(backend, () => new Promise<object>(() => {}));
      try {
        await client.callTool({ name: 'some_tool', arguments: {} });
        await new Promise(resolve => setTimeout(resolve, 100));
        await client.callTool({ name: 'some_tool', arguments: {} });

        expect(backend.callTool).toHaveBeenCalledTimes(2);
        expect(backend.serverClosed).not.toHaveBeenCalled();
      } finally {
        await client.close();
      }
    });
  });

  it('passes configured heartbeat timeout into the ping request', async () => {
    await withPingTimeout('120000', async () => {
      const backend = {
        initialize: vi.fn(async () => undefined),
        listTools: vi.fn(async () => []),
        callTool: vi.fn(async () => ({ content: [] })),
      };

      const { client, server } = await connectHeartbeatClient(backend, () => ({}));
      const requestSpy = vi.spyOn(server, 'request');
      try {
        await client.callTool({ name: 'some_tool', arguments: {} });

        expect(requestSpy).toHaveBeenCalledWith(
            { method: 'ping' },
            expect.any(Object),
            expect.objectContaining({ timeout: 120000 }),
        );
      } finally {
        await client.close();
      }
    });
  });

  it('uses the default heartbeat timeout when env value is blank', async () => {
    await withPingTimeout('  ', async () => {
      const backend = {
        initialize: vi.fn(async () => undefined),
        listTools: vi.fn(async () => []),
        callTool: vi.fn(async () => ({ content: [] })),
      };

      const { client, server } = await connectHeartbeatClient(backend, () => ({}));
      const requestSpy = vi.spyOn(server, 'request');
      try {
        await client.callTool({ name: 'some_tool', arguments: {} });

        expect(requestSpy).toHaveBeenCalledWith(
            { method: 'ping' },
            expect.any(Object),
            expect.objectContaining({ timeout: 5000 }),
        );
      } finally {
        await client.close();
      }
    });
  });
});
