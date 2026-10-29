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

import fs, { existsSync } from 'node:fs';
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

const browser = process.env.MCP_TEST_BROWSER_NAME || 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(browser))
  throw new Error(`Unsupported MCP_TEST_BROWSER_NAME: ${browser}`);
const canRun = !!process.env.MCP_TEST_BROWSER_NAME || existsSync(chromium.executablePath());
const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  response.writeHead(200, { 'content-type': 'text/html' });
  if (url.pathname === '/focus-identity') {
    response.end(`<button tabindex="0">Save</button><button tabindex="0">Save</button><button tabindex="0">Last</button>`);
    return;
  }
  if (url.pathname === '/shadow-focus') {
    response.end(`<div id="host" style="background:white"></div><button tabindex="0">Last</button><script>
      document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
        '<button tabindex="0">Save</button><button tabindex="0">Save</button>';
    </script>`);
    return;
  }
  if (url.pathname === '/shadow-obscuration') {
    const covered = url.searchParams.has('covered');
    response.end(`<style>body { margin: 0 } #target, #cover { position: absolute; left: 20px; top: 20px; width: 120px; height: 60px } #cover { background: black }</style>
      ${covered ? '<button id="target">Target</button><div id="cover"></div>' : '<div id="target" tabindex="0">Target</div>'}
      <script>
        document.getElementById('${covered ? 'cover' : 'target'}').attachShadow({ mode: 'open' }).innerHTML =
          '<div style="width:100%;height:100%;${covered ? '' : 'background:white'}"><div id="nested" style="width:100%;height:100%"></div></div>';
        document.querySelector('${covered ? '#cover' : '#target'}').shadowRoot.getElementById('nested')
          .attachShadow({ mode: 'open' }).innerHTML = '<span style="display:block;width:100%;height:100%;${covered ? '' : 'background:white'}"></span>';
      </script>`);
    return;
  }
  if (url.pathname === '/trapped-focus') {
    response.end(`<button id="trapped" tabindex="0">Before</button><button tabindex="0">Unreachable</button><script>
      const button = document.getElementById('trapped');
      button.focus();
      button.addEventListener('keydown', event => {
        if (event.key === 'Tab') {
          event.preventDefault();
          button.textContent = 'After';
        }
      });
    </script>`);
    return;
  }
  if (url.pathname === '/reverse-focus') {
    response.end(`<button tabindex="0">One</button><button id="start" tabindex="0">Two</button><button tabindex="0">Three</button>
      <script>document.getElementById('start').focus()</script>`);
    return;
  }
  if (url.pathname === '/labelledby') {
    response.end(`<span id="verb">Save</span><span id="noun">draft</span>
      <button id="labelled" aria-labelledby=" verb\tnoun missing ">Fallback text</button>`);
    return;
  }
  if (['/prior', '/target', '/forward'].includes(url.pathname)) {
    response.end(`<button id="${url.pathname.slice(1)}">Other document</button>`);
    return;
  }
  const kind = url.searchParams.get('kind');
  const href = kind === 'fragment' ? '#main' : '/target#main';
  const script = kind === 'replace' || kind === 'push' ? `<script>
    document.getElementById('skip').addEventListener('click', event => {
      event.preventDefault();
      history.${kind}State({}, '', '/rewritten?view=main#main');
      document.getElementById('main').focus();
    });
  </script>` : kind === 'location-replace' ? `<script>
    document.getElementById('skip').addEventListener('click', event => {
      event.preventDefault();
      location.replace('/target#main');
    });
  </script>` : kind === 'reload' ? `<script>
    document.getElementById('skip').addEventListener('click', event => {
      event.preventDefault();
      location.reload();
    });
  </script>` : '';
  response.end(`<a id="skip" tabindex="1" href="${href}">Skip to content</a>
    <main id="main" tabindex="2"><button id="audited-action" tabindex="3">Audited action</button></main>${script}`);
});
let origin: string;
let directory: string | undefined;
let client: Client | undefined;

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
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
    await client?.close();
    if (directory)
      await fs.promises.rm(directory, { recursive: true, force: true });
    client = undefined;
    directory = undefined;
  }
});

afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

async function ok(name: string, args = {}) {
  const result = await client!.callTool({ name, arguments: args });
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  expect(result.isError, text).not.toBe(true);
  return text;
}

it.skipIf(!canRun).each(['replace', 'push', 'fragment', 'document', 'reload', 'location-replace', 'document-forward'])(
  'continues auditing the original document after %s skip-link activation', async kind => {
    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'audit-keyboard-navigation-'));
    const config = await resolveCLIConfig({ browser, headless: true, isolated: true, outputDir: directory });
    client = new Client({ name: 'keyboard-navigation-test', version: '1' });
    await client.connect(await wrapInProcess(new BrowserServerBackend(config, contextFactory(config))));
    await ok('browser_navigate', { url: `${origin}/prior` });
    const startUrl = `${origin}/start?kind=${kind}`;
    await ok('browser_navigate', { url: startUrl });
    if (kind === 'document-forward') {
      await ok('browser_navigate', { url: `${origin}/forward` });
      await ok('browser_navigate_back');
    }
    await ok('browser_evaluate', { function: '() => sessionStorage.setItem("keyboard-history-length", String(history.length))' });
    await ok('audit_keyboard', {
      maxTabs: 2,
      activateSkipLink: true,
      checkFocusTrap: false,
      checkFocusVisibility: false,
      checkFocusJumps: false,
      checkTargetSize: false,
      checkFocusObscured: false,
      reportFile: 'keyboard.json',
    });
    const report = JSON.parse(await fs.promises.readFile(path.join(directory, 'keyboard.json'), 'utf8'));
    const replacedDocument = ['document', 'reload', 'location-replace', 'document-forward'].includes(kind);
    expect(report.skipLink.activation.navigationOccurred).toBe(replacedDocument);
    expect(report.skipLink.activation.hashChanged).toBe(kind !== 'reload');
    if (replacedDocument)
      expect(['skip', 'audited-action']).toContain(report.stops[1].id);
    else
      expect(report.stops[1].id).toBe('audited-action');
    expect(report.metadata.url).toBe(replacedDocument ? startUrl : kind === 'fragment' ? `${startUrl}#main` : `${origin}/rewritten?view=main#main`);
    expect(await ok('browser_evaluate', { function: '() => !!document.getElementById("audited-action")' })).toContain('true');
    const historyDelta = ['push', 'fragment', 'document'].includes(kind) ? 1 : 0;
    expect(await ok('browser_evaluate', {
      function: `() => history.length === Number(sessionStorage.getItem("keyboard-history-length")) + ${historyDelta}`,
    })).toContain('true');
    if (kind === 'location-replace' || kind === 'document-forward') {
      await ok('browser_navigate_back');
      const expectedUrl = kind === 'location-replace' ? `${origin}/prior` : startUrl;
      expect(await ok('browser_evaluate', { function: '() => location.href' })).toContain(expectedUrl);
    }
    if (kind === 'document') {
      await ok('browser_evaluate', { function: '() => history.forward()' });
      expect(await ok('browser_evaluate', { function: '() => location.pathname === "/target"' })).toContain('true');
    }
  }
);

it.skipIf(!canRun)('names stops from every aria-labelledby id reference', async () => {
  directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'audit-keyboard-labelledby-'));
  const config = await resolveCLIConfig({ browser, headless: true, isolated: true, outputDir: directory });
  client = new Client({ name: 'keyboard-labelledby-test', version: '1' });
  await client.connect(await wrapInProcess(new BrowserServerBackend(config, contextFactory(config))));
  await ok('browser_navigate', { url: `${origin}/labelledby` });
  await ok('audit_keyboard', {
    maxTabs: 1,
    activateSkipLink: false,
    checkFocusTrap: false,
    checkFocusVisibility: false,
    checkFocusJumps: false,
    checkTargetSize: false,
    checkFocusObscured: false,
    reportFile: 'keyboard.json',
  });
  const report = JSON.parse(await fs.promises.readFile(path.join(directory, 'keyboard.json'), 'utf8'));
  const stop = report.stops.find((s: { id: string | null }) => s.id === 'labelled');
  expect(stop?.name).toBe('Save draft');
});

it.skipIf(!canRun).each(['focus-identity', 'shadow-focus', 'reverse-focus', 'trapped-focus'])(
  'distinguishes actual traps from %s traversal', async fixture => {
    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'audit-keyboard-identity-'));
    const config = await resolveCLIConfig({ browser, headless: true, isolated: true, outputDir: directory, timeoutSettle: 0 });
    client = new Client({ name: 'keyboard-identity-test', version: '1' });
    await client.connect(await wrapInProcess(new BrowserServerBackend(config, contextFactory(config))));
    await ok('browser_navigate', { url: `${origin}/${fixture}` });
    await ok('audit_keyboard', {
      maxTabs: 3,
      includeShiftTab: fixture === 'reverse-focus',
      checkSkipLink: false,
      checkFocusVisibility: false,
      checkFocusJumps: false,
      checkTargetSize: false,
      checkFocusObscured: true,
      reportFile: 'keyboard.json',
    });
    const report = JSON.parse(await fs.promises.readFile(path.join(directory, 'keyboard.json'), 'utf8'));
    if (fixture === 'trapped-focus') {
      expect(report.focusTrap.detected).toBe(true);
      expect(report.focusTrap.step).toBe(1);
      expect(report.stops[0].name).toBe('After');
      return;
    }
    expect(report.focusTrap.detected).toBe(false);
    expect(report.focusObscuredIssues).toEqual([]);
    expect(report.stops.map((stop: { name: string }) => stop.name)).toEqual(
      fixture === 'reverse-focus' ? ['Three', 'Two', 'Three'] : ['Save', 'Save', 'Last']
    );
    expect(report.uniqueFingerprints).toBe(fixture === 'reverse-focus' ? 2 : 3);
  }
);

it.skipIf(!canRun).each([false, true])('checks shadow-tree paint ownership when covered=%s', async covered => {
  directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'audit-keyboard-obscuration-'));
  const config = await resolveCLIConfig({ browser, headless: true, isolated: true, outputDir: directory, timeoutSettle: 0 });
  client = new Client({ name: 'keyboard-obscuration-test', version: '1' });
  await client.connect(await wrapInProcess(new BrowserServerBackend(config, contextFactory(config))));
  await ok('browser_navigate', { url: `${origin}/shadow-obscuration${covered ? '?covered' : ''}` });
  await ok('audit_keyboard', {
    maxTabs: 1,
    checkSkipLink: false,
    checkFocusTrap: false,
    checkFocusVisibility: false,
    checkFocusJumps: false,
    checkTargetSize: false,
    checkFocusObscured: true,
    reportFile: 'keyboard.json',
  });
  const report = JSON.parse(await fs.promises.readFile(path.join(directory, 'keyboard.json'), 'utf8'));
  expect(report.stops.map((stop: { id: string }) => stop.id)).toEqual(['target']);
  expect(report.focusObscuredIssues.map((stop: { id: string }) => stop.id)).toEqual(covered ? ['target'] : []);
});
