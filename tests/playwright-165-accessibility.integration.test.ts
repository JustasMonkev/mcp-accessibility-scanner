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
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { chromium } from 'playwright';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { contextFactory } from '../src/browserContextFactory.js';
import { resolveCLIConfig } from '../src/config.js';
import { wrapInProcess } from '../src/mcp/server.js';

const requestedBrowser = process.env.MCP_TEST_BROWSER_NAME;
const browser = requestedBrowser || 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(browser))
  throw new Error(`MCP_TEST_BROWSER_NAME must be chromium, firefox or webkit; got ${JSON.stringify(browser)}`);
const canRun = !!requestedBrowser || existsSync(chromium.executablePath());
const names = `<title>Named accessibility roles</title>
<nav aria-label="Primary"><a href="/docs"><strong>Docs</strong></a></nav>
<dialog open aria-label="Preferences"><button>Save preferences</button></dialog>
<table aria-label="Roster"><tr><th scope="col">Member</th><th scope="col">Access</th></tr>
<tr><td>Ada</td><td>Editor</td></tr></table>
<button id="unnamed"></button>`;
const controls = `<title>Inert controls</title>
<section id="target-container"><button id="target">Target action</button></section>
<button id="control">Control action</button>
<p id="target-count">Target activations: 0</p><p id="control-count">Control activations: 0</p>
<script>
  for (const id of ['target', 'control']) {
    let count = 0;
    document.getElementById(id).addEventListener('click', () => {
      document.getElementById(id + '-count').textContent =
        (id === 'target' ? 'Target' : 'Control') + ' activations: ' + ++count;
    });
  }
</script>`;
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(request.url === '/controls' ? controls : names);
});
let directory: string | undefined;
let client: Client | undefined;
let origin: string;

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP fixture server');
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  try {
    if (client)
      await client.callTool({ name: 'browser_close', arguments: {} });
  } finally {
    try {
      await client?.close();
    } finally {
      client = undefined;
      if (directory)
        await fs.rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  }
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function setup(device?: string) {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-playwright-165-'));
  const config = await resolveCLIConfig({
    browser, device, headless: true, isolated: true, outputDir: directory,
    defaultTimeout: 1000, navigationTimeout: 5000, timeoutSettle: 0,
  });
  expect(config.browser.browserName).toBe(browser);
  const factory = contextFactory(config);
  const createContext = factory.createContext.bind(factory);
  factory.createContext = async (...args) => {
    const handle = await createContext(...args);
    const actual = handle.browserContext.browser();
    try {
      expect(actual?.browserType().name()).toBe(browser);
      process.stdout.write(JSON.stringify({ browser: actual!.browserType().name(), version: actual!.version(), device, screen: config.browser.contextOptions?.screen }) + '\n');
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  };
  client = new Client({ name: 'playwright-165-test', version: '1' });
  await client.connect(await wrapInProcess(new BrowserServerBackend(config, factory)));
  return config;
}

async function call(name: string, args = {}) {
  const result = await client!.callTool({ name, arguments: args });
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  return { ...result, text };
}

async function ok(name: string, args = {}) {
  const result = await call(name, args);
  expect(result.isError, result.text).not.toBe(true);
  return result;
}

function ref(snapshot: string, role: string, name: string) {
  const line = snapshot.split('\n').find(line => line.includes(`${role} "${name}" [ref=`));
  const value = line?.match(/\[ref=([^\]]+)\]/)?.[1];
  expect(value, snapshot).toBeDefined();
  return value!;
}

it.skipIf(!canRun)(`preserves named roles and audits distilled names without hiding unnamed controls (${browser}, #325)`, async () => {
  await setup();
  const snapshot = (await ok('browser_navigate', { url: origin })).text;
  for (const [role, name] of [
    ['navigation', 'Primary'], ['dialog', 'Preferences'], ['table', 'Roster'],
    ['columnheader', 'Member'], ['columnheader', 'Access'],
  ])
    ref(snapshot, role, name);

  const audit = await ok('audit_screen_reader', { checkReadingOrder: false, reportFile: 'names.json' });
  expect(audit.structuredContent).toMatchObject({
    summary: {
      elementsUnresolved: 0, elementsWithoutMeasuredName: 0, totalFindings: 1,
      countByCheck: { 'missing-accessible-name': 1 },
    },
    findings: [expect.objectContaining({ check: 'missing-accessible-name', role: 'button', name: null })],
  });
  const report = JSON.parse(await fs.readFile(path.join(directory!, 'names.json'), 'utf8'));
  expect(report.findings).toEqual([
    expect.objectContaining({ check: 'missing-accessible-name', role: 'button', name: null }),
  ]);
  expect(report.elements).toMatchObject({ unresolved: 0, unmeasuredNames: 0, truncated: false });
});

it.skipIf(!canRun)(`explains inert click failure without firing the handler and keeps ordinary clicks working (${browser}, #325)`, async () => {
  await setup();
  const snapshot = (await ok('browser_navigate', { url: `${origin}/controls` })).text;
  const target = ref(snapshot, 'button', 'Target action');
  const control = ref(snapshot, 'button', 'Control action');
  await ok('browser_evaluate', { function: `() => { document.getElementById('target-container').inert = true; }` });
  const click = await call('browser_click', { element: 'Target action', ref: target });
  expect(click.isError, click.text).toBe(true);
  expect(click.text).toContain('element is inert');
  expect(click.text).toMatch(/Timeout 1000ms exceeded/);
  const unchanged = (await ok('browser_snapshot')).text;
  expect(unchanged).toContain('Target activations: 0');
  expect(unchanged).toContain('Control activations: 0');
  const clicked = (await ok('browser_click', { element: 'Control action', ref: control })).text;
  expect(clicked).toContain('Target activations: 0');
  expect(clicked).toContain('Control activations: 1');
});

it.skipIf(!canRun)(`preserves the iPhone 15 screen descriptor through CLI configuration (${browser}, #325)`, async () => {
  const config = await setup('iPhone 15');
  expect(config.browser.contextOptions).toMatchObject({
    screen: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true,
  });
  await ok('browser_navigate', { url: origin });
  const result = await ok('browser_evaluate', {
    function: '() => ({ width: window.screen.width, height: window.screen.height, dpr: window.devicePixelRatio })',
  });
  expect(result.text).toMatch(/"width": 393/);
  expect(result.text).toMatch(/"height": 852/);
  expect(result.text).toMatch(/"dpr": 3/);
});
