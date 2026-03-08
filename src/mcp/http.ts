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

import assert from 'assert';
import net from 'net';
import http from 'http';
import crypto from 'crypto';

import debug from 'debug';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as mcpServer from './server.js';

import type { ServerBackendFactory } from './server.js';

const testDebug = debug('pw:mcp:test');
const allowedLoopbackHostnamePattern = /^127(?:\.\d{1,3}){3}$/;

export async function startHttpServer(config: { host?: string, port?: number }, abortSignal?: AbortSignal): Promise<http.Server> {
  const { host, port } = config;
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
  let resolvedHost = address.family === 'IPv4' ? address.address : `[${address.address}]`;
  if (resolvedHost === '0.0.0.0' || resolvedHost === '[::]')
    resolvedHost = 'localhost';
  return `http://${resolvedHost}:${resolvedPort}`;
}

export async function installHttpTransport(httpServer: http.Server, serverBackendFactory: ServerBackendFactory) {
  const streamableSessions = new Map();
  httpServer.on('request', async (req, res) => {
    const validationError = validateRequestHeaders(httpServer, req);
    if (validationError) {
      res.statusCode = validationError.statusCode;
      res.end(validationError.message);
      return;
    }
    await handleStreamable(serverBackendFactory, req, res, streamableSessions);
  });
}

async function handleStreamable(serverBackendFactory: ServerBackendFactory, req: http.IncomingMessage, res: http.ServerResponse, sessions: Map<string, StreamableHTTPServerTransport>) {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId) {
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.statusCode = 404;
      res.end('Session not found');
      return;
    }
    return await transport.handleRequest(req, res);
  }

  if (req.method === 'POST') {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: async sessionId => {
        testDebug(`create http session: ${transport.sessionId}`);
        await mcpServer.connect(serverBackendFactory, transport, true);
        sessions.set(sessionId, transport);
      }
    });

    transport.onclose = () => {
      if (!transport.sessionId)
        return;
      sessions.delete(transport.sessionId);
      testDebug(`delete http session: ${transport.sessionId}`);
    };

    await transport.handleRequest(req, res);
    return;
  }

  res.statusCode = 400;
  res.end('Invalid request');
}

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
  const host = typeof hostHeader === 'string' ? parseHostname(hostHeader) : undefined;
  if (!host) {
    testDebug('reject request with invalid host header: %o', hostHeader);
    return { statusCode: 400, message: 'Invalid Host header' };
  }
  if (!allowedHosts.has(host)) {
    testDebug('reject request for disallowed host %s; allowed hosts: %o', host, [...allowedHosts]);
    return { statusCode: 403, message: 'Forbidden Host header' };
  }

  const originHeader = req.headers.origin;
  if (!originHeader)
    return;

  const originHost = parseOriginHostname(originHeader);
  if (!originHost) {
    testDebug('reject request with invalid origin header: %o', originHeader);
    return { statusCode: 400, message: 'Invalid Origin header' };
  }
  if (!allowedHosts.has(originHost)) {
    testDebug('reject request for disallowed origin %s; allowed hosts: %o', originHost, [...allowedHosts]);
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

function parseHostname(authority: string): string | undefined {
  try {
    return normalizeHostname(new URL(`http://${authority}`).hostname);
  } catch {
    return;
  }
}

function parseOriginHostname(origin: string): string | undefined {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return;
    return normalizeHostname(url.hostname);
  } catch {
    return;
  }
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
