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

import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import coreBundle from 'playwright-core/lib/coreBundle';
import { connectOverCDP } from '../src/utils/cdpConnection.js';
import http from 'node:http';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { chromium, type Browser, type BrowserServer } from 'playwright';
import { expect, it, vi } from 'vitest';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { contextFactory } from '../src/browserContextFactory.js';
import { resolveConfig } from '../src/config.js';

it('detaches an orphan worker without terminating the CDP client (#303)', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const detached: string[] = [];
  const version = { product: 'HeadlessChrome/158.0.8127.18', userAgent: 'HeadlessChrome', revision: 'synthetic', jsVersion: 'test', protocolVersion: '1.3' };
  server.on('connection', socket => {
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.method === 'Target.setAutoAttach') {
        socket.send(JSON.stringify({ method: 'Target.attachedToTarget', params: {
          sessionId: 'orphan-worker', waitingForDebugger: false,
          targetInfo: { targetId: 'terminated-worker', type: 'shared_worker', url: '', title: '', attached: true, canAccessOpener: false },
        } }));
      }
      if (message.method === 'Target.detachFromTarget')
        detached.push(message.params.sessionId);
      const result = message.method === 'Browser.getVersion' ? version
        : message.method === 'Target.getTargetInfo' ? { targetInfo: { type: 'browser' } }
        : message.method === 'Target.attachToBrowserTarget' ? { sessionId: 'followup-session' } : {};
      socket.send(JSON.stringify({ id: message.id, sessionId: message.sessionId, result }));
    });
  });
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP WebSocket server');
    const script = `import { chromium } from 'playwright';
      const browser = await chromium.connectOverCDP(process.argv[1], { timeout: 2000 });
      const session = await browser.newBrowserCDPSession();
      const result = await session.send('Browser.getVersion');
      console.log(JSON.stringify({ version: browser.version(), followup: result.product }));
      await browser.close();`;
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, `ws://127.0.0.1:${address.port}`], { timeout: 5000, killSignal: 'SIGKILL' });
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ version: '158.0.8127.18', followup: version.product });
    expect(detached).toEqual(['orphan-worker']);
  } finally {
    for (const socket of server.clients)
      socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

// Strict opt-in: the upstream native Chromium crash is not an expected pass.
it.skipIf(process.env.MCP_TEST_SHARED_WORKER !== '1').each([
  { name: 'headless shell', channel: undefined },
  { name: 'full Chromium', channel: 'chromium' },
])('attaches through MCP after another client inspects a terminated shared worker (#303): $name', async ({ channel }) => {
  const server = http.createServer((request, response) => {
    if (request.url === '/worker.js') {
      response.setHeader('content-type', 'application/javascript');
      response.end(`onconnect = event => { const port = event.ports[0]; port.onmessage = event => port.postMessage('echo:' + event.data); };`);
    } else {
      response.setHeader('content-type', 'text/html');
      response.end(request.url === '/owner' ? `<script>window.responsePromise = new Promise(resolve => {
        const worker = new SharedWorker('/worker.js');
        window.sharedWorker = worker;
        worker.port.onmessage = event => resolve(event.data);
        worker.port.postMessage('hello');
      });</script><h1>Worker owner</h1>` : '<title>Healthy control</title><h1>Shared worker control</h1><input aria-label="Saved note">');
    }
  });
  let browserServer: BrowserServer | undefined;
  let browser: Browser | undefined;
  let backend: BrowserServerBackend | undefined;
  let stage = 'launch';
  let nativeExit: { code: number | null, signal: string | null } | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP fixture server');
    const origin = `http://127.0.0.1:${address.port}`;
    browserServer = await chromium.launchServer({ channel, args: ['--remote-debugging-port=0', '--enable-automation'], timeout: 10000 });
    process.stdout.write(JSON.stringify({ case: 'native-worker-browser', executable: browserServer.process().spawnfile, args: browserServer.process().spawnargs.slice(0, 3) }) + '\n');
    browserServer.process().on('exit', (code, signal) => { nativeExit = { code, signal }; });
    browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 5000 });
    const inspector = await browser.newBrowserCDPSession();
    const { arguments: browserArguments } = await inspector.send('Browser.getBrowserCommandLine');
    const profile = browserArguments.find(argument => argument.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
    expect(profile).toBeDefined();
    let port = 0;
    await expect.poll(async () => {
      const contents = await readFile(`${profile}/DevToolsActivePort`, 'utf8');
      port = Number(contents.match(/^(\d+)\r?\n/)?.[1]);
      return Number.isInteger(port) && port > 0 && port <= 65535;
    }, { timeout: 5000 }).toBe(true);
    const endpoint = `http://127.0.0.1:${port}`;
    const healthy = await browser.newPage();
    await healthy.goto(`${origin}/healthy`);
    await healthy.getByRole('textbox', { name: 'Saved note' }).fill('preserve this value');
    await inspector.send('Target.setDiscoverTargets', { discover: true });
    const owner = await browser.newPage();
    await owner.goto(`${origin}/owner`);
    expect(await owner.evaluate('window.responsePromise')).toBe('echo:hello');
    const { targetInfos } = await inspector.send('Target.getTargets');
    const worker = targetInfos.find(info => info.type === 'shared_worker' && info.url === `${origin}/worker.js`);
    expect(worker).toBeDefined();
    stage = 'worker-created';
    const attached = await inspector.send('Target.attachToTarget', { targetId: worker!.targetId, flatten: true });
    expect(attached.sessionId).not.toBe('');
    await owner.close();
    await expect.poll(async () => {
      const { targetInfos } = await inspector.send('Target.getTargets');
      return targetInfos.some(info => info.targetId === worker!.targetId);
    }, { timeout: 5000 }).toBe(false);
    stage = 'worker-terminated';
    const liveOwner = await browser.newPage();
    await liveOwner.goto(`${origin}/owner`);
    expect(await liveOwner.evaluate('window.responsePromise')).toBe('echo:hello');
    expect(await healthy.title()).toBe('Healthy control');
    const config = await resolveConfig({ browser: { cdpEndpoint: endpoint, cdpTimeout: 2000 }, timeouts: { settle: 0 } });
    backend = new BrowserServerBackend(config, contextFactory(config));
    await backend.initialize({ notifyToolListChanged: async () => {} }, { name: 'shared-worker-lifecycle', version: '1' });
    stage = 'mcp-attach';
    const started = Date.now();
    const created = await backend.callTool('browser_tabs', { action: 'new' });
    const elapsedMs = Date.now() - started;
    process.stdout.write(JSON.stringify({ case: 'terminated-shared-worker-attach', elapsedMs, result: created }) + '\n');
    expect(elapsedMs).toBeLessThan(5000);
    const listingStarted = Date.now();
    const tools = await backend.listTools({ signal: AbortSignal.timeout(3000) });
    expect(tools.some(tool => tool.name === 'browser_snapshot')).toBe(true);
    const listingElapsedMs = Date.now() - listingStarted;
    expect(listingElapsedMs).toBeLessThan(5000);
    process.stdout.write(JSON.stringify({ case: 'post-attach-tools-list', elapsedMs: listingElapsedMs, available: tools.length }) + '\n');
    expect(created.isError, JSON.stringify(created.content)).not.toBe(true);
    stage = 'mcp-navigate';
    const navigated = await backend.callTool('browser_navigate', { url: `${origin}/followup` });
    expect(navigated.isError, JSON.stringify(navigated.content)).not.toBe(true);
    const snapshot = await backend.callTool('browser_snapshot', {});
    expect(snapshot.isError, JSON.stringify(snapshot.content)).not.toBe(true);
    expect(JSON.stringify(snapshot.content)).toContain('Shared worker control');
    const closed = await backend.callTool('browser_close', {});
    expect(closed.isError, JSON.stringify(closed.content)).not.toBe(true);
    expect(browser.isConnected()).toBe(true);
    expect(healthy.isClosed()).toBe(false);
    expect(healthy.url()).toBe(`${origin}/healthy`);
    expect(await healthy.getByRole('textbox', { name: 'Saved note' }).inputValue()).toBe('preserve this value');
    expect(liveOwner.isClosed()).toBe(false);
    const liveEcho = await liveOwner.evaluate(`new Promise(resolve => {
      window.sharedWorker.port.onmessage = event => resolve(event.data);
      window.sharedWorker.port.postMessage('after-attach-and-close');
    })`);
    expect(liveEcho).toBe('echo:after-attach-and-close');
    process.stdout.write(JSON.stringify({ case: 'live-shared-worker-preserved', liveEcho }) + '\n');
    stage = 'passed';
  } finally {
    process.stdout.write(JSON.stringify({ case: 'terminated-shared-worker', stage, browserVersion: browser?.version(), connected: browser?.isConnected(), nativeExit }) + '\n');
    backend?.serverClosed();
    try {
      await browserServer?.kill();
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
}, 30000);

it.skipIf(process.env.MCP_TEST_SHARED_WORKER !== '1')('preserves remote file-payload uploads and explicit local file-path uploads', async () => {
  let native: BrowserServer | undefined;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cdp-relay-upload-'));
  const file = path.join(directory, 'note.txt');
  await writeFile(file, 'remote payload survives');
  try {
    native = await chromium.launchServer({ args: ['--remote-debugging-port=0', '--enable-automation'] });
    const owner = await chromium.connect(native.wsEndpoint());
    const inspector = await owner.newBrowserCDPSession();
    const commandLine = await inspector.send('Browser.getBrowserCommandLine');
    const profile = commandLine.arguments.find(argument => argument.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
    if (!profile)
      throw new Error('Missing fixture profile');
    let port = 0;
    await expect.poll(async () => {
      const contents = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8');
      port = Number(contents.match(/^(\d+)\r?\n/)?.[1]);
      return Number.isInteger(port) && port > 0 && port <= 65535;
    }, { timeout: 5000 }).toBe(true);
    const methods: string[] = [];
    const original = coreBundle.server.WebSocketTransport.connect.bind(coreBundle.server.WebSocketTransport);
    vi.spyOn(coreBundle.server.WebSocketTransport, 'connect').mockImplementation(async (...args) => {
      const transport = await original(...args);
      const send = transport.send.bind(transport);
      transport.send = message => {
        if ('method' in message && typeof message.method === 'string')
          methods.push(message.method);
        send(message);
      };
      return transport;
    });
    for (const isLocal of [false, true]) {
      methods.length = 0;
      const browser = await connectOverCDP(`http://127.0.0.1:${port}`, { isLocal, timeout: 3000, noDefaults: true });
      const page = await browser.newPage();
      await page.setContent('<input type="file">');
      await page.locator('input').setInputFiles(file);
      expect(await page.locator('input').evaluate(async element => {
        if (!(element instanceof HTMLInputElement) || !element.files?.[0])
          throw new Error('Expected uploaded file');
        return { name: element.files[0].name, text: await element.files[0].text() };
      })).toEqual({ name: 'note.txt', text: 'remote payload survives' });
      expect(methods.includes('DOM.setFileInputFiles')).toBe(isLocal);
      await page.close();
      await browser.close();
    }
    expect(owner.isConnected()).toBe(true);
  } finally {
    try {
      await native?.kill();
    } finally {
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
