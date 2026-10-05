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

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { contextFactory } from '../src/browserContextFactory.js';
import { resolveConfig } from '../src/config.js';
import { runAxeScan } from '../src/tools/axe.js';

const require = createRequire(import.meta.url);
const pinned = require('playwright/package.json').version === '1.63.0' && require('playwright-core/package.json').version === '1.63.0';

it.each(['endpoint', 'launch'] as const)('characterizes the top document when attaching through %s to a preloaded frame tree (#42955)', async mode => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-cdp-frame-tree-'));
  let origin: string;
  let ready = false;
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    const url = new URL(origin);
    url.hostname = 'localhost';
    switch (request.url) {
      case '/':
        response.end(`<script>onload=()=>fetch('/ready')</script><h1 id="top">TOP</h1><img id="missing-alt" src="data:image/png;base64,iVBORw0KGgo="><iframe src="${url}b"></iframe>`);
        break;
      case '/b':
        response.end('<iframe src="/c"></iframe>');
        break;
      case '/c':
        response.end(`<iframe sandbox="allow-scripts" srcdoc="<p>D</p>"></iframe>`);
        break;
      case '/ready':
        ready = true;
        response.end();
        break;
      default:
        response.end();
    }
  });
  let child: ReturnType<typeof spawn> | undefined;
  let attached: Awaited<ReturnType<ReturnType<typeof contextFactory>['createContext']>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP server');
    origin = `http://127.0.0.1:${address.port}`;
    // Launch without a Playwright connection: the missing parent frame must
    // already exist before the first attach to reproduce the upstream report.
    child = spawn(chromium.executablePath(), [
      '--headless=new', '--no-sandbox', '--use-mock-keychain', '--password-store=basic', '--no-first-run', '--remote-debugging-port=0',
      `--user-data-dir=${directory}`, `${origin}/`,
    ], { stdio: 'ignore' });
    await once(child, 'spawn');
    await expect.poll(() => ready, { timeout: 15000 }).toBe(true);
    const port = Number((await fs.readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
    const endpoint = `http://127.0.0.1:${port}`;
    const targets = await (await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
    expect(targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'page', url: `${origin}/` }),
      expect.objectContaining({ type: 'iframe', url: 'about:srcdoc' }),
    ]));
    // The launch fixture forwards to the already-preloaded disposable browser.
    // The factory owns the forwarder; only this test owns the browser process.
    const forwarder = `const net = require('node:net');
      net.createServer(socket => {
        const upstream = net.connect(${port}, '127.0.0.1');
        socket.pipe(upstream).pipe(socket);
        socket.on('error', () => upstream.destroy());
        upstream.on('error', () => socket.destroy());
      }).listen(Number(process.argv[1]), '127.0.0.1');`;
    const config = await resolveConfig({ browser: mode === 'endpoint'
      ? { cdpEndpoint: endpoint, cdpTimeout: 5000 }
      : { cdpLaunch: { command: process.execPath, args: ['-e', forwarder, '{port}'], startupTimeoutMs: 10000 }, cdpTimeout: 5000 },
    });
    attached = await contextFactory(config).createContext({}, new AbortController().signal, undefined);
    const context = attached.browserContext;
    // Target attachment is racy: the preloaded page may register after attach.
    await expect.poll(() => context.pages().length, { timeout: 5000 }).toBeGreaterThan(0);
    const page = context.pages()[0];
    expect(page.url()).toBe(`${origin}/`);
    const cdp = await attached.browserContext.newCDPSession(page);
    try {
      const raw = await cdp.send('Runtime.evaluate', { expression: '({ url: location.href, top: window.top === window })', returnByValue: true });
      expect(raw.result.value).toEqual({ url: `${origin}/`, top: true });
    } finally {
      await cdp.detach();
    }
    const document = await page.evaluate(() => ({ url: location.href, top: window.top === window })).catch((error: Error) => error.message);
    const topCount = await page.locator('#top').count().catch((error: Error) => error.message);
    const scan = await runAxeScan(page, { rules: ['image-alt'], include: ['#missing-alt'] }).catch((error: Error) => error.message);
    process.stdout.write(JSON.stringify({ mode, document, topCount, scan }) + '\n');
    if (pinned) {
      // Target attachment is racy: evaluation can still reach the top document
      // before the later locator/scan is redirected. Accept only observed
      // corruption signatures, or a healthy operation, never arbitrary errors.
      if (typeof document === 'string')
        expect(document).toContain('Execution context was destroyed');
      else
        expect([{ url: `${origin}/`, top: true }, { url: 'about:srcdoc', top: false }]).toContainEqual(document);
      if (typeof topCount === 'string')
        expect(topCount).toContain('Execution context was destroyed');
      else
        expect([0, 1]).toContain(topCount);
      if (typeof scan === 'string')
        expect(scan).toMatch(/Execution context was destroyed|^No elements matched includeSelectors: #missing-alt\./);
      else
        expect(scan).toMatchObject({ url: `${origin}/`, violations: [{ id: 'image-alt', nodes: [{ target: ['#missing-alt'] }] }] });
    } else {
      expect(document).toEqual({ url: `${origin}/`, top: true });
      expect(topCount).toBe(1);
      expect(scan).toMatchObject({ url: `${origin}/`, violations: [{ id: 'image-alt', nodes: [{ target: ['#missing-alt'] }] }] });
    }
    const controlContext = await attached.browserContext.browser()!.newContext();
    try {
      const control = await controlContext.newPage();
      await control.goto(`${origin}/`);
      expect(await control.evaluate(() => ({ url: location.href, top: window.top === window }))).toEqual({ url: `${origin}/`, top: true });
      expect(await control.locator('#top').count()).toBe(1);
      expect(await runAxeScan(control, { rules: ['image-alt'], include: ['#missing-alt'] })).toMatchObject({
        url: `${origin}/`, violations: [{ id: 'image-alt', nodes: [{ target: ['#missing-alt'] }] }],
      });
    } finally {
      await controlContext.close();
    }
  } finally {
    try {
      try {
        // A CDP disconnect does not stop this test-owned browser. Ask it to exit
        // before deleting its profile so child processes cannot keep writing it.
        const browser = attached?.browserContext.browser();
        if (browser?.isConnected()) {
          const cdp = await browser.newBrowserCDPSession();
          await cdp.send('Browser.close');
        }
      } finally {
        await attached?.close();
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const ownedChild = child;
        const exited = once(ownedChild, 'exit');
        const deadline = setTimeout(() => ownedChild.kill('SIGKILL'), 5000);
        try {
          await exited;
        } finally {
          clearTimeout(deadline);
        }
      }
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});
