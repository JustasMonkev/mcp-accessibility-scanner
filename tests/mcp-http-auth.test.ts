import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { httpAddressToString, installHttpTransport, startHttpServer } from '../src/mcp/http.js';

import type { ServerBackendFactory } from '../src/mcp/server.js';

// The Host-header allowlist defends browsers against DNS rebinding, but any
// non-browser client can send `Host: localhost`, so it is not authentication.
// PLAYWRIGHT_MCP_HTTP_TOKEN is what actually gates the tool surface when the
// port is published beyond loopback. These drive a real socket rather than
// calling the validator, so a change to the request pipeline that skips the
// check is caught.

const testBackendFactory: ServerBackendFactory = {
  name: 'auth-test-backend',
  nameInConfig: 'auth-test-backend',
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

const servers = new Set<http.Server>();
let savedToken: string | undefined;

async function startServerWithToken(token: string | undefined): Promise<string> {
  savedToken = process.env.PLAYWRIGHT_MCP_HTTP_TOKEN;
  if (token === undefined)
    delete process.env.PLAYWRIGHT_MCP_HTTP_TOKEN;
  else
    process.env.PLAYWRIGHT_MCP_HTTP_TOKEN = token;
  const server = await startHttpServer({ port: 0 });
  servers.add(server);
  await installHttpTransport(server, testBackendFactory);
  return httpAddressToString(server.address());
}

async function post(url: string, headers: Record<string, string> = {}): Promise<{ status: number, body: string, wwwAuthenticate?: string }> {
  const response = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  return {
    status: response.status,
    body: await response.text(),
    wwwAuthenticate: response.headers.get('www-authenticate') ?? undefined,
  };
}

afterEach(async () => {
  await Promise.all([...servers].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  servers.clear();
  if (savedToken === undefined)
    delete process.env.PLAYWRIGHT_MCP_HTTP_TOKEN;
  else
    process.env.PLAYWRIGHT_MCP_HTTP_TOKEN = savedToken;
});

describe('http bearer token', () => {
  it('serves requests without a token when none is configured', async () => {
    const url = await startServerWithToken(undefined);
    const response = await post(url);
    expect(response.status).not.toBe(401);
  });

  it('treats a blank token as not configured', async () => {
    const url = await startServerWithToken('   ');
    const response = await post(url);
    expect(response.status).not.toBe(401);
  });

  it('rejects a request with no Authorization header once a token is set', async () => {
    const url = await startServerWithToken('s3cret-token');
    const response = await post(url);

    expect(response.status).toBe(401);
    expect(response.body).toBe('Unauthorized');
    // Tells a client how to authenticate rather than leaving it guessing.
    expect(response.wwwAuthenticate).toBe('Bearer');
  });

  it.each([
    ['wrong token', 'Bearer wrong-token'],
    ['token of the same length', 'Bearer s3cret-tokeX'],
    ['missing Bearer prefix', 's3cret-token'],
    ['empty bearer value', 'Bearer '],
    ['basic auth', 'Basic czNjcmV0LXRva2Vu'],
  ])('rejects %s', async (_label, authorization) => {
    const url = await startServerWithToken('s3cret-token');
    expect((await post(url, { authorization })).status).toBe(401);
  });

  it('accepts the configured token', async () => {
    const url = await startServerWithToken('s3cret-token');
    const response = await post(url, { authorization: 'Bearer s3cret-token' });
    expect(response.status).not.toBe(401);
  });

  it('accepts a case-insensitive Bearer scheme, as RFC 7235 requires', async () => {
    const url = await startServerWithToken('s3cret-token');
    expect((await post(url, { authorization: 'bearer s3cret-token' })).status).not.toBe(401);
  });

  // The Host check runs first and is not authentication; the token must still
  // be required for a request that passes it.
  it('requires the token even for a request with an allowed Host header', async () => {
    const url = await startServerWithToken('s3cret-token');
    expect((await post(url, { host: 'localhost' })).status).toBe(401);
  });

  it('rejects an unauthenticated request before routing, on any path', async () => {
    const url = await startServerWithToken('s3cret-token');
    const response = await fetch(`${url}/not-mcp`, { method: 'POST' });
    // 401 rather than 404: an unauthenticated client learns nothing about
    // which paths exist.
    expect(response.status).toBe(401);
  });
});
