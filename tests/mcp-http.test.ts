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

import { EventEmitter } from 'events';
import http from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { BrowserSessionRegistry } from '../src/browserSessions.js';
import { resolveConfig } from '../src/config.js';
import { Context } from '../src/context.js';
import { httpAddressToString, installHttpTransport, startHttpServer } from '../src/mcp/http.js';

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

  async function sendRequest(port: number, options?: { method?: string, path?: string, hostHeader?: string, origin?: string, sessionId?: string, accept?: string, body?: string }) {
    const response = await new Promise<{ statusCode: number, headers: http.IncomingHttpHeaders, body: string }>((resolve, reject) => {
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
          ...(options?.body ? { 'content-type': 'application/json' } : {}),
        },
      }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });
      req.on('error', reject);
      req.end(options?.body);
    });
    return response;
  }

  // Opens a request and resolves as soon as response headers arrive, then
  // aborts — needed for SSE streams that never end.
  async function openStream(port: number, options: { sessionId: string }) {
    return await new Promise<{ statusCode: number, headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'GET',
        headers: {
          'host': `127.0.0.1:${port}`,
          'mcp-session-id': options.sessionId,
          'accept': 'text/event-stream',
        },
      }, res => {
        resolve({ statusCode: res.statusCode ?? 0, headers: res.headers });
        res.destroy();
      });
      req.on('error', reject);
      req.end();
    });
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

  // v1 session compatibility layer (Refs #166): until the v2 stateless
  // transport lands, POST without Mcp-Session-Id must initialize a session,
  // requests carrying the header must route to it, and unknown ids must 404.
  describe('v1 Mcp-Session-Id compatibility', () => {
    async function initializeSession(port: number) {
      const response = await sendRequest(port, {
        method: 'POST',
        hostHeader: `127.0.0.1:${port}`,
        accept: 'application/json, text/event-stream',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw-client', version: '1.0.0' } },
        }),
      });
      return response;
    }

    it('returns 404 for an unknown session id', async () => {
      const { port } = await startServer();

      const response = await sendRequest(port, {
        method: 'POST',
        hostHeader: `127.0.0.1:${port}`,
        sessionId: 'no-such-session',
        accept: 'application/json, text/event-stream',
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).toBe('Session not found');
    });

    it('initializes a new session on POST without a session id and routes follow-ups by header', async () => {
      const { port } = await startServer();

      const initResponse = await initializeSession(port);
      expect(initResponse.statusCode).toBe(200);
      const sessionId = initResponse.headers['mcp-session-id'];
      expect(typeof sessionId).toBe('string');

      const notifyResponse = await sendRequest(port, {
        method: 'POST',
        hostHeader: `127.0.0.1:${port}`,
        sessionId: sessionId as string,
        accept: 'application/json, text/event-stream',
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      expect(notifyResponse.statusCode).toBe(202);

      const pingResponse = await sendRequest(port, {
        method: 'POST',
        hostHeader: `127.0.0.1:${port}`,
        sessionId: sessionId as string,
        accept: 'application/json, text/event-stream',
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
      });
      expect(pingResponse.statusCode).toBe(200);
    });

    it('opens the standalone event stream on GET with Accept: text/event-stream', async () => {
      const { port } = await startServer();

      const initResponse = await initializeSession(port);
      const sessionId = initResponse.headers['mcp-session-id'] as string;

      const stream = await openStream(port, { sessionId });
      expect(stream.statusCode).toBe(200);
      expect(stream.headers['content-type']).toContain('text/event-stream');
    });

    it('forgets the session when the client terminates it', async () => {
      const { port } = await startServer();

      const initResponse = await initializeSession(port);
      const sessionId = initResponse.headers['mcp-session-id'] as string;

      const deleteResponse = await sendRequest(port, {
        method: 'DELETE',
        hostHeader: `127.0.0.1:${port}`,
        sessionId,
        accept: 'application/json, text/event-stream',
      });
      expect(deleteResponse.statusCode).toBe(200);

      const afterDelete = await sendRequest(port, {
        method: 'POST',
        hostHeader: `127.0.0.1:${port}`,
        sessionId,
        accept: 'application/json, text/event-stream',
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
      });
      expect(afterDelete.statusCode).toBe(404);
      expect(afterDelete.body).toBe('Session not found');
    });
  });

  // Clients on the MCP 2026-07-28 revision never send `initialize` — their
  // first POST is already tools/list or tools/call. The v1 stateful transport
  // would reject that with "Server not initialized", so sessionless
  // non-initialize POSTs must be dispatched statelessly instead. Refs #166.
  describe('handshake-free requests', () => {
    async function postJson(port: number, message: unknown) {
      return await sendRequest(port, {
        method: 'POST',
        hostHeader: `127.0.0.1:${port}`,
        accept: 'application/json, text/event-stream',
        body: JSON.stringify(message),
      });
    }

    // The stateless transport answers in SSE framing by default; a direct
    // JSON body is also accepted for robustness.
    function jsonRpcMessages(response: { headers: http.IncomingHttpHeaders, body: string }): any[] {
      if (response.headers['content-type']?.includes('application/json'))
        return [JSON.parse(response.body)];
      return response.body
          .split('\n\n')
          .map(chunk => chunk
              .split('\n')
              .filter(line => line.startsWith('data: '))
              .map(line => line.slice('data: '.length))
              .join(''))
          .filter(Boolean)
          .map(data => JSON.parse(data));
    }

    function resultOf(response: { statusCode: number, headers: http.IncomingHttpHeaders, body: string }, id: number): any {
      expect(response.statusCode).toBe(200);
      const message = jsonRpcMessages(response).find(m => m.id === id);
      expect(message?.error).toBeUndefined();
      expect(message?.result).toBeDefined();
      return message.result;
    }

    const probeFactory: ServerBackendFactory = {
      ...testBackendFactory,
      create: () => ({
        async listTools() {
          return [{ name: 'probe', description: 'Probe tool', inputSchema: { type: 'object' as const } }];
        },
        async callTool(name: string) {
          return { content: [{ type: 'text' as const, text: `called ${name}` }] };
        },
      }),
    };

    it('serves tools/list on a first POST without initialize', async () => {
      const { port } = await startServer(probeFactory);

      const response = await postJson(port, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

      const result = resultOf(response, 1);
      expect(result.tools).toEqual([expect.objectContaining({ name: 'probe' })]);
      // Stateless: no session is minted for handshake-free clients.
      expect(response.headers['mcp-session-id']).toBeUndefined();
    });

    it('executes tools/call on a first POST without initialize', async () => {
      const { port } = await startServer(probeFactory);

      const response = await postJson(port, {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'probe', arguments: {} },
      });

      const result = resultOf(response, 7);
      expect(result.content).toEqual([{ type: 'text', text: 'called probe' }]);
      expect(response.headers['mcp-session-id']).toBeUndefined();
    });

    it('resolves browser session handles across handshake-free requests', async () => {
      // Each handshake-free request gets a fresh backend, so cross-request
      // browser state must travel via the browser_session_open handles: the
      // registry shared by the factory has to route the second request's
      // browserSessionId to the context the first request created.
      const config = await resolveConfig({});
      const createBrowserContext = vi.fn(async () => {
        const browserContext: any = new EventEmitter();
        browserContext.newPage = vi.fn().mockResolvedValue({});
        browserContext.pages = vi.fn().mockReturnValue([]);
        browserContext.route = vi.fn().mockResolvedValue(undefined);
        return { browserContext, close: vi.fn().mockResolvedValue(undefined) };
      });
      const sessionRegistry = new BrowserSessionRegistry();
      const factory: ServerBackendFactory = {
        ...testBackendFactory,
        create: () => new BrowserServerBackend(config, { createContext: createBrowserContext } as any, sessionRegistry),
      };
      const { port } = await startServer(factory);

      try {
        const openResponse = await postJson(port, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'browser_session_open', arguments: {} },
        });
        const openResult = resultOf(openResponse, 1);
        expect(openResult.isError).not.toBe(true);
        const browserSessionId = openResult.structuredContent?.browserSessionId;
        expect(browserSessionId).toMatch(/^bs_/);

        const listResponse = await postJson(port, {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'browser_tabs', arguments: { action: 'list', browserSessionId } },
        });
        const listResult = resultOf(listResponse, 2);
        expect(listResult.isError).not.toBe(true);
        // The handle routed to the session's one context — resolved, not
        // recreated, by the second request's fresh backend.
        expect(createBrowserContext).toHaveBeenCalledTimes(1);
      } finally {
        await Context.disposeAll();
      }
    });
  });

  // Roots are deprecated in MCP 2026-07-28 (SEP-2577); the server must not
  // fetch them even from a client that still advertises the capability, and
  // the first tool call must be served without waiting for the standalone
  // event stream (the old listRoots round-trip needed it). Refs #169.
  it('never requests roots and serves tools without the event stream', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const initialize = vi.fn(async () => undefined);
    const { port } = await startServer({
      ...testBackendFactory,
      create: () => ({
        initialize,
        async listTools() {
          return [];
        },
        callTool,
      }),
    });

    const listRoots = vi.fn(() => ({ roots: [{ uri: 'file:///workspace', name: 'workspace' }] }));
    // Never open the standalone GET stream: server-to-client requests such as
    // listRoots could not be delivered, so a tool call only succeeds if the
    // server no longer performs any.
    const noStreamFetch: typeof fetch = async (input, init) => {
      if (init?.method === 'GET') {
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return fetch(input, init);
    };
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { roots: {} } });
    client.setRequestHandler('roots/list', listRoots);
    client.setRequestHandler('ping', () => ({}));
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { fetch: noStreamFetch });

    try {
      await client.connect(transport);
      if (!transport.sessionId)
        throw new Error('Expected initialized session');
      const invalidGet = await sendRequest(port, { sessionId: transport.sessionId, accept: 'application/json' });
      expect(invalidGet.statusCode).toBe(406);

      await client.callTool({ name: 'probe', arguments: {} });

      expect(listRoots).not.toHaveBeenCalled();
      expect(initialize).toHaveBeenCalledTimes(1);
      expect(callTool).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  });
});
