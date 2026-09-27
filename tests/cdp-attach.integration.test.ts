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
import net from 'node:net';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { contextFactory } from '../src/browserContextFactory.js';
import { resolveConfig, type FullConfig } from '../src/config.js';

const require = createRequire(import.meta.url);
const playwrightCoreVersion: string = require('playwright-core/package.json').version;
// Playwright 1.63.0 never finishes attaching while an existing tab has no
// renderer (microsoft/playwright#42936, unreleased when this was recorded).
// Any other version must attach and omit that tab: an upgrade does not
// inherit the known hang, it has to prove the fix.
const knownAttachHang = playwrightCoreVersion === '1.63.0';
// Far below Playwright's 30s default, so an ignored configured timeout fails.
const attachBound = 15000;

const browsers: Browser[] = [];
const backends: BrowserServerBackend[] = [];
let origin: string;
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(request.url === '/healthy' ? '<title>Healthy tab</title><p>Still here</p>' : '<title>Doomed tab</title>');
});

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  process.stdout.write(JSON.stringify({ platform: process.platform, node: process.version, playwrightCore: playwrightCoreVersion, knownAttachHang }) + '\n');
});

afterEach(async () => {
  for (const backend of backends.splice(0))
    backend.serverClosed();
  await Promise.all(browsers.splice(0).map(browser => browser.close()));
});

afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

function isListening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

/** A disposable browser with one healthy tab and one whose renderer crashed. */
async function launchWithCrashedTab() {
  const port = await freePort();
  browsers.push(await chromium.launch({ args: [`--remote-debugging-port=${port}`] }));
  const endpoint = `http://127.0.0.1:${port}`;
  const setup = await chromium.connectOverCDP(endpoint);
  const context = setup.contexts()[0];
  await (await context.newPage()).goto(`${origin}/healthy`);
  const doomed = await context.newPage();
  await doomed.goto(`${origin}/doomed`);
  const crashed = doomed.waitForEvent('crash');
  doomed.goto('chrome://crash').catch(() => {});
  await crashed;
  await setup.close();
  const tabs = await listTabs(endpoint);
  expect(tabs).toHaveLength(2);
  expect(tabs).toContainEqual({ url: `${origin}/healthy`, title: 'Healthy tab' });
  return { endpoint, port, tabs };
}

/** The browser's own tab list, read without attaching Playwright. */
async function listTabs(endpoint: string) {
  const targets = await (await fetch(`${endpoint}/json/list`)).json() as { type: string, url: string, title: string }[];
  return targets.filter(target => target.type === 'page').map(({ url, title }) => ({ url, title })).sort((a, b) => a.url.localeCompare(b.url));
}

async function listTabsThroughMcp(config: FullConfig) {
  const backend = new BrowserServerBackend(config, contextFactory(config));
  backends.push(backend);
  await backend.initialize({ notifyToolListChanged: async () => {} }, { name: 'vitest', version: '1.0.0' });
  const started = Date.now();
  const result = await backend.callTool('browser_tabs', { action: 'list' });
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  return { result, text, elapsed: Date.now() - started };
}

describe('CDP attach with a tab without a renderer (#244)', () => {
  it('pins Playwright\'s own attach behavior', async () => {
    const { endpoint, tabs } = await launchWithCrashedTab();
    const attached = await chromium.connectOverCDP(endpoint, { timeout: 2000 }).catch((error: Error) => error);
    if (knownAttachHang) {
      expect(attached).toBeInstanceOf(Error);
      expect((attached as Error).name).toBe('TimeoutError');
      expect((attached as Error).message).toContain('<ws connected>');
    } else {
      const browser = attached as Browser;
      expect(browser.contexts()[0].pages().map(page => page.url())).toEqual([`${origin}/healthy`]);
      await browser.close();
    }
    expect(await listTabs(endpoint)).toEqual(tabs);
  });

  it('bounds and explains a blocked --cdp-endpoint attach without touching the user\'s tabs', async () => {
    const { endpoint, tabs } = await launchWithCrashedTab();
    const config = await resolveConfig({ browser: { cdpEndpoint: endpoint, cdpTimeout: 2000 }, timeouts: { settle: 50 } });
    const { result, text, elapsed } = await listTabsThroughMcp(config);
    if (knownAttachHang) {
      expect(result.isError, text).toBe(true);
      expect(text).toContain('Timeout 2000ms exceeded');
      expect(text).toContain('Playwright did not finish attaching before the timeout');
      expect(text).toContain('a tab without a renderer (crashed, or discarded by Memory Saver)');
      expect(elapsed).toBeLessThan(attachBound);
    } else {
      expect(result.isError, text).not.toBe(true);
      expect(text).toContain(`${origin}/healthy`);
    }
    expect(await listTabs(endpoint)).toEqual(tabs);
  });

  // A --cdp-timeout above the startup budget, or 0 (disabled), must not let a
  // hung attach outlast --cdp-launch-startup-timeout.
  it.each([1000, 0])('bounds and explains a blocked --cdp-launch attach (cdpTimeout %i), then stops only the launched app', async cdpTimeout => {
    const { endpoint, port, tabs } = await launchWithCrashedTab();
    // The "launched application" forwards its CDP port to the prepared
    // browser, so the tab has crashed before the launch path's first attach.
    const forwarder = `const net = require('node:net');
      const [port, target] = process.argv.slice(1).map(Number);
      net.createServer(socket => {
        const upstream = net.connect(target, '127.0.0.1');
        socket.pipe(upstream).pipe(socket);
        socket.on('error', () => upstream.destroy());
        upstream.on('error', () => socket.destroy());
      }).listen(port, '127.0.0.1');`;
    const launchPort = await freePort();
    const config = await resolveConfig({
      browser: {
        cdpLaunch: { command: process.execPath, args: ['-e', forwarder, '{port}', String(port)], port: launchPort, startupTimeoutMs: 3000 },
        cdpTimeout,
      },
      timeouts: { settle: 50 },
    });
    const { result, text, elapsed } = await listTabsThroughMcp(config);
    if (knownAttachHang) {
      expect(result.isError, text).toBe(true);
      expect(text).toContain(`Timed out waiting for CDP endpoint http://127.0.0.1:${launchPort}.`);
      expect(text).toContain('Playwright did not finish attaching before the timeout');
      expect(elapsed).toBeLessThan(attachBound);
      // The launched app is the server's own to stop; the browser behind it
      // keeps every tab.
      await expect.poll(() => isListening(launchPort), { timeout: 10000 }).toBe(false);
    } else {
      expect(result.isError, text).not.toBe(true);
      expect(text).toContain(`${origin}/healthy`);
    }
    expect(await listTabs(endpoint)).toEqual(tabs);
  });
});
