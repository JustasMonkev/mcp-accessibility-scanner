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
import { chromium, type BrowserContext } from 'playwright';
import { Client } from '@modelcontextprotocol/client';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { resolveConfig } from '../src/config.js';
import { wrapInProcess } from '../src/mcp/server.js';

it('retains bounded request history with stable IDs across real MCP navigation, tabs, and sessions', async () => {
  const heldResponse = Promise.withResolvers<http.ServerResponse>();
  const server = http.createServer((request, response) => {
    if (request.url === '/preexisting') {
      heldResponse.resolve(response);
      return;
    }
    if (request.url === '/abort') {
      response.destroy();
      return;
    }
    if (request.url?.startsWith('/api/')) {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end('{"ok":true}');
      return;
    }
    const name = request.url?.slice(1) || 'blank';
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    response.end(`<link rel="icon" href="data:,"><h1>${name}</h1><script>fetch('/api/${name}')</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP fixture server');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const browser = await chromium.launch();
    const client = new Client({ name: 'network-history-test', version: '1' });
    try {
      let providedContext: BrowserContext | undefined = await browser.newContext();
      const existingPage = await providedContext.newPage();
      await Promise.all([
        existingPage.waitForEvent('request', request => request.url() === `${origin}/preexisting`),
        existingPage.evaluate(url => { location.href = url; }, `${origin}/preexisting`),
      ]);
      const pendingResponse = await heldResponse.promise;
      const config = await resolveConfig({ timeouts: { settle: 20 } });
      await client.connect(await wrapInProcess(new BrowserServerBackend(config, {
        createContext: async () => {
          const browserContext = providedContext ?? await browser.newContext();
          providedContext = undefined;
          return { browserContext, close: () => browserContext.close() };
        },
      })));
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const result = await client.callTool({ name, arguments: args });
        const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
        expect(result.isError, text).not.toBe(true);
        return text;
      };
      const requestId = (listing: string, url: string) => {
        const line = listing.split('\n').find(line => line.includes(`[GET] ${url} =>`));
        const id = line?.match(/^\[(\d+)\]/)?.[1];
        if (!id)
          throw new Error(`Missing request ${url} in ${listing}`);
        return Number(id);
      };

      await call('browser_tabs', { action: 'list' });
      expect(await call('browser_network_requests')).not.toContain('/preexisting');
      pendingResponse.writeHead(402, { 'content-type': 'text/html' });
      pendingResponse.end('<link rel="icon" href="data:,"><h1>Preexisting navigation</h1>');
      await existingPage.waitForURL(`${origin}/preexisting`);
      const preexisting = await call('browser_network_requests');
      const preexistingId = requestId(preexisting, `${origin}/preexisting`);
      expect(preexisting).toContain(`${origin}/preexisting => [402] Payment Required`);
      expect(await call('browser_network_request', { index: preexistingId })).toContain(`[402] Payment Required`);
      expect(await call('browser_snapshot')).toContain('- HTTP status: 402 Payment Required');

      await call('browser_navigate', { url: `${origin}/first` });
      await expect.poll(() => call('browser_network_requests')).toContain(`${origin}/api/first => [200]`);
      const first = await call('browser_network_requests');
      const firstId = requestId(first, `${origin}/api/first`);
      expect(await call('browser_network_requests')).toBe(first);

      await call('browser_navigate', { url: `${origin}/second` });
      const current = await call('browser_network_requests');
      expect(current).not.toContain('/first');
      const all = await call('browser_network_requests', { all: true });
      expect(requestId(all, `${origin}/api/first`)).toBe(firstId);
      expect(all).toContain(`${origin}/second`);
      const previous = await call('browser_network_request', { index: firstId });
      expect(previous).toContain(`### [${firstId}] [GET] ${origin}/api/first`);
      expect(previous).toContain('#### Request headers');

      await call('browser_evaluate', { function: 'async () => { await Promise.all(Array.from({ length: 201 }, (_, i) => fetch(`/api/bulk-${i}`))); await fetch("/abort").catch(() => {}); }' });
      await call('browser_navigate', { url: `${origin}/third` });
      const retained = await call('browser_network_requests', { all: true });
      expect(retained).not.toContain('/first');
      expect(retained.match(/^\[\d+\]/gm)?.length).toBeLessThanOrEqual(202);
      const thirdId = requestId(retained, `${origin}/third`);
      expect(thirdId).toBeGreaterThan(201);
      const stale = await client.callTool({ name: 'browser_network_request', arguments: { index: firstId } });
      expect(stale.isError).toBe(true);
      expect(JSON.stringify(stale.content)).toContain(`No retained network request with index ${firstId}`);
      const failureId = Number(retained.split('\n').find(line => line.includes(`${origin}/abort`))?.match(/^\[(\d+)\]/)?.[1]);
      expect(await call('browser_network_request', { index: failureId })).toContain('The request failed:');

      await call('browser_tabs', { action: 'new' });
      expect(await call('browser_network_requests', { all: true })).not.toContain('/third');
      await call('browser_navigate', { url: `${origin}/separate-tab` });
      expect(await call('browser_network_requests', { all: true })).not.toContain('/third');
      const otherTab = await client.callTool({ name: 'browser_network_request', arguments: { index: thirdId } });
      expect(otherTab.isError).toBe(true);
      await call('browser_tabs', { action: 'close' });
      expect(await call('browser_network_request', { index: thirdId })).toContain(`${origin}/third`);

      const opened = await client.callTool({ name: 'browser_session_open', arguments: {} });
      const browserSessionId = opened.structuredContent?.browserSessionId;
      if (typeof browserSessionId !== 'string')
        throw new Error('Expected an explicit browser session handle');
      await call('browser_navigate', { url: `${origin}/separate-session`, browserSessionId });
      const separate = await call('browser_network_requests', { all: true, browserSessionId });
      expect(separate).toContain('/separate-session');
      expect(separate).not.toContain('/third');
      const otherSession = await client.callTool({ name: 'browser_network_request', arguments: { index: thirdId, browserSessionId } });
      expect(otherSession.isError).toBe(true);
      await call('browser_session_close', { browserSessionId });
      expect(await call('browser_network_request', { index: thirdId })).toContain(`${origin}/third`);
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
}, 30000);
