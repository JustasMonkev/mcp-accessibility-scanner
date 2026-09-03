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

import assert from 'node:assert';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';

import debug from 'debug';

import { createMcpHandler, isInitializeRequest, isLegacyRequest, STDIO_DEFAULT_MAX_BUFFER_SIZE } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import { ManualPromise } from './manualPromise.js';
import * as mcpServer from './server.js';

import type { NodeMcpRequestHandler } from '@modelcontextprotocol/node';
import type { ServerBackendFactory } from './server.js';

const testDebug = debug('pw:mcp:test');
const allowedLoopbackHostnamePattern = /^127(?:\.\d{1,3}){3}$/;

export async function startHttpServer(config: { host?: string, port?: number }, abortSignal?: AbortSignal): Promise<http.Server> {
  const host = config.host ?? 'localhost';
  const { port } = config;
  const httpServer = http.createServer();
  decorateServer(httpServer);
  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', reject);
    abortSignal?.addEventListener('abort', () => {
      httpServer.close();
      reject(new Error('Aborted'));
    });
    httpServer.listen(port, host, () => {
      resolve();
      httpServer.removeListener('error', reject);
    });
  });
  return httpServer;
}

export function httpAddressToString(address: string | net.AddressInfo | null): string {
  assert(address, 'Could not bind server socket');
  if (typeof address === 'string')
    return address;
  const resolvedPort = address.port;
  const resolvedHost = address.family === 'IPv4' ? address.address : `[${address.address}]`;
  return `http://${resolvedHost}:${resolvedPort}`;
}

export async function installHttpTransport(httpServer: http.Server, serverBackendFactory: ServerBackendFactory) {
  const sessions = new SessionStore(serverBackendFactory);
  httpServer.on('request', async (req, res) => {
    const validationError = validateRequestHeaders(httpServer, req) ?? validateRequestRouting(req);
    if (validationError) {
      res.statusCode = validationError.statusCode;
      res.end(validationError.message);
      return;
    }
    await sessions.handleRequest(req, res);
  });
}

// ─── Sessionful 2025-era serving ─────────────────────────────────────────────
// The Streamable HTTP transport (2025-era protocol revisions) keys
// connections on the `Mcp-Session-Id` header and requires one MCP server per
// session; the MCP 2026-07-28 revision removes that header and per-connection
// sessions. The v2 SDK serves 2025-era HTTP traffic natively only in the
// stateless per-request idiom (`createMcpHandler`'s `legacy: 'stateless'` —
// no sessions, GET/DELETE answer 405), so this class remains as the minimal
// user-land session map the SDK's sessionful transport requires: it keeps
// stateful clients — heartbeat, standalone GET stream, server-initiated
// notifications — working exactly as before. Refs #166.
//
// Sessionless POSTs are routed with the SDK's own era classifier
// (`isLegacyRequest` — the exact predicate `createMcpHandler` routes on):
//
// - Requests carrying the 2026-07-28 per-request `_meta` envelope go to a
//   modern `createMcpHandler` endpoint (`legacy: 'reject'` — this store owns
//   all 2025 serving). That is the SDK's native 2026-07-28 serving: it
//   answers `server/discover`, stamps `resultType` and the SEP-2549
//   `ttlMs`/`cacheScope` cache fields, and validates the SEP-2243 standard
//   headers (`MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name`) — none of which
//   the 2025-era `Server` + transport pair provides. Refs #165, #166.
// - Envelope-less 2025-era requests keep the pre-existing body routing: an
//   `initialize` request gets the stateful session wire behavior; anything
//   else (a handshake-free 2025 client) is dispatched through the SDK's
//   stateless mode.
// ─────────────────────────────────────────────────────────────────────────────

type StatefulSession = { transport: NodeStreamableHTTPServerTransport, eventStreamReady: ManualPromise<void> };

class SessionStore {
  private readonly _sessions = new Map<string, StatefulSession>();
  // The modern (2026-07-28) endpoint: one handler for the server lifetime,
  // serving each enveloped request with a fresh server + backend from the
  // factory — the same per-request idiom as the legacy stateless path, so the
  // factory's shared browser-session registry carries state across requests.
  // The SDK closes the per-request server once its exchange finishes, which
  // runs backend.serverClosed() and disposes any default context it created.
  // No heartbeat: the modern era has no server-initiated request channel.
  private readonly _modernHandler: NodeMcpRequestHandler;

  constructor(private readonly _serverBackendFactory: ServerBackendFactory) {
    const handler = createMcpHandler(
        () => this._createStatelessServer(),
        { legacy: 'reject', onerror: error => testDebug(error) },
    );
    this._modernHandler = toNodeHandler(handler, { onerror: error => testDebug(error) });
  }

  // Builds the per-request server for both stateless paths (modern envelope
  // and handshake-free 2025 requests). The backend comes from the factory's
  // stateless variant when it provides one: a per-request backend is torn
  // down with the response, so e.g. its default browser context can run in a
  // disposable profile instead of contending for the stable persistent one.
  private _createStatelessServer() {
    const backend = (this._serverBackendFactory.createStateless ?? this._serverBackendFactory.create)();
    return mcpServer.createServer(this._serverBackendFactory.name, this._serverBackendFactory.version, backend, false, this._serverBackendFactory);
  }

  async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId) {
      await this._handleSessionRequest(sessionId, req, res);
      return;
    }
    if (req.method === 'POST') {
      await this._handleSessionlessPost(req, res);
      return;
    }
    // Sessionless GET/DELETE are 2025-era session operations that a
    // stateless endpoint does not serve. Mirror the SDK's own stateless mode
    // (`createLegacyStatelessFallback`), which answers every non-POST with
    // this 405 JSON-RPC error body and no Allow header.
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
  }

  private async _handleSessionRequest(sessionId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const session = this._sessions.get(sessionId);
    if (!session) {
      res.statusCode = 404;
      res.end('Session not found');
      return;
    }
    if (req.method === 'GET' && req.headers.accept?.split(',').some(type => type.split(';')[0].trim().toLowerCase() === 'text/event-stream')) {
      // The transport answers 200 on this GET only when it accepts it as the
      // standalone event stream, and handleRequest resolves when that stream
      // ends, not when it opens — so readiness has to be signalled at the
      // header flush, and only for a stream that actually established.
      const writeHead = res.writeHead.bind(res);
      const resolveOnEstablished = (...args: Parameters<http.ServerResponse['writeHead']>) => {
        if (args[0] === 200)
          session.eventStreamReady.resolve();
        return writeHead(...args);
      };
      res.writeHead = resolveOnEstablished as http.ServerResponse['writeHead'];
    }
    await session.transport.handleRequest(req, res);
  }

  // Peeks at the JSON-RPC body once to route it: modern envelope → the
  // 2026-07-28 handler; `initialize` (also inside a batch) → stateful
  // session; anything else → stateless dispatch. The already-parsed body is
  // handed to the chosen handler so the consumed request stream is never
  // read twice.
  private async _handleSessionlessPost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!hasJsonContentType(req)) {
      // Don't consume the stream — the transport rejects the media type
      // itself (415, after its Accept check), same as before this routing.
      await this._handleStatelessRequest(req, res, undefined);
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        // Chunked bodies get one bounded discard window. A completed request
        // stays reusable; a declared or still-incomplete request is closed.
        const reusable = req.headers['content-length'] === undefined && await discardRequestBody(req);
        if (res.destroyed)
          return;
        res.statusCode = 413;
        res.setHeader('Content-Type', 'application/json');
        const responseBody = JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: `Request body exceeded maximum size of ${maxJsonBodyBytes} bytes` }, id: null });
        if (reusable) {
          res.end(responseBody);
          return;
        }
        res.setHeader('Connection', 'close');
        res.setHeader('Content-Length', Buffer.byteLength(responseBody));
        let closed = false;
        const closeResponse = (destroyRequest: boolean) => {
          if (closed)
            return;
          closed = true;
          clearTimeout(closeTimer);
          req.off('end', onRequestEnd);
          res.end();
          if (destroyRequest)
            req.destroy();
        };
        const onRequestEnd = () => closeResponse(false);
        const closeTimer = setTimeout(() => closeResponse(true), 1000);
        closeTimer.unref();
        req.once('end', onRequestEnd);
        res.once('close', () => {
          clearTimeout(closeTimer);
          req.off('end', onRequestEnd);
        });
        res.write(responseBody);
        req.resume();
        return;
      }
      // The stream is consumed, so the transport could no longer produce its
      // own parse error; mirror the SDK's response exactly.
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: Invalid JSON' }, id: null }));
      return;
    }
    // The parsed body is passed alongside the headers-only web request, so
    // nothing further is read from the drained node stream.
    if (!(await isLegacyRequest(await toWebRequest(req, body), body))) {
      await this._modernHandler(req, res, body);
      return;
    }
    const messages = Array.isArray(body) ? body : [body];
    if (messages.some(message => isInitializeRequest(message)))
      await this._createSession(req, res, body);
    else
      await this._handleStatelessRequest(req, res, body);
  }

  // Serves one request from a client that skips the initialize handshake. The
  // SDK's stateless mode (`sessionIdGenerator: undefined`) performs no
  // session validation but insists on a fresh transport per request, so each
  // request gets its own transport, server and backend; the request then
  // flows into the server's lazy ensureInitialized() path. A stateless tool
  // call thus runs against a fresh default browser context — cross-request
  // browser state travels via browser_session_open handles instead, whose
  // registry the backend factory shares across the backends it creates. No
  // heartbeat: the response stream ends with the request, so there is no
  // long-lived connection to probe.
  private async _handleStatelessRequest(req: http.IncomingMessage, res: http.ServerResponse, parsedBody: unknown): Promise<void> {
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // Dispose the per-request server — and with it the backend's default
    // context, if the request ever created one — once the response finishes
    // or aborts. Shared state (the factory's browser-session registry and
    // the contexts it holds) deliberately survives this close.
    res.once('close', () => void transport.close().catch(e => testDebug(e)));
    try {
      await this._createStatelessServer().connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      // A failure before the response is written leaves the connection open,
      // and res 'close' — the disposal path above — only fires once the
      // client abandons it, which can be arbitrarily late. Close eagerly so
      // the transport (and any backend state behind it) does not linger;
      // close() is idempotent, so the 'close' listener firing later is fine.
      await transport.close().catch(e => testDebug(e));
      throw error;
    }
  }

  private async _createSession(req: http.IncomingMessage, res: http.ServerResponse, parsedBody: unknown): Promise<void> {
    const eventStreamReady = new ManualPromise<void>();
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: async sessionId => {
        testDebug(`create http session: ${transport.sessionId}`);
        this._sessions.set(sessionId, { transport, eventStreamReady });
        await mcpServer.connect(this._serverBackendFactory, transport, true, eventStreamReady);
      }
    });

    transport.onclose = () => {
      if (!transport.sessionId)
        return;
      this._sessions.delete(transport.sessionId);
      testDebug(`delete http session: ${transport.sessionId}`);
    };

    await transport.handleRequest(req, res, parsedBody);
  }
}

function hasJsonContentType(req: http.IncomingMessage): boolean {
  const contentType = req.headers['content-type'];
  if (!contentType)
    return false;
  // Media type only — parameters such as charset are irrelevant here.
  return contentType.split(';')[0].trim().toLowerCase() === 'application/json';
}

// Sessionless JSON POSTs are buffered here in user land (the parsed body is
// handed to the SDK), so this reader owns the message-size cap the SDK
// transports apply to the streams they read themselves. The value matches the
// SDK's own per-message transport limit (10 MB).
const maxJsonBodyBytes = STDIO_DEFAULT_MAX_BUFFER_SIZE;

class BodyTooLargeError extends Error {
  constructor() {
    super(`Request body exceeded maximum size of ${maxJsonBodyBytes} bytes`);
  }
}

function discardRequestBody(req: http.IncomingMessage): Promise<boolean> {
  if (req.destroyed)
    return Promise.resolve(false);
  if (req.complete)
    return Promise.resolve(true);
  return new Promise(resolve => {
    let discardedBytes = 0;
    const finish = (reusable: boolean) => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('close', onClose);
      if (!reusable)
        req.pause();
      resolve(reusable);
    };
    const onData = (chunk: Buffer) => {
      discardedBytes += chunk.length;
      if (discardedBytes >= maxJsonBodyBytes)
        finish(false);
    };
    const onEnd = () => finish(true);
    const onClose = () => finish(false);
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('close', onClose);
    req.resume();
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  // A declared oversize is rejected before reading a single chunk.
  if (Number(req.headers['content-length']) > maxJsonBodyBytes)
    throw new BodyTooLargeError();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    // Leave the request intact so the caller can discard the rest without
    // retaining it; destroying unread input can reset the 413 response.
    if (totalBytes > maxJsonBodyBytes)
      throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// ─── End of session compatibility layer ──────────────────────────────────────

function decorateServer(server: net.Server) {
  const sockets = new Set<net.Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  const close = server.close;
  server.close = (callback?: (err?: Error) => void) => {
    for (const socket of sockets)
      socket.destroy();
    sockets.clear();
    return close.call(server, callback);
  };
}

function validateRequestHeaders(httpServer: http.Server, req: http.IncomingMessage): { statusCode: number, message: string } | undefined {
  const allowedHosts = allowedHostnamesForServer(httpServer);
  const hostHeader = req.headers.host;
  const host = typeof hostHeader === 'string' ? parseAuthority(hostHeader) : undefined;
  if (!host) {
    testDebug('reject request with invalid host header: %o', hostHeader);
    return { statusCode: 400, message: 'Invalid Host header' };
  }
  if (!allowedHosts.has(host.hostname)) {
    testDebug('reject request for disallowed host %s; allowed hosts: %o', host.hostname, [...allowedHosts]);
    return { statusCode: 403, message: 'Forbidden Host header' };
  }

  const originHeader = req.headers.origin;
  if (!originHeader)
    return;

  const origin = parseOriginAuthority(originHeader);
  if (!origin) {
    testDebug('reject request with invalid origin header: %o', originHeader);
    return { statusCode: 400, message: 'Invalid Origin header' };
  }
  if (!allowedHosts.has(origin.hostname)) {
    testDebug('reject request for disallowed origin %s; allowed hosts: %o', origin.hostname, [...allowedHosts]);
    return { statusCode: 403, message: 'Forbidden Origin header' };
  }
  if (origin.scheme !== host.scheme) {
    testDebug('reject request with mismatched origin scheme %s for host scheme %s', origin.scheme, host.scheme);
    return { statusCode: 403, message: 'Forbidden Origin header' };
  }
  if (origin.authority !== host.authority) {
    testDebug('reject request with mismatched origin authority %s for host authority %s', origin.authority, host.authority);
    return { statusCode: 403, message: 'Forbidden Origin header' };
  }
}

function allowedHostnamesForServer(httpServer: http.Server): Set<string> {
  const allowed = new Set<string>(['localhost', '::1', '127.0.0.1']);
  const address = httpServer.address();
  if (!address || typeof address === 'string')
    return allowed;

  const boundAddress = normalizeHostname(address.address);
  if (boundAddress && !isWildcardAddress(boundAddress))
    allowed.add(boundAddress);
  return allowed;
}

function isWildcardAddress(hostname: string): boolean {
  return hostname === '0.0.0.0' || hostname === '::';
}

function validateRequestRouting(req: http.IncomingMessage): { statusCode: number, message: string } | undefined {
  const requestPath = parseRequestPath(req.url);
  if (!requestPath)
    return { statusCode: 400, message: 'Invalid request' };
  if (requestPath !== '/mcp')
    return { statusCode: 404, message: 'Not found' };
}

export function parseAuthority(authority: string): { hostname: string, authority: string, scheme: 'http' } | undefined {
  try {
    const url = new URL(`http://${authority}`);
    const hostname = normalizeHostname(url.hostname);
    return {
      hostname,
      authority: formatAuthority(hostname, url.port),
      scheme: 'http',
    };
  } catch {
    return;
  }
}

function parseOriginAuthority(origin: string): { hostname: string, authority: string, scheme: 'http' | 'https' } | undefined {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return;
    const hostname = normalizeHostname(url.hostname);
    return {
      hostname,
      authority: formatAuthority(hostname, url.port),
      scheme: url.protocol === 'https:' ? 'https' : 'http',
    };
  } catch {
    return;
  }
}

function parseRequestPath(requestUrl: string | undefined): string | undefined {
  if (!requestUrl)
    return;
  try {
    return new URL(requestUrl, 'http://127.0.0.1').pathname;
  } catch {
    return;
  }
}

function formatAuthority(hostname: string, port: string): string {
  const normalizedHost = hostname.includes(':') ? `[${hostname}]` : hostname;
  return port ? `${normalizedHost}:${port}` : normalizedHost;
}

function normalizeHostname(hostname: string): string {
  const lowerCase = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (lowerCase.startsWith('::ffff:'))
    return lowerCase.slice('::ffff:'.length);
  if (allowedLoopbackHostnamePattern.test(lowerCase))
    return '127.0.0.1';
  if (lowerCase.endsWith('.localhost'))
    return 'localhost';
  return lowerCase;
}
