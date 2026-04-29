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
import os from 'os';

import debug from 'debug';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as mcpServer from './server.js';
import {
  httpRequestsTotal,
  httpRequestDurationSeconds,
  activeSessionsGauge,
  getPodName,
  registry,
} from '../metrics/index.js';

import type { ServerBackendFactory } from './server.js';

function normalizeUserAgent(ua: string | undefined): string {
  return ua ?? 'unknown';
}

const testDebug = debug('pw:mcp:test');
const allowedLoopbackHostnamePattern = /^127(?:\.\d{1,3}){3}$/;

export async function startHttpServer(config: { host?: string, port?: number }, abortSignal?: AbortSignal): Promise<http.Server> {
  const { host, port } = config;
  const httpServer = http.createServer();
  decorateServer(httpServer);
  // Disable timeouts that would prematurely close long-lived SSE connections
  // when the server is behind a proxy (e.g. Kubernetes ingress).
  httpServer.requestTimeout = 0;
  httpServer.keepAliveTimeout = 0;
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
  const pod = getPodName();

  httpServer.on('request', async (req, res) => {
    const requestPath = parseRequestPath(req.url);
    const method = req.method ?? 'GET';
    const startMs = Date.now();
    const userAgent = normalizeUserAgent(req.headers['user-agent']);
    const username = (req.headers['x-username'] as string | undefined) ?? os.userInfo().username;

    // Intercept infrastructure endpoints before host-header validation so that
    // Prometheus (within the cluster) can scrape the pod by its IP address.
    if (requestPath === '/healthz') {
      const body = JSON.stringify({ status: 'ok', pod });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      httpRequestsTotal.inc({ endpoint: '/healthz', method, status_code: '200', user_agent: userAgent, username, pod });
      httpRequestDurationSeconds.observe({ endpoint: '/healthz', method, pod }, (Date.now() - startMs) / 1000);
      return;
    }

    if (requestPath === '/metrics') {
      const body = registry.exportMetrics();
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(body);
      httpRequestsTotal.inc({ endpoint: '/metrics', method, status_code: '200', user_agent: userAgent, username, pod });
      httpRequestDurationSeconds.observe({ endpoint: '/metrics', method, pod }, (Date.now() - startMs) / 1000);
      return;
    }

    const finishRequest = (statusCode: number, endpoint: string) => {
      httpRequestsTotal.inc({ endpoint, method, status_code: String(statusCode), user_agent: userAgent, username, pod });
      httpRequestDurationSeconds.observe({ endpoint, method, pod }, (Date.now() - startMs) / 1000);
    };

    const validationError = validateRequestHeaders(httpServer, req);
    if (validationError) {
      res.statusCode = validationError.statusCode;
      res.end(validationError.message);
      finishRequest(validationError.statusCode, requestPath ?? 'unknown');
      return;
    }
    const routingError = validateRequestRouting(req, !!req.headers['mcp-session-id']);
    if (routingError) {
      res.statusCode = routingError.statusCode;
      res.end(routingError.message);
      finishRequest(routingError.statusCode, requestPath ?? 'unknown');
      return;
    }

    res.on('finish', () => finishRequest(res.statusCode, requestPath ?? 'unknown'));
    await handleStreamable(serverBackendFactory, req, res, streamableSessions, pod, userAgent, username);
  });
}

async function handleStreamable(serverBackendFactory: ServerBackendFactory, req: http.IncomingMessage, res: http.ServerResponse, sessions: Map<string, StreamableHTTPServerTransport>, pod: string, userAgent: string = 'unknown', username: string = 'unknown') {
  const routingError = validateRequestRouting(req, !!req.headers['mcp-session-id']);
  if (routingError) {
    res.statusCode = routingError.statusCode;
    res.end(routingError.message);
    return;
  }
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId) {
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.statusCode = 404;
      res.end('Session not found');
      return;
    }

    if (req.method === 'GET') {
      // Disable socket timeout for long-lived SSE connections so that proxies
      // (Kubernetes ingress, nginx, etc.) don't close the stream due to inactivity.
      req.socket.setTimeout(0);

      // Send SSE comment keepalive every 15 seconds to prevent intermediate
      // proxies from treating the connection as idle and closing it.
      const keepaliveTimer = setInterval(() => {
        if (res.writableEnded) {
          clearInterval(keepaliveTimer);
          return;
        }
        try {
          res.write(':\n\n');
        } catch {
          clearInterval(keepaliveTimer);
        }
      }, 15000);
      res.on('finish', () => clearInterval(keepaliveTimer));
      res.on('close', () => clearInterval(keepaliveTimer));

      await transport.handleRequest(req, res);
      clearInterval(keepaliveTimer);
      return;
    }

    return await transport.handleRequest(req, res);
  }

  if (req.method === 'POST') {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: async (sessionId: string) => {
        testDebug(`create http session: ${transport.sessionId}`);
        await mcpServer.connect(serverBackendFactory, transport, true, { userAgent, username });
        sessions.set(sessionId, transport);
        activeSessionsGauge.inc({ pod });
      }
    });

    transport.onclose = () => {
      if (!transport.sessionId)
        return;
      sessions.delete(transport.sessionId);
      activeSessionsGauge.dec({ pod });
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

function validateRequestRouting(req: http.IncomingMessage, hasSessionId: boolean): { statusCode: number, message: string } | undefined {
  const requestPath = parseRequestPath(req.url);
  if (!requestPath)
    return { statusCode: 400, message: 'Invalid request' };
  if (requestPath !== '/mcp')
    return { statusCode: 404, message: 'Not found' };
  if (req.method === 'POST' || hasSessionId)
    return;
  return { statusCode: 400, message: 'Invalid request' };
}

function parseAuthority(authority: string): { hostname: string, authority: string, scheme: 'http' } | undefined {
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
