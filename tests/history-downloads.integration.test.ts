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

import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { contextFactory, type BrowserContextFactory } from '../src/browserContextFactory.js';
import { resolveConfig, type FullConfig } from '../src/config.js';
import { wrapInProcess } from '../src/mcp/server.js';

const channel = process.env.MCP_TEST_BROWSER_CHANNEL || 'chromium';
const downloadBytes = Buffer.from('Local download: verified after profile reuse.\n');
const clients: Client[] = [];
const contexts: BrowserContext[] = [];
const browsers: Browser[] = [];
let directory: string;
let origin: string;
const server = http.createServer((request, response) => {
  if (request.url === '/download') {
    response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="fixture.txt"' });
    response.end(downloadBytes);
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  const pages: Record<string, string> = {
    '/a': '<title>Page A</title><input aria-label="Saved note"><a href="/b">Open B</a><iframe title="Child" src="/frame"></iframe><script>addEventListener("pageshow", e => document.body.dataset.restored = String(e.persisted))</script>',
    '/frame': '<a href="/b" target="_top">Frame open B</a>',
    '/b': '<title>Page B</title><h1>Page B</h1><a href="#plain">Plain ref control</a>',
    '/downloads': '<title>Download fixture</title><a href="/download">Download file</a>',
  };
  response.end(pages[request.url || ''] || '<title>Fixture</title>');
});

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP fixture server');
  origin = `http://127.0.0.1:${address.port}`;
  const require = createRequire(import.meta.url);
  process.stdout.write(JSON.stringify({ platform: process.platform, channel, node: process.version,
    playwright: require('playwright/package.json').version,
    playwrightCore: require('playwright-core/package.json').version }) + '\n');
});

beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-history-downloads-')); });

afterEach(async () => {
  const closedClients = await Promise.allSettled(clients.splice(0).map(async client => {
    try {
      await client.callTool({ name: 'browser_close', arguments: {} });
    } finally {
      await client.close();
    }
  }));
  const closedBrowsers = await Promise.allSettled(browsers.splice(0).map(browser => browser.close()));
  const closedContexts = await Promise.allSettled(contexts.splice(0).map(context => context.close()));
  await fs.rm(directory, { recursive: true, force: true });
  const errors = [...closedClients, ...closedBrowsers, ...closedContexts].filter(result => result.status === 'rejected');
  if (errors.length)
    throw new AggregateError(errors.map(result => result.reason), 'Browser fixture cleanup failed');
});

afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

async function connect(config: FullConfig, factory = contextFactory(config)) {
  const client = new Client({ name: 'history-downloads-test', version: '1' });
  clients.push(client);
  client.setRequestHandler('ping', () => ({}));
  await client.connect(await wrapInProcess(new BrowserServerBackend(config, factory)));
  return client;
}

async function call(client: Client, name: string, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  expect(result.isError, text).not.toBe(true);
  return text;
}

function linkRef(snapshot: string, name: string) {
  const line = snapshot.split('\n').find(line => line.includes(`link "${name}"`));
  const ref = line?.match(/\[ref=([^\]]+)\]/)?.[1];
  expect(ref, snapshot).toBeDefined();
  return ref!;
}

it.each([
  ['cdp', 'direct'], ['cdp', 'mcp'], ['launched', 'direct'], ['launched', 'mcp'],
] as const)('keeps returned main/frame refs usable after repeated back navigation (%s, %s) #231', async (mode, api) => {
  let context: BrowserContext;
  let factory: BrowserContextFactory;
  if (mode === 'cdp') {
    const profile = path.join(directory, 'profile');
    const external = await chromium.launchPersistentContext(profile, {
      channel, headless: true, args: ['--remote-debugging-port=0'],
      // External Chrome does not disable bfcache as Playwright's normal launch does.
      ignoreDefaultArgs: ['--disable-back-forward-cache'],
    });
    contexts.push(external);
    const port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim();
    const endpoint = `http://127.0.0.1:${port}`;
    const browser = await chromium.connectOverCDP(endpoint);
    browsers.push(browser);
    context = browser.contexts()[0];
    factory = contextFactory(await resolveConfig({ browser: { cdpEndpoint: endpoint } }));
  } else {
    const browser = await chromium.launch({ channel, headless: true });
    browsers.push(browser);
    context = await browser.newContext();
    await context.newPage();
    factory = { createContext: async () => ({ browserContext: context, close: () => context.close() }) };
  }
  process.stdout.write(JSON.stringify({ case: 'history', mode, api, browser: context.browser()!.version() }) + '\n');
  const page = context.pages()[0];
  const client = api === 'mcp' ? await connect(await resolveConfig({ outputDir: directory, timeouts: { settle: 0 } }), factory) : undefined;
  for (const pathname of ['/b', '/a']) {
    if (client)
      await call(client, 'browser_navigate', { url: origin + pathname });
    else
      await page.goto(origin + pathname);
    if (pathname === '/b') {
      const snapshot = client ? await call(client, 'browser_snapshot') : await page.ariaSnapshot({ mode: 'ai' });
      const ref = linkRef(snapshot, 'Plain ref control');
      expect(ref).toMatch(/^e\d+$/);
      if (client)
        await call(client, 'browser_click', { element: 'Plain ref control', ref });
      else
        await page.locator(`aria-ref=${ref}`).click();
      expect(page.url()).toBe(`${origin}/b#plain`);
    }
  }
  await page.getByRole('textbox', { name: 'Saved note' }).fill('Keep this form state');
  const initialHistory = await page.evaluate(() => history.length);
  let bfcacheRestores = 0;
  for (const name of ['Open B', 'Frame open B', 'Open B', 'Frame open B']) {
    const snapshot = client ? await call(client, 'browser_snapshot') : await page.ariaSnapshot({ mode: 'ai' });
    const ref = linkRef(snapshot, name);
    expect(ref).toMatch(/^f\d+e\d+$/);
    if (client)
      await call(client, 'browser_click', { element: name, ref });
    else
      await page.locator(`aria-ref=${ref}`).click();
    await expect.poll(() => page.url()).toBe(`${origin}/b`);
    if (client)
      await call(client, 'browser_navigate_back');
    else
      await page.goBack({ waitUntil: 'commit' });
    await expect.poll(() => page.url()).toBe(`${origin}/a`);
    await expect.poll(() => page.getByRole('textbox', { name: 'Saved note' }).inputValue()).toBe('Keep this form state');
    expect(await page.evaluate(() => history.length)).toBe(initialHistory + 1);
    if (await page.locator('body').getAttribute('data-restored') === 'true')
      bfcacheRestores++;
  }
  process.stdout.write(JSON.stringify({ case: 'history', mode, api, bfcacheRestores }) + '\n');
}, 60_000);

it.each([false, true])('saves download bytes and keeps browser/MCP alive across two launches (isolated: %s) #230', async isolated => {
  const profile = path.join(directory, 'profile');
  for (let launch = 0; launch < 2; launch++) {
    const outputDir = path.join(directory, `downloads-${launch}`);
    const config = await resolveConfig({
      browser: { isolated, userDataDir: isolated ? undefined : profile, launchOptions: {
        channel, headless: true,
        chromiumSandbox: channel === 'chromium-headless-shell' && process.platform === 'linux' ? false : undefined,
      } },
      outputDir, timeouts: { settle: 0 },
    });
    const factory = contextFactory(config);
    let context: BrowserContext | undefined;
    const client = await connect(config, {
      createContext: async (...args) => {
        const result = await factory.createContext(...args);
        context = result.browserContext;
        return result;
      },
    });
    await call(client, 'browser_navigate', { url: `${origin}/downloads` });
    const page = context!.pages()[0];
    process.stdout.write(JSON.stringify({ case: 'download', isolated, launch, browser: context!.browser()!.version() }) + '\n');
    expect(await page.evaluate(() => localStorage.getItem('previousLaunch'))).toBe(!isolated && launch ? 'saved' : null);
    await page.evaluate(() => localStorage.setItem('previousLaunch', 'saved'));
    const snapshot = await call(client, 'browser_snapshot');
    await call(client, 'browser_click', { element: 'Download file', ref: linkRef(snapshot, 'Download file') });
    await expect.poll(async () => {
      const files = await fs.readdir(outputDir);
      return Promise.all(files.filter(file => file.endsWith('.txt')).map(file => fs.readFile(path.join(outputDir, file), 'utf8')));
    }, { timeout: 10_000 }).toEqual([downloadBytes.toString()]);
    expect(page.isClosed()).toBe(false);
    expect(context!.browser()!.isConnected()).toBe(true);
    expect(await call(client, 'browser_snapshot')).toContain('Download fixture');
    await client.ping();
    await call(client, 'browser_close');
    await client.close();
    clients.splice(clients.indexOf(client), 1);
  }
}, 60_000);
