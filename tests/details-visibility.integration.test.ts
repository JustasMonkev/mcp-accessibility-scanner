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

const requestedBrowser = process.env.MCP_TEST_BROWSER;
const browser = requestedBrowser || 'chromium';
// An unrecognized --browser value silently falls back to Chrome.
if (!['chromium', 'firefox', 'webkit'].includes(browser))
  throw new Error(`MCP_TEST_BROWSER must be chromium, firefox or webkit; got ${JSON.stringify(browser)}`);
// The default run skips without the bundled Chromium, like the other
// real-browser tests; an explicitly requested engine must not skip silently.
const canRun = !!requestedBrowser || existsSync(chromium.executablePath());
const require = createRequire(import.meta.url);
const versions = { playwright: require('playwright/package.json').version, playwrightCore: require('playwright-core/package.json').version };
// Playwright 1.63.0's injected WebKit visibility fallback checks only the
// nearest details/summary, so an open details nested in a closed one exposes
// its contents (microsoft/playwright#42951, #246). Only this exact pin may
// verify that known defect; any other version must hide the nested contents.
const knownWebKitLeak = browser === 'webkit' && versions.playwright === '1.63.0' && versions.playwrightCore === '1.63.0';
const fixture = `<title>Nested details</title>
<details>
  <summary>Outer section</summary>
  <details open>
    <summary>Inner section</summary>
    <button>Hidden action</button>
  </details>
</details>`;
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(fixture);
});
let directory: string | undefined;
let client: Client | undefined;
let origin: string;

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP fixture server');
  origin = `http://127.0.0.1:${address.port}`;
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

afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

async function call(name: string, args = {}) {
  const result = await client!.callTool({ name, arguments: args });
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  return { text, isError: result.isError === true };
}

async function ok(name: string, args = {}) {
  const result = await call(name, args);
  expect(result.isError, result.text).toBe(false);
  return result.text;
}

async function expectDiscoverable(snapshot: string) {
  expect(snapshot).toContain('Inner section');
  expect(snapshot).toMatch(/button "Hidden action" \[ref=/);
  expect(await ok('browser_find', { text: 'Hidden action' })).toMatch(/button "Hidden action" \[ref=/);
  expect(await ok('browser_verify_element_visible', { role: 'button', accessibleName: 'Hidden action' })).toContain('Done');
  expect(await ok('browser_verify_text_visible', { text: 'Hidden action' })).toContain('Done');
}

const title = knownWebKitLeak
  ? 'reproduces the known WebKit leak of an open details nested in a closed details'
  : 'hides an open details nested in a closed details from snapshots, find and verify';

it.skipIf(!canRun)(`${title} (${browser}) #246`, async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-details-visibility-'));
  const config = await resolveCLIConfig({ browser, caps: ['verify'], headless: true, isolated: true, outputDir: directory });
  client = new Client({ name: 'details-visibility-test', version: '1' });
  await client.connect(await wrapInProcess(new BrowserServerBackend(config, contextFactory(config))));

  const closed = await ok('browser_navigate', { url: `${origin}/` });
  const outerRef = closed.match(/"Outer section" \[ref=([^\]]+)\]/)?.[1];
  expect(outerRef, closed).toBeDefined();

  if (knownWebKitLeak) {
    await expectDiscoverable(closed);
    process.stdout.write('known-webkit-nested-details-leak\n');
  } else {
    expect(closed).not.toContain('Inner section');
    expect(closed).not.toContain('Hidden action');
    expect(await ok('browser_find', { text: 'Hidden action' })).toContain('No matches found for "Hidden action".');
    const verify = await call('browser_verify_element_visible', { role: 'button', accessibleName: 'Hidden action' });
    expect(verify.isError, verify.text).toBe(true);
    expect(verify.text).toContain('Element with role "button" and accessible name "Hidden action" not found');
    const verifyText = await call('browser_verify_text_visible', { text: 'Hidden action' });
    expect(verifyText.isError, verifyText.text).toBe(true);
    expect(verifyText.text).toContain('Text not found');
  }

  const opened = await ok('browser_click', { element: 'Outer section', ref: outerRef });
  expect(opened).toContain('Outer section');
  await expectDiscoverable(opened);
});
