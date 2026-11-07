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

import http from 'node:http';
import { expect, it } from 'vitest';
import { chromium, firefox, webkit } from 'playwright';
import { Client } from '@modelcontextprotocol/client';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { resolveConfig } from '../src/config.js';
import { wrapInProcess } from '../src/mcp/server.js';

const browserName = process.env.MCP_TEST_BROWSER_NAME || 'chromium';
if (browserName !== 'chromium' && browserName !== 'firefox' && browserName !== 'webkit')
  throw new Error(`Unsupported MCP_TEST_BROWSER_NAME: ${browserName}`);
const browserType = { chromium, firefox, webkit }[browserName];

it(`reports consumed response body metadata without replaying requests (${browserName})`, async () => {
  const hits = new Map<string, number>();
  const server = http.createServer((request, response) => {
    const route = request.url!;
    hits.set(route, (hits.get(route) ?? 0) + 1);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'application/octet-stream');
    if (route === '/') {
      response.setHeader('content-type', 'text/html');
      response.end('<link rel="icon" href="data:,"><h1>Body fixture</h1>');
    } else if (route === '/head') {
      response.setHeader('content-length', '100');
      response.end();
    } else if (route === '/no-content') {
      response.writeHead(204);
      response.end();
    } else if (route === '/redirect') {
      response.writeHead(302, { location: '/redirect-target' });
      response.end();
    } else if (route === '/truncated') {
      response.writeHead(200, { 'content-length': '10' });
      response.write('x');
      setImmediate(() => response.destroy());
    } else if (route === '/chunked-empty') {
      response.writeHead(200, { 'transfer-encoding': 'chunked' });
      response.end();
    } else if (route === '/chunked') {
      response.writeHead(200, { 'transfer-encoding': 'chunked' });
      response.end('chunk');
    } else {
      response.end(route === '/empty' ? '' : route === '/large' ? Buffer.alloc(15_000_000, 120) : 'body');
    }
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP fixture server');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const browser = await browserType.launch({ timeout: 10_000 });
    const client = new Client({ name: 'network-body-test', version: '1' });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const config = await resolveConfig({ timeouts: { navigationTimeout: 5000, defaultTimeout: 5000, settle: 0 } });
      await client.connect(await wrapInProcess(new BrowserServerBackend(config, {
        createContext: async () => ({ browserContext: context, close: () => context.close() }),
      })));
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const result = await client.callTool({ name, arguments: args });
        const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
        expect(result.isError, text).not.toBe(true);
        return text;
      };
      await call('browser_navigate', { url: origin });
      const cases: [string, string, number][] = [
        ['/empty', 'GET', 0], ['/body', 'GET', 4], ['/head', 'HEAD', 0],
        ['/no-content', 'GET', 0], ['/chunked', 'GET', 5], ['/chunked-empty', 'GET', 0],
        ['/redirect', 'GET', 4], ['/truncated', 'GET', -1],
      ];
      if (browserType === firefox)
        cases.push(['/large', 'GET', 15_000_000]);
      for (const [route, method, size] of cases) {
        const consumed = await page.evaluate(async ({ route, method }) => {
          const controller = new AbortController();
          const deadline = setTimeout(() => controller.abort(), 2000);
          try {
            return (await (await fetch(route, { method, signal: controller.signal })).arrayBuffer()).byteLength;
          } catch {
            return -1;
          } finally {
            clearTimeout(deadline);
          }
        }, { route, method });
        expect(consumed).toBe(size);
        const listing = await call('browser_network_requests');
        const line = listing.split('\n').find(line => line.includes(`[${method}] ${origin}${route} =>`));
        const id = line?.match(/^\[(\d+)\]/)?.[1];
        expect(id, listing).toBeDefined();
        const details = await call('browser_network_request', { index: Number(id) });
        const body = details.split('#### Response body\n')[1]?.split('\n\n')[0].trim();
        if (route === '/large')
          expect(body).toMatch(/^<(?:redacted, 15000000 bytes, application\/octet-stream|body unavailable: .+was evicted!)>$/);
        else if (route === '/chunked-empty' && browserType === webkit)
          expect(body).toMatch(/^<(?:empty|body unavailable: [\s\S]*Missing content of resource for given requestId[\s\S]*)>$/);
        else if (route === '/redirect' || route === '/truncated')
          expect(body).toMatch(/^<body unavailable: [\s\S]+>$/);
        else
          expect(body, `${browserType.name()} ${method} ${route}`).toBe(size ? `<redacted, ${size} bytes, application/octet-stream>` : '<empty>');
        expect(hits.get(route)).toBe(1);
      }
      expect(hits.get('/redirect-target')).toBe(1);
      expect(page.url()).toBe(`${origin}/`);
      expect(hits.get('/')).toBe(1);
      for (const [route, count] of hits)
        expect(count, route).toBe(1);
    } finally {
      try {
        await client.close();
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 30_000);
