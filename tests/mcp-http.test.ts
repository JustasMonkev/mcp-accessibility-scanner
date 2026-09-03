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
import net, { type Socket } from 'net';
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

  async function startServer(serverBackendFactory = testBackendFactory) {
    const server = await startHttpServer({ host: '127.0.0.1', port: 0 });
    servers.add(server);
    await installHttpTransport(server, serverBackendFactory);
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP server address');
    return { server, port: address.port };
  }

  async function sendRequest(port: number, options?: { method?: string, path?: string, hostHeader?: string, origin?: string, sessionId?: string, accept?: string, protocolVersion?: string, body?: string, contentLength?: number, agent?: http.Agent, onSocket?: (socket: Socket) => void }) {
    const response = await new Promise<{ statusCode: number, headers: http.IncomingHttpHeaders, body: string }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: options?.path ?? '/mcp',
        method: options?.method ?? 'GET',
        agent: options?.agent,
        headers: {
          ...(options?.hostHeader ? { host: options.hostHeader } : {}),
          ...(options?.origin ? { origin: options.origin } : {}),
          ...(options?.sessionId ? { 'mcp-session-id': options.sessionId } : {}),
          ...(options?.accept ? { accept: options.accept } : {}),
          ...(options?.protocolVersion ? { 'mcp-protocol-version': options.protocolVersion } : {}),
          ...(options?.body ? { 'content-type': 'application/json' } : {}),
          ...(options?.contentLength !== undefined ? { 'content-length': String(options.contentLength) } : {}),
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
      if (options?.onSocket)
        req.once('socket', options.onSocket);
      req.on('error', reject);
      req.end(options?.body);
    });
    return response;
  }

  function expectCompleteRaw413(response: string) {
    const separator = response.indexOf('\r\n\r\n');
    expect(separator).toBeGreaterThan(0);
    const headers = response.slice(0, separator);
    const body = response.slice(separator + 4);
    expect(headers).toMatch(/^HTTP\/1\.1 413/);
    expect(headers).toMatch(/\r\nConnection: close\r\n/i);
    expect(Buffer.byteLength(body)).toBe(Number(headers.match(/\r\nContent-Length: (\d+)\r\n/i)?.[1]));
    expect(JSON.parse(body)).toMatchObject({ error: { code: -32600 } });
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

  // A sessionless GET reaches method routing (past header validation), where
  // it is answered 405 like the SDK's own stateless mode answers non-POST.
  const methodNotAllowedBody = { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null };

  it('allows browser requests when origin authority exactly matches the host header', async () => {
    const { port } = await startServer();

    const response = await sendRequest(port, {
      hostHeader: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
    });

    expect(response.statusCode).toBe(405);
    expect(JSON.parse(response.body)).toEqual(methodNotAllowedBody);
  });

  it('allows non-browser requests without an origin header', async () => {
    const { port } = await startServer();

    const response = await sendRequest(port, {
      hostHeader: `127.0.0.1:${port}`,
    });

    expect(response.statusCode).toBe(405);
    expect(JSON.parse(response.body)).toEqual(methodNotAllowedBody);
  });

  it('answers sessionless non-POST methods with 405 like the SDK stateless mode', async () => {
    const { port } = await startServer();

    const response = await sendRequest(port, {
      method: 'DELETE',
      hostHeader: `127.0.0.1:${port}`,
    });

    expect(response.statusCode).toBe(405);
    expect(JSON.parse(response.body)).toEqual(methodNotAllowedBody);
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

    expect(response.statusCode).toBe(405);
    expect(JSON.parse(response.body)).toEqual(methodNotAllowedBody);
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

    it('answers malformed JSON with the SDK parse-error response', async () => {
      const { port } = await startServer(probeFactory);

      const response = await sendRequest(port, {
        method: 'POST',
        hostHeader: `127.0.0.1:${port}`,
        accept: 'application/json, text/event-stream',
        body: '{ not json',
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toMatchObject({ error: { code: -32700 } });
    });

    it('rejects oversized bodies with 413 before buffering them', async () => {
      // readJsonBody buffers sessionless JSON POSTs in user land, so it must
      // enforce the message-size cap itself: without one, a single large (or
      // slow) request holds arbitrary memory, multiplied by concurrency.
      const { port } = await startServer(probeFactory);
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      let firstSocket: Socket | undefined;
      try {
        const response = await new Promise<{ statusCode: number, body: string }>((resolve, reject) => {
          let responseResult: { statusCode: number, body: string } | undefined;
          let responseStarted = false;
          let requestClosed = false;
          const maybeResolve = () => {
            if (responseResult && requestClosed)
              resolve(responseResult);
          };
          const req = http.request({
            host: '127.0.0.1',
            port,
            path: '/mcp',
            method: 'POST',
            agent,
            headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
          }, res => {
            responseStarted = true;
            const chunks: Buffer[] = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
              if (!res.complete) {
                reject(new Error('413 response ended before it was complete'));
                return;
              }
              responseResult = { statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') };
              maybeResolve();
            });
            res.on('error', reject);
          });
          req.once('socket', socket => firstSocket = socket);
          req.on('error', reject);
          req.on('close', () => {
            if (!responseStarted) {
              reject(new Error('Request closed before the 413 response started'));
              return;
            }
            requestClosed = true;
            maybeResolve();
          });
          // Stream 11 MB chunked (no Content-Length) to exercise the byte
          // counter, not the header short-circuit.
          const filler = Buffer.alloc(64 * 1024, 'a');
          let sent = 0;
          req.write('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"pad":"');
          const pump = () => {
            while (sent < 11 * 1024 * 1024) {
              sent += filler.length;
              if (!req.write(filler)) {
                req.once('drain', pump);
                return;
              }
            }
            req.end('"}');
          };
          pump();
        });

        expect(response.statusCode).toBe(413);
        expect(JSON.parse(response.body)).toMatchObject({ error: { code: -32600 } });
        expect(firstSocket).toBeDefined();

        let followUpSocket: Socket | undefined;
        const followUp = await sendRequest(port, {
          method: 'POST',
          agent,
          onSocket: socket => followUpSocket = socket,
          accept: 'application/json, text/event-stream',
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        });
        resultOf(followUp, 2);
        expect(followUpSocket).toBe(firstSocket);
      } finally {
        agent.destroy();
      }
    });

    it('delivers 413 before closing a large chunked upload', async () => {
      const { server, port } = await startServer(probeFactory);
      const requestCompleted = new Promise<boolean>(resolve => {
        server.once('request', request => request.once('close', () => resolve(request.complete)));
      });
      const client = net.connect(port, '127.0.0.1');
      try {
        const responseChunks: Buffer[] = [];
        const response = new Promise<string>((resolve, reject) => {
          client.on('data', chunk => responseChunks.push(chunk));
          client.once('error', reject);
          client.once('close', () => resolve(Buffer.concat(responseChunks).toString('utf8')));
        });
        client.pause();
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => reject(error);
          client.once('error', onError);
          client.once('connect', () => {
            client.off('error', onError);
            resolve();
          });
        });
        client.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n`);
        const filler = Buffer.alloc(64 * 1024, 'a');
        const chunkHeader = `${filler.length.toString(16)}\r\n`;
        for (let sent = 0; sent < 21 * 1024 * 1024; sent += filler.length) {
          client.write(chunkHeader);
          client.write(filler);
          client.write('\r\n');
        }
        client.end('0\r\n\r\n');
        setTimeout(() => client.resume(), 100);

        expectCompleteRaw413(await response);
        expect(await requestCompleted).toBe(true);
      } finally {
        client.destroy();
      }
    });

    it('closes a chunked upload at the exact discard limit', async () => {
      const { server, port } = await startServer(probeFactory);
      const requestCompleted = new Promise<boolean>(resolve => {
        server.once('request', request => request.once('close', () => resolve(request.complete)));
      });
      const client = net.connect(port, '127.0.0.1');
      try {
        await new Promise<void>((resolve, reject) => {
          client.once('error', reject);
          client.once('connect', resolve);
        });
        const responseChunks: Buffer[] = [];
        const response = new Promise<string>((resolve, reject) => {
          client.on('data', chunk => responseChunks.push(chunk));
          client.once('error', reject);
          client.once('close', () => resolve(Buffer.concat(responseChunks).toString('utf8')));
        });
        const writeChunk = async (chunk: Buffer) => {
          if (!client.write(`${chunk.length.toString(16)}\r\n`))
            await new Promise<void>(resolve => client.once('drain', resolve));
          if (!client.write(chunk))
            await new Promise<void>(resolve => client.once('drain', resolve));
          if (!client.write('\r\n'))
            await new Promise<void>(resolve => client.once('drain', resolve));
        };
        client.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n`);
        await writeChunk(Buffer.alloc(10 * 1024 * 1024, 'a'));
        await writeChunk(Buffer.from('a'));
        await writeChunk(Buffer.alloc(10 * 1024 * 1024, 'a'));
        client.end('0\r\n\r\n');

        expectCompleteRaw413(await response);
        expect(await requestCompleted).toBe(true);
      } finally {
        client.destroy();
      }
    }, 3000);

    it('rejects a declared oversize from its Content-Length without reading the body', async () => {
      const { port } = await startServer(probeFactory);

      const response = await sendRequest(port, {
        method: 'POST',
        hostHeader: `127.0.0.1:${port}`,
        accept: 'application/json, text/event-stream',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        contentLength: 11 * 1024 * 1024,
      });

      expect(response.statusCode).toBe(413);
      expect(response.headers.connection).toBe('close');
      expect(JSON.parse(response.body)).toMatchObject({ error: { code: -32600 } });
    });

    it('serves handshake-free requests with the factory\'s stateless backend variant', async () => {
      // Per-request backends are torn down with the response; the factory can
      // shape them for that lifecycle (disposable browser profile). Stateful
      // initialize-handshake sessions must keep using create().
      const create = vi.fn(() => probeFactory.create());
      const createStateless = vi.fn(() => probeFactory.create());
      const { port } = await startServer({ ...probeFactory, create, createStateless });

      const response = await postJson(port, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      resultOf(response, 1);
      expect(createStateless).toHaveBeenCalledTimes(1);
      expect(create).not.toHaveBeenCalled();

      const initResponse = await postJson(port, {
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw-client', version: '1.0.0' } },
      });
      expect(initResponse.statusCode).toBe(200);
      expect(create).toHaveBeenCalledTimes(1);
      expect(createStateless).toHaveBeenCalledTimes(1);
    });

    it('runs stateless default contexts in disposable browser-session profiles', async () => {
      // Handshake-free tools/call POSTs without a browserSessionId each mint a
      // per-request default context. Unflagged, parallel requests raced on
      // the stable persistent profile ("Browser is already in use"); flagged
      // like explicit sessions they get disposable profiles — a context torn
      // down at response end gains nothing from the stable profile anyway.
      const config = await resolveConfig({});
      const createBrowserContext = vi.fn(async (..._args: any[]) => {
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
        createStateless: () => new BrowserServerBackend(config, { createContext: createBrowserContext } as any, sessionRegistry, { ephemeralDefaultContext: true }),
      };
      const { port } = await startServer(factory);

      try {
        const response = await postJson(port, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'browser_tabs', arguments: { action: 'list' } },
        });
        const result = resultOf(response, 1);
        expect(result.isError).not.toBe(true);
        expect(createBrowserContext).toHaveBeenCalledTimes(1);
        expect(createBrowserContext.mock.calls[0][3]).toMatchObject({ browserSession: true });
      } finally {
        await Context.disposeAll();
      }
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

  // Requests carrying the 2026-07-28 per-request `_meta` envelope are served
  // by the SDK's native modern endpoint (`createMcpHandler`), not the 2025
  // transports: `server/discover` is answered, results are stamped with
  // `resultType` and the SEP-2549 cache fields, and the SEP-2243 standard
  // headers are validated. Refs #165, #166.
  describe('MCP 2026-07-28 modern serving', () => {
    const envelope = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'raw-modern', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    };

    async function modernPost(port: number, body: unknown, headers: Record<string, string> = {}) {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json, text/event-stream',
          ...headers,
        },
        body: JSON.stringify(body),
      });
      return { statusCode: response.status, json: await response.json() as any };
    }

    it('serves a modern-mode v2 client end to end without initialize or a session', async () => {
      const serverClosed = vi.fn();
      const { port } = await startServer({
        ...probeFactory,
        create: () => ({ ...probeFactory.create(), serverClosed }),
      });

      const client = new Client({ name: 'modern-client', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
      try {
        await client.connect(transport);
        expect(client.getProtocolEra()).toBe('modern');
        // server/discover was answered (SDK-built from the server identity
        // and capabilities) — a 2025-only endpoint would fail the pin.
        expect(client.getDiscoverResult()?.supportedVersions).toContain('2026-07-28');

        const tools = await client.listTools();
        expect(tools.tools).toEqual([expect.objectContaining({ name: 'probe' })]);

        const result = await client.callTool({ name: 'probe', arguments: {} });
        expect(result.content).toEqual([{ type: 'text', text: 'called probe' }]);

        // Stateless: no session id was ever minted.
        expect(transport.sessionId).toBeUndefined();
      } finally {
        await client.close();
      }
      // Each modern request was served by a disposable per-request server
      // whose backend was torn down once the exchange finished.
      await vi.waitFor(() => expect(serverClosed.mock.calls.length).toBeGreaterThanOrEqual(2));
    });

    it('stamps resultType and the advertised cache hint on tools/list', async () => {
      const { port } = await startServer({
        ...probeFactory,
        toolListCacheHint: { ttlMs: 3600000, cacheScope: 'private' },
      });

      const { statusCode, json } = await modernPost(port,
          { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: envelope } },
          { 'Mcp-Method': 'tools/list', 'Mcp-Name': 'raw-modern' });

      expect(statusCode).toBe(200);
      expect(json.result.resultType).toBe('complete');
      expect(json.result.ttlMs).toBe(3600000);
      expect(json.result.cacheScope).toBe('private');
      expect(json.result.tools).toEqual([expect.objectContaining({ name: 'probe' })]);
    });

    it('defaults to an uncacheable tools/list when no hint is configured', async () => {
      // Backends with a runtime-mutable tool list (proxy context switch,
      // VS Code host) advertise no hint, which must surface as ttlMs: 0.
      const { port } = await startServer(probeFactory);

      const { statusCode, json } = await modernPost(port,
          { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: envelope } },
          { 'Mcp-Method': 'tools/list', 'Mcp-Name': 'raw-modern' });

      expect(statusCode).toBe(200);
      expect(json.result.ttlMs).toBe(0);
      expect(json.result.cacheScope).toBe('private');
    });

    it('rejects a modern POST whose Mcp-Method header disagrees with the body', async () => {
      const { port } = await startServer(probeFactory);

      const mismatch = await modernPost(port,
          { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: envelope } },
          { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'raw-modern' });
      expect(mismatch.statusCode).toBe(400);
      expect(mismatch.json.error.code).toBe(-32020);

      const missing = await modernPost(port,
          { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: envelope } });
      expect(missing.statusCode).toBe(400);
      expect(missing.json.error.code).toBe(-32020);
    });
  });

  // Roots are deprecated in MCP 2026-07-28 (SEP-2577); the server must not
  // fetch them even from a client that still advertises the capability, and
  // the first tool call must be served without waiting for the standalone
  // event stream (the old listRoots round-trip needed it). Refs #169.
  it('keeps POST-only sessions alive without the event stream or roots', async () => {
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
      const request = input instanceof Request ? input : undefined;
      const method = init?.method ?? request?.method;
      if (method === 'GET') {
        return await new Promise<Response>((_resolve, reject) => {
          (init?.signal ?? request?.signal)?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return fetch(input, init);
    };
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { roots: {} } });
    client.setRequestHandler('roots/list', listRoots);
    client.setRequestHandler('ping', () => ({}));
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { fetch: noStreamFetch });
    const previousPingTimeout = process.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS;
    process.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS = '20';

    try {
      await client.connect(transport);
      if (!transport.sessionId)
        throw new Error('Expected initialized session');
      const invalidGet = await sendRequest(port, { sessionId: transport.sessionId, accept: 'application/json' });
      expect(invalidGet.statusCode).toBe(406);

      await client.callTool({ name: 'probe', arguments: {} });
      await new Promise(resolve => setTimeout(resolve, 50));
      await client.callTool({ name: 'probe', arguments: {} });

      expect(listRoots).not.toHaveBeenCalled();
      expect(initialize).toHaveBeenCalledTimes(1);
      expect(callTool).toHaveBeenCalledTimes(2);
    } finally {
      if (previousPingTimeout === undefined)
        delete process.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS;
      else
        process.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS = previousPingTimeout;
      await client.close();
    }
  });

  it('does not arm the heartbeat off a rejected event-stream GET', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const { port } = await startServer({
      ...testBackendFactory,
      create: () => ({
        async initialize() {},
        async listTools() {
          return [];
        },
        callTool,
      }),
    });

    const noStreamFetch: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : undefined;
      const method = init?.method ?? request?.method;
      if (method === 'GET') {
        return await new Promise<Response>((_resolve, reject) => {
          (init?.signal ?? request?.signal)?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return fetch(input, init);
    };
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    client.setRequestHandler('ping', () => ({}));
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { fetch: noStreamFetch });
    const previousPingTimeout = process.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS;
    process.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS = '20';

    try {
      await client.connect(transport);

      const rejectedStream = await sendRequest(port, {
        sessionId: transport.sessionId,
        accept: 'text/event-stream',
        protocolVersion: '0.0.0',
      });
      expect(rejectedStream.statusCode).toBe(400);

      await client.callTool({ name: 'probe', arguments: {} });
      await new Promise(resolve => setTimeout(resolve, 50));
      await client.callTool({ name: 'probe', arguments: {} });
      expect(callTool).toHaveBeenCalledTimes(2);
    } finally {
      if (previousPingTimeout === undefined)
        delete process.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS;
      else
        process.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS = previousPingTimeout;
      await client.close();
    }
  });
});
