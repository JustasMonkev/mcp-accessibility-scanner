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
import { afterEach, expect, it } from 'vitest';
import * as playwright from 'playwright';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { resolveConfig } from '../src/config.js';

const browserName = process.env.MCP_TEST_BROWSER_NAME || 'chromium';
if (browserName !== 'chromium' && browserName !== 'firefox' && browserName !== 'webkit')
  throw new Error(`Unsupported MCP_TEST_BROWSER_NAME: ${browserName}`);
const browserType = playwright[browserName];
const channel = process.env.MCP_TEST_BROWSER_CHANNEL;
if (channel && browserName !== 'chromium')
  throw new Error('MCP_TEST_BROWSER_CHANNEL requires chromium');
const require = createRequire(import.meta.url);
const versions = {
  playwright: require('playwright/package.json').version,
  playwrightCore: require('playwright-core/package.json').version,
};
// Only the measured paired pin may retain these upstream deviations. An upgrade
// must pass the intended behavior instead of inheriting a known failure.
const pinned = versions.playwright === '1.63.0' && versions.playwrightCore === '1.63.0';
const mac14WebKit = browserName === 'webkit' && process.platform === 'darwin' && os.release().startsWith('23.');
const knownPageSetupFailure = pinned && mac14WebKit;
let browser: playwright.Browser | undefined;
let backend: BrowserServerBackend | undefined;
let directory: string | undefined;

afterEach(async () => {
  try {
    backend?.serverClosed();
    await browser?.close();
  } finally {
    if (directory)
      await fs.rm(directory, { recursive: true, force: true });
    browser = backend = directory = undefined;
  }
});

async function setup() {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-upgrade-controls-'));
  browser = await browserType.launch({ channel });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  backend = new BrowserServerBackend(await resolveConfig({
    outputDir: directory, timeouts: { navigationTimeout: 3000, defaultTimeout: 3000, settle: 50 },
  }), { createContext: async () => ({ browserContext: context, close: () => context.close() }) });
  await backend.initialize({ notifyToolListChanged: async () => {} }, { name: 'upgrade-controls', version: '1' });
  const snapshot = await backend.callTool('browser_snapshot', {});
  expect(snapshot.isError, JSON.stringify(snapshot.content)).not.toBe(true);
  process.stdout.write(JSON.stringify({ browserName, channel: channel || 'bundled', browserVersion: browser.version(), platform: process.platform, arch: process.arch, ...versions }) + '\n');
  return { page, backend };
}

async function fontMetrics(page: playwright.Page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'h1' });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    expect(fonts.length).toBeGreaterThan(0);
    return {
      fonts: fonts.map(font => font.postScriptName).sort(),
      heading: await page.locator('h1').boundingBox(),
      last: await page.locator('#last').boundingBox(),
    };
  } finally {
    await cdp.detach();
  }
}

it.skipIf(browserName !== 'chromium')('measures actual fonts and layout across MCP viewport/full-page screenshots (#42962)', async () => {
  const { page, backend } = await setup();
  const changed: string[] = [];
  for (const family of ['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy']) {
    const html = `<body style="margin:0;font:22px ${family}"><h1>Title</h1>${'<p>The quick brown fox</p>'.repeat(40)}<p id="last">last</p>`;
    await page.goto(`data:text/html,${encodeURIComponent(html)}`);
    const before = await fontMetrics(page);
    expect(before.last?.y).toBeGreaterThan(720);
    const viewport = await backend.callTool('browser_take_screenshot', {});
    expect(viewport.isError, JSON.stringify(viewport.content)).not.toBe(true);
    expect(await fontMetrics(page)).toEqual(before);
    const fullPage = await backend.callTool('browser_take_screenshot', { fullPage: true });
    expect(fullPage.isError, JSON.stringify(fullPage.content)).not.toBe(true);
    const after = await fontMetrics(page);
    if (JSON.stringify(after) !== JSON.stringify(before))
      changed.push(family);
    process.stdout.write(JSON.stringify({ family, before, after }) + '\n');
    await page.reload();
    expect(await fontMetrics(page)).toEqual(before);
  }
  const knownFontChanges: Record<string, string[]> = {
    'darwin/bundled': ['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy'],
    'darwin/chrome': ['monospace'],
    'linux/bundled': ['monospace'],
  };
  const knownChanges = pinned ? knownFontChanges[`${process.platform}/${channel || 'bundled'}`] ?? [] : [];
  expect(changed).toEqual(knownChanges);
});

it.skipIf(knownPageSetupFailure)('records Option-key text insertion and focused/unfocused nested frames (#42958)', async () => {
  const { page, backend } = await setup();
  await page.setContent(`<textarea aria-label="Keys"></textarea><output></output>
    <iframe srcdoc="<input aria-label='Child'><iframe srcdoc='<input aria-label=Nested>'></iframe>"></iframe>
    <script>
      const events = [];
      for (const type of ['keydown', 'keyup', 'input'])
        document.querySelector('textarea').addEventListener(type, event => {
          events.push({ type, key: event.key, altKey: event.altKey });
          document.querySelector('output').textContent = JSON.stringify(events);
        });
    </script>`);
  await page.locator('textarea').focus();
  const key = await backend.callTool('browser_press_key', { key: 'Alt+a' });
  expect(key.isError, JSON.stringify(key.content)).not.toBe(true);
  const events = JSON.parse(await page.locator('output').innerText());
  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'keydown', key: 'a', altKey: true }),
    expect.objectContaining({ type: 'keyup', key: 'a', altKey: true }),
  ]));
  const typed = await page.locator('textarea').inputValue();
  const child = page.frames().find(frame => frame.parentFrame() === page.mainFrame());
  expect(child).toBeDefined();
  const nested = child!.childFrames()[0];
  await nested.locator('input').waitFor();
  const focus = async () => Promise.all([page.mainFrame(), child!, nested].map(frame => frame.evaluate(() => document.hasFocus())));
  const topFocused = await focus();
  await child!.locator('input').focus();
  const childFocused = await focus();
  await nested.locator('input').focus();
  const nestedFocused = await focus();
  process.stdout.write(JSON.stringify({ typed, events, topFocused, childFocused, nestedFocused }) + '\n');
  const knownOptionInsertion = pinned && browserName === 'firefox' && process.platform === 'darwin';
  expect(typed).toBe(knownOptionInsertion ? 'a' : '');
  expect(events.some((event: { type: string }) => event.type === 'input')).toBe(knownOptionInsertion);
  expect(topFocused).toEqual([true, false, false]);
  expect(childFocused).toEqual([true, true, false]);
  expect(nestedFocused).toEqual([true, true, true]);
});

it.skipIf(knownPageSetupFailure)('delivers navigation errors, bounds stalled loads, and remains usable (#42957, #42964 controls)', async () => {
  const { page, backend } = await setup();
  const served = new Set<string>();
  const server = http.createServer((request, response) => {
    if (request.url === '/stall')
      return;
    response.writeHead(200, { 'content-type': 'text/html', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' });
    response.once('finish', () => served.add(request.url!));
    response.end('<h1>Navigation recovered</h1>');
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP server');
    const origin = `http://127.0.0.1:${address.port}`;
    await page.route(`${origin}/abort`, route => route.abort('aborted'));
    for (const route of ['/ok', '/abort', '/ok', '/stall', '/ok']) {
      const started = Date.now();
      const result = await backend.callTool('browser_navigate', { url: origin + route });
      const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      if (route === '/ok') {
        expect(result.isError, text).not.toBe(true);
        expect(await page.locator('h1').textContent()).toBe('Navigation recovered');
      } else {
        expect(result.isError, text).toBe(true);
        if (route === '/stall')
          expect(text).toContain('Timeout 3000ms exceeded');
        else
          expect(text).not.toContain('Timeout');
      }
      expect(Date.now() - started).toBeLessThan(15000);
      process.stdout.write(JSON.stringify({ route, elapsed: Date.now() - started, error: result.isError === true }) + '\n');
    }
    if (browserName === 'webkit') {
      const started = Date.now();
      let lostAborts = 0;
      let deliveredAborts = 0;
      for (let round = 0; round < 350; round++) {
        const fresh = await page.context().newPage();
        const target = `/ok?round=${round}`;
        try {
          try {
            await fresh.goto(origin + target, { waitUntil: 'domcontentloaded', timeout: 3000 });
          } catch (error) {
            // #42957's abort-before-request order was protocol-confirmed on
            // pinned Linux WebKit. Only its served-but-uncommitted signature
            // may time out; a containing fix must deliver cancellation promptly.
            const knownTimeout = pinned && process.platform === 'linux' && error instanceof playwright.errors.TimeoutError;
            const deliveredAbort = error instanceof Error && error.message.startsWith('page.goto: Load request cancelled');
            if (!knownTimeout && !deliveredAbort)
              throw error;
            expect(served.has(target)).toBe(true);
            expect(fresh.url()).toBe('about:blank');
            if (knownTimeout)
              lostAborts++;
            else
              deliveredAborts++;
            process.stdout.write(JSON.stringify({ round, navigation: knownTimeout ? 'known-lost-abort-timeout' : 'delivered-abort', error: String(error) }) + '\n');
            // Recovery is strict and uses the same affected page, not a new one.
            await fresh.goto(`${origin}/ok?recovery=${round}`, { waitUntil: 'domcontentloaded', timeout: 3000 });
          }
          expect(await fresh.locator('h1').textContent()).toBe('Navigation recovered');
        } finally {
          await fresh.close();
        }
      }
      process.stdout.write(JSON.stringify({ webkitFreshNavigations: 350, successfulFirstNavigations: 350 - lostAborts - deliveredAborts, lostAborts, deliveredAborts, elapsed: Date.now() - started }) + '\n');
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 180000);

it.skipIf(!mac14WebKit)('characterizes actual macOS 14 WebKit page setup (#42964)', async () => {
  browser = await browserType.launch();
  const context = await browser.newContext();
  const creating = context.newPage().then(page => ({ page }), (error: unknown) => ({ error }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // On r2251, the failed initialization can leave newPage pending until the
    // browser closes. Bound our own disposable browser, not the user's session.
    const first = await Promise.race([
      creating,
      new Promise<'stalled'>(resolve => { timer = setTimeout(() => resolve('stalled'), 5000); }),
    ]);
    if (first === 'stalled')
      await browser.close();
    const result = await creating;
    if (pinned) {
      if (!('error' in result) || !(result.error instanceof Error))
        throw new Error('Expected the pinned WebKit page-setup error');
      expect(result.error.message).toContain('Unknown setting: PushAPIEnabled');
      process.stdout.write(JSON.stringify({ mac14WebKit: 'known-PushAPIEnabled-setup-failure', stalled: first === 'stalled', error: result.error.message, ...versions }) + '\n');
    } else {
      expect(first).not.toBe('stalled');
      if (!('page' in result))
        throw result.error;
      await result.page.goto('data:text/html,<h1>WebKit page created</h1>');
      expect(await result.page.locator('h1').textContent()).toBe('WebKit page created');
    }
  } finally {
    clearTimeout(timer);
  }
}, 60000);
