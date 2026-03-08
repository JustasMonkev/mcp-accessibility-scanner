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
import { afterEach, describe, expect, it } from 'vitest';
import { installHttpTransport, startHttpServer } from '../src/mcp/http.js';

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

  async function startServer() {
    const server = await startHttpServer({ host: '127.0.0.1', port: 0 });
    servers.add(server);
    await installHttpTransport(server, testBackendFactory);
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP server address');
    return { server, port: address.port };
  }

  async function sendRequest(port: number, options?: { path?: string, hostHeader?: string, origin?: string }) {
    const response = await new Promise<{ statusCode: number, body: string }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: options?.path ?? '/mcp',
        method: 'GET',
        headers: {
          ...(options?.hostHeader ? { host: options.hostHeader } : {}),
          ...(options?.origin ? { origin: options.origin } : {}),
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

  it('allows loopback host aliases and same-host loopback origins', async () => {
    const { port } = await startServer();

    const response = await sendRequest(port, {
      hostHeader: `localhost:${port}`,
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

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('Invalid request');
  });
});
