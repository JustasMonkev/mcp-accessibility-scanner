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
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, firefox, webkit, type Browser, type BrowserContext } from 'playwright';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { resolveConfig } from '../src/config.js';
import { ensureNetworkPolicyRoutes } from '../src/networkPolicy.js';

const browserName = process.env.MCP_TEST_BROWSER_NAME || 'chromium';
if (browserName !== 'chromium' && browserName !== 'firefox' && browserName !== 'webkit')
  throw new Error(`Unsupported MCP_TEST_BROWSER_NAME: ${browserName}`);
const browserType = { chromium, firefox, webkit }[browserName];
const canRun = !!process.env.MCP_TEST_BROWSER_NAME || existsSync(browserType.executablePath());
const require = createRequire(import.meta.url);
const hits = new Map<string, number>();
let origin: string;
let browser: Browser;
const server = http.createServer((request, response) => {
  const url = new URL(request.url!, origin);
  hits.set(request.url!, (hits.get(request.url!) || 0) + 1);
  response.setHeader('cache-control', 'no-store');
  if (url.pathname === '/body') {
    response.setHeader('content-type', 'application/octet-stream');
    response.end(Buffer.alloc(Number(url.searchParams.get('size')), 120));
    return;
  }
  if (url.pathname === '/sw.js') {
    response.setHeader('content-type', 'text/javascript');
    response.end(`self.addEventListener('install', () => self.skipWaiting());
      self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', () => {
        const start = Date.now();
        while (Date.now() - start < 500) {}
      });`);
    return;
  }
  if (url.pathname === '/simple.json') {
    response.setHeader('content-type', 'application/json');
    response.end('{"foo":"bar"}');
    return;
  }
  response.setHeader('content-type', 'text/html');
  if (url.pathname === '/form') {
    response.end(`<link rel="icon" href="data:,"><style>
      @keyframes hide { to { visibility: hidden } }
      #cover { position:fixed;inset:0;background:white;animation:hide .3s step-end forwards }
      </style><form method="post" action="/submitted?${url.searchParams}">
      <button>Submit fixture</button></form>${url.searchParams.has('overlay') ? '<div id="cover"></div>' : ''}`);
    return;
  }
  response.end('<link rel="icon" href="data:,"><h1>Network fixture</h1><output></output>');
});

describe.skipIf(!canRun)(`Playwright 1.65 network gates (${browserName})`, () => {
  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP fixture server');
    origin = `http://127.0.0.1:${address.port}`;
    browser = await browserType.launch();
    process.stdout.write(JSON.stringify({ browserName, browserVersion: browser.version(), platform: process.platform,
      node: process.version, playwright: require('playwright/package.json').version,
      playwrightCore: require('playwright-core/package.json').version }) + '\n');
  });

  afterAll(async () => {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  async function backendFor(context: BrowserContext) {
    context.setDefaultTimeout(5000);
    const backend = new BrowserServerBackend(await resolveConfig({
      timeouts: { defaultTimeout: 5000, navigationTimeout: 5000, settle: 10 },
    }), { createContext: async () => ({ browserContext: context, close: () => context.close() }) });
    await backend.initialize({ notifyToolListChanged: async () => {} }, { name: 'pw165-network', version: '1' });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await backend.callTool(name, args);
      const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      expect(result.isError, text).not.toBe(true);
      return text;
    };
    return { backend, call };
  }

  it.each([true, false])('retries a CSS-obscured native form exactly once with javaScriptEnabled=%s (#257)', async javaScriptEnabled => {
    const context = await browser.newContext({ javaScriptEnabled });
    const { backend, call } = await backendFor(context);
    try {
      for (const overlay of [true, false]) {
        const query = `js=${javaScriptEnabled}${overlay ? '&overlay=1' : ''}`;
        const snapshot = await call('browser_navigate', { url: `${origin}/form?${query}` });
        const ref = snapshot.split('\n').find(line => line.includes('button "Submit fixture"'))?.match(/\[ref=([^\]]+)\]/)?.[1];
        if (!ref)
          throw new Error(`Missing submit reference in ${snapshot}`);
        // Snapshot capture can outlast the 300 ms animation. Re-arm the CSS
        // overlay immediately before the action, without a page timer.
        if (overlay) {
          const cover = context.pages()[0].locator('#cover');
          await cover.evaluate(element => element.replaceWith(element.cloneNode(true)));
          expect(await cover.isVisible()).toBe(true);
        }
        const started = Date.now();
        await call('browser_click', { element: 'Submit fixture', ref });
        expect(Date.now() - started).toBeLessThan(7000);
        expect(hits.get(`/submitted?${query}`)).toBe(1);
        process.stdout.write(JSON.stringify({ case: 'no-js-retry', javaScriptEnabled, overlay, submissions: hits.get(`/submitted?${query}`) }) + '\n');
      }
    } finally {
      backend.serverClosed();
      await context.close();
    }
  });

  it('reports consumed non-refetchable response bytes or an explicit body error, preserving valid empty responses (#257)', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const { backend, call } = await backendFor(context);
    try {
      await call('browser_navigate', { url: origin });
      for (const size of [0, 50_000, 5_000_000, 15_000_000]) {
        const route = `/body?size=${size}`;
        expect(await page.evaluate(async route => (await (await fetch(route)).arrayBuffer()).byteLength, route)).toBe(size);
        const listing = await call('browser_network_requests');
        const id = listing.split('\n').find(line => line.includes(`[GET] ${origin}${route} =>`))?.match(/^\[(\d+)\]/)?.[1];
        if (!id)
          throw new Error(`Missing body request in ${listing}`);
        const details = await call('browser_network_request', { index: Number(id) });
        const body = details.split('#### Response body\n')[1]?.split('\n\n')[0].trim();
        process.stdout.write(JSON.stringify({ case: 'consumed-body', size, body, requests: hits.get(route) }) + '\n');
        expect(hits.get(route)).toBe(1);
        if (size === 0)
          expect(body).toBe('<empty>');
        else
          expect(body, `Consumed ${size} bytes must not silently become empty`).toMatch(new RegExp(`^<(?:redacted, ${size} bytes, application/octet-stream|body unavailable: .+)>$`));
      }
    } finally {
      backend.serverClosed();
      await context.close();
    }
  });

  it.each(['allow', 'block'] as const)('continues existing-page requests across interception disable/re-enable with serviceWorkers=%s (#296)', async serviceWorkers => {
    const context = await browser.newContext({ serviceWorkers });
    const page = await context.newPage();
    const { backend, call } = await backendFor(context);
    try {
      await page.goto(origin);
      await call('browser_snapshot');
      if (serviceWorkers === 'allow') {
        await page.evaluate(async () => {
          const controlled = new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
          await navigator.serviceWorker.register('/sw.js');
          await controlled;
        });
        expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
      }
      const handler = (route: import('playwright').Route) => route.fulfill({ body: 'mocked' });
      for (let round = 0; round < 3; round++) {
        await page.route('**/never-requested', handler);
        await page.unroute('**/never-requested', handler);
        const route = `/simple.json?workers=${serviceWorkers}&round=${round}`;
        const requested = page.waitForRequest(`${origin}${route}`);
        await page.evaluate(route => {
          document.querySelector('output')!.textContent = '';
          void fetch(route).then(response => response.text()).then(body => {
            document.querySelector('output')!.textContent = body;
          }, error => {
            document.querySelector('output')!.textContent = String(error);
          });
        }, route);
        await requested;
        await page.route('**/never-requested', handler);
        await expect.poll(() => page.locator('output').textContent(), { timeout: 5000 }).toBe('{"foo":"bar"}');
        expect(hits.get(route)).toBe(1);
        await page.unroute('**/never-requested', handler);
        expect(await call('browser_snapshot')).toContain('Network fixture');
      }
      process.stdout.write(JSON.stringify({ case: 'interception-transition', serviceWorkers, rounds: 3 }) + '\n');
    } finally {
      backend.serverClosed();
      await context.close();
    }
  });

  it.skipIf(browserName !== 'chromium')('keeps origin policy enforced after existing-page setup and sibling-context teardown (#296)', async () => {
    const blockedOrigin = origin.replace('127.0.0.1', 'localhost');
    const config = await resolveConfig({ network: { blockedOrigins: [new URL(blockedOrigin).host] } });
    const contexts = await Promise.all([browser.newContext({ serviceWorkers: 'block' }), browser.newContext({ serviceWorkers: 'block' })]);
    try {
      const pages = await Promise.all(contexts.map(context => context.newPage()));
      // Prove this destination is reachable before enabling policy: a DNS or
      // connection failure must not masquerade as successful enforcement.
      await pages[0].goto(`${blockedOrigin}/policy-control`);
      expect(hits.get('/policy-control')).toBe(1);
      await Promise.all(pages.map(page => page.goto(origin)));
      await Promise.all(contexts.map(context => ensureNetworkPolicyRoutes(config, context)));
      for (let index = 0; index < pages.length; index++) {
        const page = pages[index];
        const route = `/policy-blocked?context=${index}`;
        expect(await page.evaluate(url => fetch(url).then(() => true, () => false), blockedOrigin + route)).toBe(false);
        expect(hits.has(route)).toBe(false);
        expect(await page.evaluate(async url => (await fetch(url)).text(), `${origin}/simple.json?policy=${index}`)).toBe('{"foo":"bar"}');
        await contexts[index].close();
      }
    } finally {
      await Promise.all(contexts.map(context => context.close()));
    }
  });
});
