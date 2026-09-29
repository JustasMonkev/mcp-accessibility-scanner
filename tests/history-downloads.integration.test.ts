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
const enableBFCache = process.env.MCP_TEST_ENABLE_BFCACHE === '1';
const require = createRequire(import.meta.url);
const versions = { playwright: require('playwright/package.json').version, playwrightCore: require('playwright-core/package.json').version };
// Exact native crash controls captured in CI runs 35692199642 and 36224901523
// and on local macOS. New versions must prove saved bytes; they do not inherit
// an assumed browser limitation.
const observedNativeCrashes = new Set([
  'darwin/chromium/153.0.8010.12',
  'linux/chromium/153.0.8010.12',
  'win32/chromium/153.0.8010.12',
  'win32/chrome/153.0.8010.53',
  'win32/chrome/154.0.8037.58',
  'win32/chrome/154.0.8037.93',
  'win32/msedge/153.0.4234.48',
  'win32/msedge/154.0.4258.37',
]);
const restoreProbe = '<script>addEventListener("pageshow", e => document.body.dataset.restored = String(e.persisted))</script>';
const downloadBytes = Buffer.from('Local download: verified after profile reuse.\n');
// Distinct bytes per launch prove that each saved file came from its own download.
const idleDownloads = [
  { name: 'first.txt', bytes: Buffer.from('Idle release download 1: saved before the browser is released.\n') },
  { name: 'second.txt', bytes: Buffer.from('Idle release download 2: saved after the profile is relaunched.\n') },
];
// Served in two parts so a test decides when the download may complete.
const slowDownloadBytes = Buffer.from(`Slow download: ${'x'.repeat(4096)}\n`);
const slowDownloadFirstPart = 1024;
let slowDownload: { response: http.ServerResponse, finish: () => void } | undefined;
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
  const idleDownload = /^\/idle-download-(\d)$/.exec(request.url || '');
  if (idleDownload && idleDownloads[Number(idleDownload[1])]) {
    const { name, bytes } = idleDownloads[Number(idleDownload[1])];
    response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': `attachment; filename="${name}"` });
    response.end(bytes);
    return;
  }
  if (request.url === '/slow-download') {
    // The advertised length exceeds what is sent until finish() runs, so the
    // browser holds a started but incomplete download.
    response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="slow.txt"', 'content-length': slowDownloadBytes.length });
    response.write(slowDownloadBytes.subarray(0, slowDownloadFirstPart));
    const held = { response, finish: () => response.end(slowDownloadBytes.subarray(slowDownloadFirstPart)) };
    slowDownload = held;
    response.on('close', () => {
      if (slowDownload === held)
        slowDownload = undefined;
    });
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  const pages: Record<string, string> = {
    '/a': '<title>Page A</title><input aria-label="Saved note"><a href="/b">Open B</a><iframe title="Child" src="/frame"></iframe>' + restoreProbe,
    '/plain': '<title>Plain A</title><input aria-label="Saved note"><a href="/b">Open B</a>' + restoreProbe,
    '/frame': '<a href="/b" target="_top">Frame open B</a>',
    '/b': '<title>Page B</title><h1>Page B</h1><a href="#plain">Plain ref control</a>',
    '/downloads': '<title>Download fixture</title><a href="/download">Download file</a>',
    '/idle-downloads': '<title>Idle download fixture</title><a href="/idle-download-0">Download first</a> <a href="/idle-download-1">Download second</a>',
    '/slow-downloads': '<title>Slow download fixture</title><a href="/slow-download">Download slow file</a>',
  };
  response.end(pages[request.url || ''] || '<title>Fixture</title>');
});

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP fixture server');
  origin = `http://127.0.0.1:${address.port}`;
  process.stdout.write(JSON.stringify({ platform: process.platform, channel, enableBFCache, node: process.version,
    ...versions }) + '\n');
});

beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-history-downloads-')); });

afterEach(async () => {
  // A held response would otherwise keep its connection (and afterAll) open.
  slowDownload?.response.destroy();
  slowDownload = undefined;
  const closedClients = await Promise.allSettled(clients.splice(0).map(async client => {
    try {
      await client.callTool({ name: 'browser_close', arguments: {} });
    } finally {
      await client.close();
    }
  }));
  const closedBrowsers = await Promise.allSettled(browsers.splice(0).map(browser => browser.close()));
  const closedContexts = await Promise.allSettled(contexts.splice(0).map(context => context.close()));
  // Windows can retain profile handles briefly after a native browser crash.
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  const errors = [...closedClients, ...closedBrowsers, ...closedContexts].filter(result => result.status === 'rejected');
  if (errors.length)
    throw new AggregateError(errors.map(result => result.reason), 'Browser fixture cleanup failed');
});

afterAll(async () => {
  // Browsers can leave keep-alive or held connections behind; close() alone waits for them.
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function isObservedNativeCrashTuple(browser: Browser) {
  return versions.playwright === '1.63.0' && versions.playwrightCore === '1.63.0'
    && observedNativeCrashes.has(`${process.platform}/${channel}/${browser.version()}`);
}

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

// On Windows the browser can still hold DevToolsActivePort open while writing it
// (EBUSY), or not have written the port yet, so read until a port is there.
async function readDevToolsPort(profile: string) {
  let port = '';
  await expect.poll(async () => {
    port = await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')
        .then(text => text.split('\n')[0].trim(), () => '');
    return /^\d+$/.test(port);
  }, { timeout: 10_000 }).toBe(true);
  return port;
}

async function openHistoryBrowser(mode: 'cdp' | 'launched') {
  let context: BrowserContext;
  let factory: BrowserContextFactory;
  if (mode === 'cdp') {
    const profile = path.join(directory, 'profile');
    const external = await chromium.launchPersistentContext(profile, {
      channel, headless: true, args: ['--remote-debugging-port=0'],
      // Opt in only to reproduce Playwright's documented unsupported BFCache mode.
      ignoreDefaultArgs: enableBFCache ? ['--disable-back-forward-cache'] : [],
    });
    contexts.push(external);
    const port = await readDevToolsPort(profile);
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
  return { context, factory };
}

it.each([
  ['cdp', 'direct'], ['cdp', 'mcp'], ['launched', 'direct'], ['launched', 'mcp'],
] as const)('keeps returned main/frame refs usable after repeated back navigation (%s, %s) #231', async (mode, api) => {
  const { context, factory } = await openHistoryBrowser(mode);
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
    const restored = await page.locator('body').getAttribute('data-restored') === 'true';
    if (restored)
      bfcacheRestores++;
    if (enableBFCache && mode === 'cdp')
      process.stdout.write(JSON.stringify({ case: 'bfcache-probe', api, restored, frames: page.frames().map(frame => frame.url()) }) + '\n');
  }
  process.stdout.write(JSON.stringify({ case: 'history', mode, api, bfcacheRestores }) + '\n');
}, 60_000);

// The case above snapshots afresh after every back step. An agent instead
// clicks the refs the back step itself returned (the `browser_navigate_back`
// response snapshot; for the direct API, `page.ariaSnapshot()` taken right after
// `goBack`) or a repeated snapshot of the same restored page. Nothing here
// navigates afresh, reloads or otherwise recovers: history length and form state
// must show the page really came back from history. Playwright frame-qualifies
// refs as `f<seq>e<n>` after the first cross-document navigation and advances
// `<seq>` on every traversal, so the plain page exercises main-frame refs alone.
it.each(
    (['cdp', 'launched'] as const).flatMap(mode => (['direct', 'mcp'] as const).flatMap(api =>
      (['plain', 'iframe'] as const).map(variant => [mode, api, variant] as const))),
)('clicks refs from back responses and repeated snapshots of the restored page (%s, %s, %s page) #231', async (mode, api, variant) => {
  const { context, factory } = await openHistoryBrowser(mode);
  process.stdout.write(JSON.stringify({ case: 'history-response-refs', mode, api, variant, browser: context.browser()!.version() }) + '\n');
  const page = context.pages()[0];
  const client = api === 'mcp' ? await connect(await resolveConfig({ outputDir: directory, timeouts: { settle: 0 } }), factory) : undefined;
  const pathname = variant === 'plain' ? '/plain' : '/a';
  const bfcacheOptIn = enableBFCache && mode === 'cdp';
  const note = page.getByRole('textbox', { name: 'Saved note' });
  const snapshot = async () => client ? await call(client, 'browser_snapshot') : await page.ariaSnapshot({ mode: 'ai' });
  // The iframe of a restored document can attach after the back step returns,
  // so a repeated snapshot waits for the link it is going to click.
  const repeatedSnapshot = async (name: string) => {
    let text = '';
    await expect.poll(async () => {
      text = await snapshot();
      return text.includes(`link "${name}"`);
    }).toBe(true);
    return text;
  };
  const historyLength = () => page.evaluate(() => history.length);
  const restored = () => page.locator('body').getAttribute('data-restored');

  for (const target of ['/b', pathname]) {
    if (client)
      await call(client, 'browser_navigate', { url: origin + target });
    else
      await page.goto(origin + target);
  }
  await note.fill('Keep this form state');
  const initialHistory = await historyLength();
  // `initial` is a snapshot of the page before the first back step, `back` the
  // snapshot that the previous back step returned, `repeat` another snapshot of
  // the restored page taken after it. The frame link can miss the back snapshot
  // when the iframe attaches late; it then falls back to `repeat`.
  const cycles = variant === 'plain'
    ? [['Open B', 'initial'], ['Open B', 'back'], ['Open B', 'repeat'], ['Open B', 'back'], ['Open B', 'repeat']] as const
    : [['Open B', 'initial'], ['Frame open B', 'back'], ['Open B', 'back'], ['Frame open B', 'repeat'], ['Open B', 'repeat']] as const;
  let backSnapshot = '';
  let bfcacheRestores = 0;
  const used: { name: string, source: string, ref: string }[] = [];
  for (const [name, wanted] of cycles) {
    const backHasLink = backSnapshot.includes(`link "${name}"`);
    const source = wanted === 'back' && name === 'Frame open B' && !backHasLink ? 'repeat' : wanted;
    const text = source === 'back' ? backSnapshot : await repeatedSnapshot(name);
    const ref = linkRef(text, name);
    expect(ref).toMatch(/^f\d+e\d+$/);
    if (source === 'repeat' && backHasLink)
      expect(ref, 'a repeated snapshot of the restored page must keep its refs').toBe(linkRef(backSnapshot, name));
    used.push({ name, source, ref });
    if (client)
      await call(client, 'browser_click', { element: name, ref });
    else
      await page.locator(`aria-ref=${ref}`).click();
    await expect.poll(() => page.url()).toBe(`${origin}/b`);
    // A back step taken while B is still loading can be dropped by the browser;
    // browser_click already waits for this, a direct click does not.
    await page.waitForLoadState();
    if (client) {
      backSnapshot = await call(client, 'browser_navigate_back');
    } else {
      await page.goBack({ waitUntil: 'commit' });
      backSnapshot = await page.ariaSnapshot({ mode: 'ai' });
    }
    if (client)
      expect(backSnapshot).toContain(`Page URL: ${origin}${pathname}`);
    await expect.poll(() => page.url()).toBe(origin + pathname);
    await expect.poll(() => note.inputValue()).toBe('Keep this form state');
    expect(await historyLength(), 'going back must traverse history, not add a navigation').toBe(initialHistory + 1);
    if (bfcacheOptIn) {
      if (await restored() === 'true')
        bfcacheRestores++;
    } else {
      // Playwright's launch flags disable BFCache, so `true` here would mean a
      // cached document came back and the case no longer describes what it claims.
      await expect.poll(restored).toBe('false');
    }
    if (variant === 'iframe' && !bfcacheOptIn)
      await expect.poll(() => page.frames().map(frame => new URL(frame.url()).pathname)).toEqual(['/a', '/frame']);
  }
  process.stdout.write(JSON.stringify({ case: 'history-response-refs', mode, api, variant, cycles: used, bfcacheRestores }) + '\n');
}, 60_000);

it.each([false, true])('saves bytes or reports a known native relaunch crash without losing MCP (isolated: %s) #230', async isolated => {
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
    const browser = context!.browser()!;
    const knownNativeCrash = !isolated && launch === 1 && isObservedNativeCrashTuple(browser);
    process.stdout.write(JSON.stringify({ case: 'download', isolated, launch, browser: browser.version() }) + '\n');
    expect(await page.evaluate(() => localStorage.getItem('previousLaunch'))).toBe(!isolated && launch ? 'saved' : null);
    await page.evaluate(() => localStorage.setItem('previousLaunch', 'saved'));
    const downloadEvents: { name: string, failure?: string | null, path?: string | null }[] = [];
    const downloadRequests: { event: string, status?: number, error?: string }[] = [];
    page.on('request', request => {
      if (request.url() === `${origin}/download`)
        downloadRequests.push({ event: 'request' });
    });
    page.on('response', response => {
      if (response.url() === `${origin}/download`)
        downloadRequests.push({ event: 'response', status: response.status() });
    });
    page.on('requestfailed', request => {
      if (request.url() === `${origin}/download`)
        downloadRequests.push({ event: 'requestfailed', error: request.failure()?.errorText });
    });
    page.on('download', download => {
      const event: typeof downloadEvents[number] = { name: download.suggestedFilename() };
      downloadEvents.push(event);
      void download.failure().then(failure => { event.failure = failure; }, error => { event.failure = String(error); });
      void download.path().then(downloadPath => { event.path = downloadPath; }, error => { event.path = String(error); });
    });
    const snapshot = await call(client, 'browser_snapshot');
    const clicked = await client.callTool({ name: 'browser_click', arguments: { element: 'Download file', ref: linkRef(snapshot, 'Download file') } });
    const clickResult = clicked.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    let savedContents: string[] = [];
    const downloadDeadline = Date.now() + 10_000;
    try {
      await expect.poll(async () => {
        const files = await fs.readdir(outputDir);
        savedContents = await Promise.all(files.filter(file => file.endsWith('.txt')).map(file => fs.readFile(path.join(outputDir, file), 'utf8')));
        return savedContents.length === 1 && savedContents[0] === downloadBytes.toString()
          || knownNativeCrash && page.isClosed() && !browser.isConnected() && downloadEvents.some(event => event.failure !== undefined);
      }, { timeout: 10_000 }).toBe(true);
      if (!savedContents.length) {
        expect(knownNativeCrash).toBe(true);
        expect(page.isClosed()).toBe(true);
        expect(browser.isConnected()).toBe(false);
        expect(downloadEvents).toEqual([expect.objectContaining({ name: 'fixture.txt', failure: 'Target page, context or browser has been closed' })]);
        expect(downloadRequests).toContainEqual({ event: 'response', status: 200 });
        expect(await fs.readdir(outputDir)).toEqual([]);
        // A crash can arrive after the click returns. The next tool must
        // retain its named download error even with no current tab left.
        let failure = clicked;
        let failureText = clickResult;
        // Native failure can precede the server's outputFile()/saveAs failure
        // handler. Use the remaining download budget to observe its response.
        await expect.poll(async () => {
          if (!failureText.includes('Failed to save download "fixture.txt":')) {
            failure = await client.callTool({ name: 'browser_snapshot', arguments: {} });
            failureText = failure.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
          }
          return failureText.includes('Failed to save download "fixture.txt":');
        }, { timeout: Math.max(1, downloadDeadline - Date.now()) }).toBe(true);
        expect(failure.isError, failureText).toBe(true);
        expect(failureText).toContain('Failed to save download "fixture.txt":');
        expect(failureText).toContain('Target page, context or browser has been closed');
        expect(failureText).not.toContain('Downloading file fixture.txt');
        expect(failureText).not.toContain('Downloaded file fixture.txt');
        await client.ping();
        process.stdout.write(JSON.stringify({ case: 'known-native-crash-reported', platform: process.platform, channel,
          browser: browser.version(), ...versions, isolated, launch, downloadEvents, browserConnected: false,
          savedFiles: [], mcpAlive: true }) + '\n');
      } else {
        expect(savedContents).toEqual([downloadBytes.toString()]);
        expect(clicked.isError, clickResult).not.toBe(true);
        // Read raw: after the known crash the snapshot itself can be an error result.
        const afterSaveResult = await client.callTool({ name: 'browser_snapshot', arguments: {} });
        const afterSave = textOf(afterSaveResult);
        if (knownNativeCrash && !browser.isConnected()) {
          // The observed native crash can also land just after the save finished:
          // the exact bytes are on disk and MCP must still answer.
          await client.ping();
          process.stdout.write(JSON.stringify({ case: 'known-native-crash-after-save', platform: process.platform, channel,
            browser: browser.version(), ...versions, isolated, launch }) + '\n');
        } else {
          expect(afterSaveResult.isError, afterSave).not.toBe(true);
          expect(page.isClosed()).toBe(false);
          expect(browser.isConnected()).toBe(true);
          expect(afterSave).toContain('Download fixture');
          await client.ping();
        }
      }
    } catch (error) {
      process.stdout.write(JSON.stringify({ case: 'download-failure', isolated, launch, downloadEvents, downloadRequests,
        pageClosed: page.isClosed(), browserConnected: context!.browser()!.isConnected(),
        pages: context!.pages().map(candidate => candidate.url()), outputFiles: await fs.readdir(outputDir), clickResult }) + '\n');
      throw error;
    }
    await call(client, 'browser_close');
    await client.close();
    clients.splice(clients.indexOf(client), 1);
  }
}, 60_000);

function persistentConfig(profile: string, outputDir: string, idle?: number) {
  return resolveConfig({
    browser: { userDataDir: profile, launchOptions: {
      channel, headless: true,
      chromiumSandbox: channel === 'chromium-headless-shell' && process.platform === 'linux' ? false : undefined,
    } },
    outputDir, timeouts: { settle: 0, idle },
  });
}

// Records every browser context the MCP layer launches, so a test can tell a
// relaunch from a survivor of the previous browser.
function trackedFactory(config: FullConfig) {
  const factory = contextFactory(config);
  const launched: BrowserContext[] = [];
  return {
    launched,
    factory: {
      createContext: async (...args: Parameters<BrowserContextFactory['createContext']>) => {
        const result = await factory.createContext(...args);
        launched.push(result.browserContext);
        return result;
      },
    } satisfies BrowserContextFactory,
  };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>) {
  return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}

async function savedFiles(outputDir: string) {
  const files = (await fs.readdir(outputDir)).filter(file => file.endsWith('.txt')).sort();
  return Promise.all(files.map(async file => ({ file, bytes: await fs.readFile(path.join(outputDir, file)) })));
}

// The save rejection can trail the disconnect, so keep asking until a response
// carries the named failure. Bounded by the poll timeout, never by a hung call.
async function nextDownloadFailure(client: Client, filename: string, timeout = 10_000) {
  let result: Awaited<ReturnType<Client['callTool']>> | undefined;
  let text = '';
  await expect.poll(async () => {
    result = await client.callTool({ name: 'browser_snapshot', arguments: {} });
    text = textOf(result);
    return text.includes(`Failed to save download "${filename}":`);
  }, { timeout }).toBe(true);
  return { result: result!, text };
}

function watchUnhandledRejections() {
  const reasons: unknown[] = [];
  const listener = (reason: unknown) => reasons.push(reason);
  process.on('unhandledRejection', listener);
  return async () => {
    // Node reports an unhandled rejection after the microtask queue drains.
    await new Promise(resolve => setTimeout(resolve, 100));
    process.off('unhandledRejection', listener);
    return reasons;
  };
}

async function startSlowDownload(client: Client) {
  await call(client, 'browser_navigate', { url: `${origin}/slow-downloads` });
  const snapshot = await call(client, 'browser_snapshot');
  await call(client, 'browser_click', { element: 'Download slow file', ref: linkRef(snapshot, 'Download slow file') });
  await expect.poll(() => slowDownload !== undefined, { timeout: 10_000 }).toBe(true);
  // The click can return before the download event reaches the tab.
  await expect.poll(async () => (await call(client, 'browser_snapshot')).includes('Downloading file slow.txt'), { timeout: 10_000 }).toBe(true);
}

it.each(['context', 'browser'] as const)('reports a named error when the %s is closed while a download is mid-save #230', async closing => {
  const stopWatching = watchUnhandledRejections();
  const outputDir = path.join(directory, 'downloads');
  const config = await persistentConfig(path.join(directory, 'profile'), outputDir);
  const { factory, launched } = trackedFactory(config);
  const client = await connect(config, factory);
  await startSlowDownload(client);
  const first = launched[0];
  const browser = first.browser()!;
  process.stdout.write(JSON.stringify({ case: 'interrupted-download', closing, browser: browser.version() }) + '\n');
  // Started but incomplete: nothing may be claimed or written yet.
  expect(await fs.readdir(outputDir)).toEqual([]);
  if (closing === 'context')
    await first.close();
  else
    await browser.close();
  expect(browser.isConnected()).toBe(false);

  const { result, text } = await nextDownloadFailure(client, 'slow.txt');
  expect(result.isError, text).toBe(true);
  // Chromium reports the interrupted save as "canceled"; other builds name the closed target.
  expect(text).toMatch(/Failed to save download "slow\.txt": .*(cancel|closed)/i);
  expect(text).not.toContain('Downloaded file slow.txt');
  expect(await fs.readdir(outputDir)).toEqual([]);
  // Reported once: the failure is consumed, not repeated on every later response.
  expect(textOf(await client.callTool({ name: 'browser_snapshot', arguments: {} }))).not.toContain('Failed to save download');
  await client.ping();
  // A relaunch of the reused profile can hit the observed native crash; only
  // other tuples are required to prove the server recovers with a new browser.
  if (!isObservedNativeCrashTuple(browser)) {
    await call(client, 'browser_navigate', { url: `${origin}/slow-downloads` });
    expect(launched.length).toBeGreaterThan(1);
    expect(launched.at(-1)).not.toBe(first);
    expect(launched.at(-1)!.browser()!.isConnected()).toBe(true);
    expect(await call(client, 'browser_snapshot')).toContain('Slow download fixture');
  }
  await client.ping();
  expect(await stopWatching()).toEqual([]);
}, 60_000);

it('relaunches the same persistent profile after the idle release and saves exact bytes both times #230', async () => {
  const stopWatching = watchUnhandledRejections();
  const profile = path.join(directory, 'profile');
  const outputDir = path.join(directory, 'downloads');
  const config = await persistentConfig(profile, outputDir, 1000);
  const { factory, launched } = trackedFactory(config);
  const client = await connect(config, factory);

  await call(client, 'browser_navigate', { url: `${origin}/idle-downloads` });
  const first = launched[0];
  await first.pages()[0].evaluate(() => localStorage.setItem('previousLaunch', 'saved'));
  let released = false;
  first.once('close', () => { released = true; });
  const snapshot = await call(client, 'browser_snapshot');
  await call(client, 'browser_click', { element: 'Download first', ref: linkRef(snapshot, 'Download first') });
  await expect.poll(() => savedFiles(outputDir), { timeout: 10_000 }).toEqual([{ file: expect.stringMatching(/^first-.*\.txt$/), bytes: idleDownloads[0].bytes }]);
  await expect.poll(async () => (await call(client, 'browser_snapshot')).includes('Downloaded file first.txt'), { timeout: 10_000 }).toBe(true);

  // No tool runs and no save is pending: only the idle timer can release the
  // browser, and the client stays connected throughout.
  expect(released).toBe(false);
  await expect.poll(() => released, { timeout: 15_000 }).toBe(true);
  expect(first.browser()!.isConnected()).toBe(false);
  expect(launched).toHaveLength(1);

  const resumed = await call(client, 'browser_navigate', { url: `${origin}/idle-downloads` });
  expect(resumed).toContain('released after inactivity');
  // A new browser, not the released one, on the same profile.
  expect(launched).toHaveLength(2);
  const second = launched[1];
  expect(second).not.toBe(first);
  expect(second.browser()).not.toBe(first.browser());
  expect(second.browser()!.isConnected()).toBe(true);
  expect(await fs.readdir(profile)).toContain('Default');
  expect(await second.pages()[0].evaluate(() => localStorage.getItem('previousLaunch'))).toBe('saved');

  const secondBrowser = second.browser()!;
  // Taken before the click: the known native crash closes the context's pages,
  // after which pages() is empty.
  const page = second.pages()[0];
  const knownNativeCrash = isObservedNativeCrashTuple(secondBrowser);
  process.stdout.write(JSON.stringify({ case: 'idle-relaunch', browser: secondBrowser.version(), knownNativeCrash }) + '\n');
  const relaunchedSnapshot = await call(client, 'browser_snapshot');
  const clicked = await client.callTool({ name: 'browser_click', arguments: { element: 'Download second', ref: linkRef(relaunchedSnapshot, 'Download second') } });
  const bothSaved = [
    { file: expect.stringMatching(/^first-.*\.txt$/), bytes: idleDownloads[0].bytes },
    { file: expect.stringMatching(/^second-.*\.txt$/), bytes: idleDownloads[1].bytes },
  ];
  await expect.poll(async () => {
    const files = await savedFiles(outputDir);
    return files.length === 2 && files[1].bytes.equals(idleDownloads[1].bytes)
      || knownNativeCrash && page.isClosed() && !secondBrowser.isConnected();
  }, { timeout: 10_000 }).toBe(true);
  if (page.isClosed() && !secondBrowser.isConnected()) {
    // Only the observed native relaunch crash may end here; it must still be
    // reported by name, with no second artifact and a live MCP connection.
    expect(knownNativeCrash).toBe(true);
    const { result, text } = clicked.isError && textOf(clicked).includes('Failed to save download "second.txt":')
      ? { result: clicked, text: textOf(clicked) }
      : await nextDownloadFailure(client, 'second.txt');
    expect(result.isError, text).toBe(true);
    expect(text).not.toContain('Downloaded file second.txt');
    expect(await savedFiles(outputDir)).toEqual(bothSaved.slice(0, 1));
    process.stdout.write(JSON.stringify({ case: 'known-native-crash-reported', platform: process.platform, channel,
      browser: secondBrowser.version(), ...versions, idleRelaunch: true }) + '\n');
  } else {
    expect(clicked.isError, textOf(clicked)).not.toBe(true);
    expect(await savedFiles(outputDir)).toEqual(bothSaved);
    const afterSaveResult = await client.callTool({ name: 'browser_snapshot', arguments: {} });
    const afterSave = textOf(afterSaveResult);
    // As in the case above, the observed crash may land just after the save.
    if (!knownNativeCrash || secondBrowser.isConnected()) {
      expect(afterSaveResult.isError, afterSave).not.toBe(true);
      expect(secondBrowser.isConnected()).toBe(true);
      expect(afterSave).toContain('Downloaded file second.txt');
    }
  }
  await client.ping();
  expect(await stopWatching()).toEqual([]);
}, 90_000);

it('holds the idle release while a download is still streaming, then releases and relaunches #230', async () => {
  const stopWatching = watchUnhandledRejections();
  const profile = path.join(directory, 'profile');
  const outputDir = path.join(directory, 'downloads');
  const config = await persistentConfig(profile, outputDir, 500);
  const { factory, launched } = trackedFactory(config);
  const client = await connect(config, factory);
  await startSlowDownload(client);
  const first = launched[0];
  await first.pages()[0].evaluate(() => localStorage.setItem('previousLaunch', 'saved'));
  let released = false;
  first.once('close', () => { released = true; });
  // Several idle windows pass with the save incomplete: the browser must not be
  // released underneath it, and must stay usable.
  await new Promise(resolve => setTimeout(resolve, 2000));
  expect(released).toBe(false);
  expect(first.browser()!.isConnected()).toBe(true);
  expect(await call(client, 'browser_snapshot')).toContain('Slow download fixture');
  slowDownload!.finish();
  await expect.poll(() => savedFiles(outputDir), { timeout: 10_000 }).toEqual([{ file: expect.stringMatching(/^slow-.*\.txt$/), bytes: slowDownloadBytes }]);
  // Only once the save settled does the idle release proceed.
  await expect.poll(() => released, { timeout: 15_000 }).toBe(true);
  const resumed = await call(client, 'browser_navigate', { url: `${origin}/slow-downloads` });
  expect(resumed).toContain('released after inactivity');
  expect(launched).toHaveLength(2);
  expect(launched[1]).not.toBe(first);
  expect(await launched[1].pages()[0].evaluate(() => localStorage.getItem('previousLaunch'))).toBe('saved');
  expect(await call(client, 'browser_snapshot')).toContain('Slow download fixture');
  await client.ping();
  expect(await stopWatching()).toEqual([]);
}, 90_000);
