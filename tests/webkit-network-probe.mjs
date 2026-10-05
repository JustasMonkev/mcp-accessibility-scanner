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

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { webkit } from 'playwright';
import { WebSocketServer } from 'ws';

// Opt-in upstream #42803 probe. Requires the pinned WebKit bundle and OpenSSL.
// A clean run is stress-test evidence, not proof the native race is absent.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-webkit-network-'));
const sockets = new Set();
const delays = new Set();
const networkErrors = [];
let browser;
let server;
let websocketServer;
let deadline;
let completed = 0;
let cancelledSubresources = 0;
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem'),
    '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' });
  server = https.createServer({
    key: await fs.readFile(path.join(directory, 'key.pem')),
    cert: await fs.readFile(path.join(directory, 'cert.pem')),
  }, (request, response) => {
    if (request.url.startsWith('/slow')) {
      response.writeHead(200, { 'content-type': 'application/javascript' });
      response.write('/* pending chunk */');
      const timer = setTimeout(() => { delays.delete(timer); response.end(); }, 2000);
      delays.add(timer);
      response.once('close', () => {
        clearTimeout(timer);
        delays.delete(timer);
        if (!response.writableEnded)
          cancelledSubresources++;
      });
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<script>
      window.socket = new WebSocket('wss://' + location.host);
      socket.onopen = () => window.socketOpened = true;
    </script><script async src="/slow?${request.url}"></script><p>Network fixture</p>`);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  websocketServer = new WebSocketServer({ server });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${server.address().port}`;
  browser = await webkit.launch({ timeout: 30_000 });
  deadline = setTimeout(() => {
    networkErrors.push('Probe exceeded 120 seconds');
    void browser.close().catch(error => networkErrors.push(`Timed-out browser cleanup failed: ${error.message}`));
  }, 120_000);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  context.on('page', page => {
    page.on('crash', () => networkErrors.push('Page crashed'));
  });
  const holders = await Promise.all(Array.from({ length: 3 }, () => context.newPage()));
  await Promise.all(holders.map(async page => {
    // Only these sockets must survive: the navigating page cancels its own.
    page.on('websocket', socket => socket.on('socketerror', error => networkErrors.push(error)));
    await page.goto(`${origin}/holder`, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    await page.waitForFunction(() => window.socketOpened, null, { timeout: 10_000 });
  }));
  const navigating = await context.newPage();
  for (let round = 0; round < 200; round++) {
    await Promise.all([
      navigating.waitForRequest(request => request.url() === `${origin}/slow?/a?round=${round}`, { timeout: 10_000 }),
      navigating.goto(`${origin}/a?round=${round}`, { waitUntil: 'commit', timeout: 10_000 }),
    ]);
    await navigating.goto(`${origin}/b?round=${round}`, { waitUntil: 'commit', timeout: 10_000 });
    assert.deepEqual(networkErrors, [], 'Browser reported a crash or WebSocket failure');
    completed++;
  }
  assert.ok(cancelledSubresources > 0, 'The probe must cancel an in-flight subresource');
  for (const page of holders)
    assert.equal(await page.evaluate(() => window.socket.readyState), 1, 'Holder WebSocket must remain open');
  process.stdout.write(JSON.stringify({ platform: process.platform, arch: process.arch, browser: browser.version(),
    executable: webkit.executablePath(), completed, cancelledSubresources, networkErrors, result: 'no crash observed; native race not ruled out' }) + '\n');
} finally {
  clearTimeout(deadline);
  try {
    await browser?.close();
  } finally {
    for (const timer of delays)
      clearTimeout(timer);
    for (const client of websocketServer?.clients ?? [])
      client.terminate();
    for (const socket of sockets)
      socket.destroy();
    try {
      await Promise.all([
        ...(server ? [new Promise(resolve => server.close(resolve))] : []),
        ...(websocketServer ? [new Promise(resolve => websocketServer.close(resolve))] : []),
      ]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}
