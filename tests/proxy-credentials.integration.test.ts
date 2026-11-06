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

import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { chromium } from 'playwright';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { contextFactory } from '../src/browserContextFactory.js';
import { resolveCLIConfig } from '../src/config.js';
import { wrapInProcess } from '../src/mcp/server.js';

// Playwright 1.63.0 answered a website's 401 challenge with the cached proxy
// credentials after a 407 had been answered (microsoft/playwright#43482, #284).
// The server no longer warns about this, so the pinned runtime must prove the
// credentials reach only the proxy.
const requestedBrowser = process.env.MCP_TEST_BROWSER_NAME;
const browser = requestedBrowser || 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(browser))
  throw new Error(`MCP_TEST_BROWSER_NAME must be chromium, firefox or webkit; got ${JSON.stringify(browser)}`);
const canRun = !!requestedBrowser || existsSync(chromium.executablePath());
const require = createRequire(import.meta.url);
const versions = { playwright: require('playwright/package.json').version, playwrightCore: require('playwright-core/package.json').version };

const encoded = Buffer.from('proxy-user:proxy-secret').toString('base64');
const siteAuthorization: (string | null)[] = [];
let proxyAuthorized = 0;
const site = http.createServer((request, response) => {
  siteAuthorization.push(request.headers.authorization ?? null);
  response.writeHead(401, { 'www-authenticate': 'Basic realm="site"', 'content-type': 'text/html' });
  response.end('<title>Site login required</title>');
});
// A plain HTTP proxy that challenges with 407 until the browser authenticates.
const proxy = http.createServer((request, response) => {
  if (request.headers['proxy-authorization'] !== `Basic ${encoded}`) {
    response.writeHead(407, { 'proxy-authenticate': 'Basic realm="proxy"' });
    response.end();
    return;
  }
  proxyAuthorized++;
  const { port } = site.address() as { port: number };
  const headers = { ...request.headers };
  delete headers['proxy-authorization'];
  const upstream = http.request({ host: '127.0.0.1', port, path: new URL(request.url!).pathname, method: request.method, headers }, upstreamResponse => {
    response.writeHead(upstreamResponse.statusCode!, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', () => response.destroy());
  request.pipe(upstream);
});
let directory: string | undefined;
let client: Client | undefined;

beforeAll(async () => {
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  process.stdout.write(JSON.stringify({ platform: process.platform, browser, node: process.version, ...versions }) + '\n');
});

afterEach(async () => {
  try {
    if (client)
      await client.callTool({ name: 'browser_close', arguments: {} });
  } finally {
    await client?.close();
    if (directory)
      await fs.rm(directory, { recursive: true, force: true });
    client = directory = undefined;
  }
});

afterAll(async () => {
  for (const server of [site, proxy]) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it.skipIf(!canRun)(`sends proxy credentials only to the proxy (${browser}) #284`, async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-proxy-credentials-'));
  const { port } = proxy.address() as { port: number };
  const config = await resolveCLIConfig({
    browser,
    headless: true,
    isolated: true,
    outputDir: directory,
    proxyServer: `http://proxy-user:proxy-secret@127.0.0.1:${port}`,
  });
  client = new Client({ name: 'proxy-credentials-test', version: '1' });
  await client.connect(await wrapInProcess(new BrowserServerBackend(config, contextFactory(config))));

  // A non-loopback name, so Chromium does not bypass the proxy; the second
  // navigation reuses the cached proxy answer that used to leak. Without
  // httpCredentials, full Chromium fails a site's 401 rather than rendering
  // it (with or without a proxy); the other engines show the 401 page.
  for (const url of ['http://proxy-credential-probe.test/', 'http://proxy-credential-probe.test/again']) {
    const result = await client.callTool({ name: 'browser_navigate', arguments: { url } });
    const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    expect(text).toMatch(/Site login required|net::ERR_INVALID_AUTH_CREDENTIALS/);
  }
  process.stdout.write(JSON.stringify({ proxyAuthorized, siteAuthorization }) + '\n');
  expect(proxyAuthorized).toBeGreaterThanOrEqual(2);
  expect(siteAuthorization.length).toBeGreaterThanOrEqual(2);
  expect(siteAuthorization.filter(header => header?.includes(encoded))).toEqual([]);
});
