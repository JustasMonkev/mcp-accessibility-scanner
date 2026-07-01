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

import http from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListRootsRequestSchema, PingRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { httpAddressToString, installHttpTransport, startHttpServer } from '../src/mcp/http.js';
import { ManualPromise } from '../src/mcp/manualPromise.js';

import type { ServerBackendFactory } from '../src/mcp/server.js';

const testBackendFactory: ServerBackendFactory = {
  name: 'test-http-backend',
  nameInConfig: 'test-http-backend',
  version: '0.0.0',
  create: () => ({
    async listTools() {
      return [];
    },
    async callTool() {
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  }),
};

describe('mcp http transport hardening', () => {
  const servers = new Set<http.Server>();

  afterEach(async () => {
    await Promise.all([...servers].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    servers.clear();
  });

  it('binds to localhost by default', async () => {
    const server = await startHttpServer({ port: 0 });
    servers.add(server);
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP server address');

    expect(['127.0.0.1', '::1']).toContain(address.address);
  });

  it('reports wildcard bind addresses without rewriting them to localhost', () => {
    expect(httpAddressToString({ address: '0.0.0.0', family: 'IPv4', port: 1234 })).toBe('http://0.0.0.0:1234');
    expect(httpAddressToString({ address: '::', family: 'IPv6', port: 1234 })).toBe('http://[::]:1234');
  });

  async function startServer(serverBackendFactory = testBackendFactory) {
    const server = await startHttpServer({ host: '127.0.0.1', port: 0 });
    servers.add(server);
    await installHttpTransport(server, serverBackendFactory);
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP server address');
    return { server, port: address.port };
  }

  async function sendRequest(port: number, options?: { method?: string, path?: string, hostHeader?: string, origin?: string, sessionId?: string, accept?: string }) {
    const response = await new Promise<{ statusCode: number, body: string }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: options?.path ?? '/mcp',
        method: options?.method ?? 'GET',
        headers: {
          ...(options?.hostHeader ? { host: options.hostHeader } : {}),
          ...(options?.origin ? { origin: options.origin } : {}),
          ...(options?.sessionId ? { 'mcp-session-id': options.sessionId } : {}),
          ...(options?.accept ? { accept: options.accept } : {}),
        },
      }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });
      req.on('error', reject);
      req.end();
    });
    return response;
  }

  it('rejects disallowed host headers before routing', async () => {
    const { port } = await startServer();

    const response = await sendRequest(port, { hostHeader: `evil.example:${port}` });

    expect(response.statusCode).toBe(403);
    expect(response.body).toBe('Forbidden Host header');
  });

  it('rejects disallowed origin headers before routing', async () => {
    const { port } = await startServer();

    const response = await sendRequest(port, {
      hostHeader: `localhost:${port}`,
      origin: 'https://evil.example',
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toBe('Forbidden Origin header');
  });

  it('rejects loopback origin aliases when the authority does not exactly match the host header', async () => {
    const { port } = await startServer();

    const response = await sendRequest(port, {
      hostHeader: `localhost:${port}`,
      origin: `http://127.0.0.1:${port}`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toBe('Forbidden Origin header');
  });

  it('rejects allowed origins when the authority does not exactly match the host header', async () => {
    const { port } = await startServer();

    const response = await sendRequest(port, {
      hostHeader: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port + 1}`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toBe('Forbidden Origin header');
  });

  it('rejects allowed origins when the scheme does not match the host transport', async () => {
    const { port } = await startServer();

    const response = await sendRequest(port, {
      hostHeader: `127.0.0.1:${port}`,
      origin: `https://127.0.0.1:${port}`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toBe('Forbidden Origin header');
  });

  it('allows browser requests when origin authority exactly matches the host header', async () => {
    const { port } = await startServer();

    const response = await sendRequest(port, {
      hostHeader: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('Invalid request');
  });

  it('allows non-browser requests without an origin header', async () => {
    const { port } = await startServer();

    const response = await sendRequest(port, {
      hostHeader: `127.0.0.1:${port}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('Invalid request');
  });

  it('does not expose the deprecated /sse endpoint', async () => {
    const { port } = await startServer();

    const response = await sendRequest(port, {
      path: '/sse',
      hostHeader: `localhost:${port}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe('Not found');
  });

  it('rejects session creation outside the canonical /mcp path', async () => {
    const { port } = await startServer();

    const response = await sendRequest(port, {
      method: 'POST',
      path: '/not-mcp',
      hostHeader: `127.0.0.1:${port}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe('Not found');
  });

  it('accepts canonicalized /mcp paths before method validation', async () => {
    const { port } = await startServer();

    const response = await sendRequest(port, {
      path: '/mcp?trace=1',
      hostHeader: `127.0.0.1:${port}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('Invalid request');
  });

  it('waits for the streamable HTTP event stream before listing roots', async () => {
    const roots = [{ uri: 'file:///workspace', name: 'workspace' }];
    let initializedRoots: unknown[] | undefined;
    const callTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const { port } = await startServer({
      ...testBackendFactory,
      create: () => ({
        async initialize(_context, _clientVersion, clientRoots) {
          initializedRoots = clientRoots;
        },
        async listTools() {
          return [];
        },
        callTool,
      }),
    });

    const sawGet = new ManualPromise<void>();
    const releaseGet = new ManualPromise<void>();
    const delayedFetch: typeof fetch = async (input, init) => {
      if (init?.method === 'GET') {
        sawGet.resolve();
        await releaseGet;
      }
      return fetch(input, init);
    };
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots }));
    client.setRequestHandler(PingRequestSchema, () => ({}));
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { fetch: delayedFetch });
    await client.connect(transport);

    try {
      if (!transport.sessionId)
        throw new Error('Expected initialized session');
      const invalidGet = await sendRequest(port, { sessionId: transport.sessionId, accept: 'application/json' });
      expect(invalidGet.statusCode).toBe(406);

      const callPromise = client.callTool({ name: 'probe', arguments: {} });
      await sawGet;
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(callTool).not.toHaveBeenCalled();

      releaseGet.resolve();
      await callPromise;

      expect(initializedRoots).toEqual(roots);
      expect(callTool).toHaveBeenCalledTimes(1);
    } finally {
      await transport.terminateSession();
      await client.close();
    }
  });

  it('falls back when the streamable HTTP event stream never opens', async () => {
    let initializedRoots: unknown[] | undefined;
    const callTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const listRoots = vi.fn(() => ({ roots: [{ uri: 'file:///workspace' }] }));
    const { port } = await startServer({
      ...testBackendFactory,
      create: () => ({
        async initialize(_context, _clientVersion, clientRoots) {
          initializedRoots = clientRoots;
        },
        async listTools() {
          return [];
        },
        callTool,
      }),
    });

    const originalSetTimeout = globalThis.setTimeout;
    const noStreamFetch: typeof fetch = async (input, init) => {
      if (init?.method === 'GET') {
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return fetch(input, init);
    };
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, listRoots);
    client.setRequestHandler(PingRequestSchema, () => ({}));
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { fetch: noStreamFetch });
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 5000 || timeout === 2000)
        return originalSetTimeout(handler, 0, ...args);
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout);

    try {
      await client.connect(transport);
      await client.callTool({ name: 'probe', arguments: {} });

      expect(initializedRoots).toEqual([]);
      expect(listRoots).not.toHaveBeenCalled();
      expect(callTool).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
      await client.close();
    }
  });
});
