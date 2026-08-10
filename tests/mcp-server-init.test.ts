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
import { createServer } from '../src/mcp/server.js';
import { InProcessTransport } from '../src/mcp/inProcessTransport.js';

import type { JSONRPCMessage, JSONRPCResponse } from '@modelcontextprotocol/sdk/types.js';

function createBackend() {
  return {
    initialize: vi.fn(async () => undefined),
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
  };
}

// Drives the server over raw JSON-RPC, deliberately skipping the
// initialize/initialized handshake — the way an MCP 2026-07-28 client behaves.
async function startRawClient(backend: unknown) {
  const server = createServer('Test', '1.0.0', backend as any, false);
  const transport = new InProcessTransport(server);
  const pending = new Map<number, (response: JSONRPCResponse) => void>();
  transport.onmessage = message => {
    const response = message as JSONRPCResponse;
    if (response.id !== undefined)
      pending.get(response.id as number)?.(response);
  };
  await transport.start();
  const sendRequest = (id: number, method: string, params?: Record<string, unknown>) => {
    const response = new Promise<JSONRPCResponse>(resolve => pending.set(id, resolve));
    void transport.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
    return response;
  };
  return { transport, sendRequest };
}

describe('mcp server lazy initialization', () => {
  it('serves tools/call without any handshake instead of hanging', async () => {
    const backend = createBackend();
    const { transport, sendRequest } = await startRawClient(backend);
    try {
      const response = await sendRequest(1, 'tools/call', { name: 'some_tool', arguments: {} });
      expect(response.result).toMatchObject({ content: [{ type: 'text', text: 'ok' }] });
      expect(backend.initialize).toHaveBeenCalledTimes(1);
      // No handshake means no client info.
      expect(backend.initialize.mock.calls[0][1]).toEqual({ name: 'unknown', version: 'unknown' });
      expect(backend.callTool).toHaveBeenCalledWith('some_tool', {}, expect.anything());
    } finally {
      await transport.close();
    }
  });

  it('serves tools/list without any handshake instead of hanging', async () => {
    const backend = createBackend();
    const { transport, sendRequest } = await startRawClient(backend);
    try {
      const response = await sendRequest(1, 'tools/list');
      expect(response.result).toMatchObject({ tools: [] });
      expect(backend.initialize).toHaveBeenCalledTimes(1);
    } finally {
      await transport.close();
    }
  });

  it('shares one backend initialization across concurrent first requests', async () => {
    let releaseInitialize = () => {};
    const initializeGate = new Promise<void>(resolve => releaseInitialize = resolve);
    const backend = createBackend();
    backend.initialize.mockImplementation(() => initializeGate);

    const { transport, sendRequest } = await startRawClient(backend);
    try {
      const firstCall = sendRequest(1, 'tools/call', { name: 'some_tool', arguments: {} });
      const secondCall = sendRequest(2, 'tools/call', { name: 'some_tool', arguments: {} });
      const listCall = sendRequest(3, 'tools/list');

      // All three requests are now blocked on the same in-flight initialization.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(backend.initialize).toHaveBeenCalledTimes(1);
      releaseInitialize();

      const [first, second, list] = await Promise.all([firstCall, secondCall, listCall]);
      expect(first.result).toMatchObject({ content: [{ type: 'text', text: 'ok' }] });
      expect(second.result).toMatchObject({ content: [{ type: 'text', text: 'ok' }] });
      expect(list.result).toMatchObject({ tools: [] });
      expect(backend.initialize).toHaveBeenCalledTimes(1);
      expect(backend.callTool).toHaveBeenCalledTimes(2);
    } finally {
      await transport.close();
    }
  });

  it('still initializes from the handshake with the client identity', async () => {
    const backend = createBackend();
    const server = createServer('Test', '1.0.0', backend as any, false);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new InProcessTransport(server));
    try {
      const { tools } = await client.listTools();
      expect(tools).toEqual([]);
      await client.callTool({ name: 'some_tool', arguments: {} });
      // The handshake path and the request path share one initialization.
      expect(backend.initialize).toHaveBeenCalledTimes(1);
      expect(backend.initialize.mock.calls[0][1]).toMatchObject({ name: 'test-client', version: '1.0.0' });
    } finally {
      await client.close();
    }
  });
});
