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
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { contextFactory } from '../src/browserContextFactory.js';
import { resolveConfig } from '../src/config.js';

it('detaches a synthetic target without browserContextId and keeps the CDP client usable (#303)', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const commands: string[] = [];
  const version = { product: 'HeadlessChrome/158.0.8127.18', userAgent: 'HeadlessChrome', revision: 'synthetic', jsVersion: 'test', protocolVersion: '1.3' };
  server.on('connection', socket => {
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      commands.push(message.method);
      if (message.method === 'Target.setAutoAttach') {
        socket.send(JSON.stringify({ method: 'Target.attachedToTarget', params: {
          sessionId: 'orphan-worker', waitingForDebugger: false,
          targetInfo: { targetId: 'terminated-worker', type: 'shared_worker', url: '', title: '', attached: true, canAccessOpener: false },
        } }));
      }
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
    // A dependency assertion must fail the child, without killing Vitest itself.
    const script = `import { chromium } from 'playwright';
      const browser = await chromium.connectOverCDP(process.argv[1], { timeout: 5000 });
      const session = await browser.newBrowserCDPSession();
      const result = await session.send('Browser.getVersion');
      console.log(JSON.stringify({ case: 'synthetic-orphan-target', version: browser.version(), followup: result.product }));
      await browser.close();`;
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, `ws://127.0.0.1:${address.port}`], { timeout: 10000 });
    process.stdout.write(result.stdout);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ version: '158.0.8127.18', followup: version.product });
    expect(commands).toContain('Target.detachFromTarget');
    expect(commands.filter(command => command === 'Browser.getVersion')).toHaveLength(2);
  } finally {
    for (const socket of server.clients)
      socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('attaches through MCP after a second client inspects a terminated shared worker (#303)', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/worker.js') {
      response.setHeader('content-type', 'application/javascript');
      response.end(`onconnect = event => { const port = event.ports[0]; port.onmessage = event => port.postMessage('echo:' + event.data); };`);
    } else {
      response.setHeader('content-type', 'text/html');
      response.end(`<script>window.responsePromise = new Promise(resolve => {
        const worker = new SharedWorker('/worker.js');
        worker.port.onmessage = event => resolve(event.data);
        worker.port.postMessage('hello');
      });</script><h1>Shared worker control</h1>`);
    }
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let backend: BrowserServerBackend | undefined;
  let stage = 'launch';
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP fixture server');
    const origin = `http://127.0.0.1:${address.port}`;
    // Browser.getBrowserCommandLine requires this flag to discover the OS-assigned CDP port.
    browser = await chromium.launch({ args: ['--remote-debugging-port=0', '--enable-automation'] });
    const inspector = await browser.newBrowserCDPSession();
    const { arguments: browserArguments } = await inspector.send('Browser.getBrowserCommandLine');
    const profile = browserArguments.find(argument => argument.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
    expect(profile).toBeDefined();
    const port = (await readFile(`${profile}/DevToolsActivePort`, 'utf8')).split('\n')[0];
    const workerCreated = new Promise<string>(resolve => inspector.on('Target.targetCreated', event => {
      if (event.targetInfo.type === 'shared_worker')
        resolve(event.targetInfo.targetId);
    }));
    await inspector.send('Target.setDiscoverTargets', { discover: true });
    const page = await browser.newPage();
    await page.goto(origin);
    expect(await page.evaluate('window.responsePromise')).toBe('echo:hello');
    const workerTarget = await workerCreated;
    stage = 'worker-created';
    await inspector.send('Target.attachToTarget', { targetId: workerTarget, flatten: true });
    await page.close();
    await expect.poll(async () => {
      const { targetInfos } = await inspector.send('Target.getTargets');
      return targetInfos.some(info => info.targetId === workerTarget);
    }, { timeout: 5000 }).toBe(false);
    stage = 'worker-terminated';
    const config = await resolveConfig({ browser: { cdpEndpoint: `http://127.0.0.1:${port}`, cdpTimeout: 5000 }, timeouts: { settle: 0 } });
    backend = new BrowserServerBackend(config, contextFactory(config));
    await backend.initialize({ notifyToolListChanged: async () => {} }, { name: 'shared-worker-upgrade', version: '1' });
    stage = 'mcp-attach';
    const result = await backend.callTool('browser_navigate', { url: origin });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    stage = 'mcp-followup';
    const followup = await backend.callTool('browser_snapshot', {});
    expect(followup.isError, JSON.stringify(followup.content)).not.toBe(true);
    expect(JSON.stringify(followup.content)).toContain('Shared worker control');
    stage = 'passed';
    expect(browser.isConnected()).toBe(true);
  } finally {
    process.stdout.write(JSON.stringify({ case: 'terminated-shared-worker', stage, browserVersion: browser?.version(), connected: browser?.isConnected() }) + '\n');
    backend?.serverClosed();
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
