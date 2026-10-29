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
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { createConnection } from '../src/index.js';
import { InProcessTransport } from '../src/mcp/inProcessTransport.js';
import { once } from 'node:events';
import { chromium, type Browser } from 'playwright';
import { WebSocketServer } from 'ws';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { ensureNetworkPolicyRoutes } from '../src/networkPolicy.js';

let browser: Browser;
let allowed: string;
let blocked: string;
const hits: string[] = [];
const blockedServer = http.createServer((request, response) => {
  hits.push(request.url!);
  response.end('blocked destination');
});
const sockets = new WebSocketServer({ server: blockedServer });
sockets.on('connection', socket => {
  hits.push('websocket');
  socket.send('connected');
});
const allowedServer = http.createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', '*');
  const origin = new URL(request.url!, allowed);
  if (origin.pathname === '/redirect') {
    response.writeHead(302, { location: `${allowed}/middle` });
    response.end();
  } else if (origin.pathname === '/middle') {
    response.writeHead(307, { location: `${blocked}/final` });
    response.end();
  } else if (origin.pathname === '/post') {
    response.writeHead(307, { 'location': '/echo', 'set-cookie': 'redirect=preserved; Path=/' });
    response.end();
  } else if (origin.pathname === '/echo') {
    let body = '';
    for await (const data of request)
      body += data;
    response.end(JSON.stringify({ method: request.method, body, cookie: request.headers.cookie }));
  } else {
    response.setHeader('content-type', 'text/html');
    response.end('<title>Allowed</title><body>Allowed page</body>');
  }
});

const allowedSockets = new WebSocketServer({ server: allowedServer });
allowedSockets.on('connection', socket => socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary })));

beforeAll(async () => {
  blockedServer.listen(0, '127.0.0.1');
  allowedServer.listen(0, '127.0.0.1');
  await Promise.all([once(blockedServer, 'listening'), once(allowedServer, 'listening')]);
  blocked = `http://127.0.0.1:${(blockedServer.address() as import('node:net').AddressInfo).port}`;
  allowed = `http://127.0.0.1:${(allowedServer.address() as import('node:net').AddressInfo).port}`;
});

afterAll(async () => {
  await browser?.close();
  for (const server of [sockets, allowedSockets]) {
    for (const socket of server.clients)
      socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await Promise.all([allowedServer, blockedServer].map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

it.each(['allowlist', 'blocklist'] as const)('enforces %s across redirect hops, frames, popups and page WebSockets', async policy => {
  browser = await chromium.launch();
  const context = await browser.newContext();
  try {
    const config = await resolveConfig({ browser: { browserName: 'chromium', isolated: true }, network: policy === 'allowlist' ? { allowedOrigins: [new URL(allowed).host] } : { blockedOrigins: [new URL(blocked).host] } });
    await ensureNetworkPolicyRoutes(config, context);
    hits.length = 0;
    for (const url of [`${blocked}/direct`, `${allowed}/redirect`]) {
      const target = await context.newPage();
      await target.goto(url).catch(() => {});
      await target.close();
    }
    expect(hits).toEqual([]);
    const page = await context.newPage();
    await page.goto(allowed);
    await page.evaluate(async url => {
      await Promise.all([
        fetch(`${url}/redirect`).catch(() => {}),
        new Promise<void>(resolve => {
          const frame = document.createElement('iframe');
          frame.onload = () => resolve();
          frame.src = `${url}/redirect`;
          document.body.append(frame);
        }),
      ]);
    }, allowed);
    const popupPromise = context.waitForEvent('page');
    await page.evaluate(url => window.open(url), `${allowed}/redirect`);
    const popup = await popupPromise;
    await popup.waitForLoadState().catch(() => {});
    await popup.close();
    const opened = await page.evaluate(url => new Promise<boolean>(resolve => {
      const socket = new WebSocket(url.replace('http:', 'ws:'));
      socket.onopen = () => { socket.close(); resolve(true); };
      socket.onerror = () => resolve(false);
      socket.onclose = () => resolve(false);
    }), blocked);
    expect(opened).toBe(false);
    expect(hits).toEqual([]);
    const echoed = await page.evaluate(async url => {
      const response = await fetch(`${url}/post`, { method: 'POST', body: 'keep=this', credentials: 'include' });
      return { url: response.url, data: await response.json() };
    }, allowed);
    expect(echoed).toEqual({ url: `${allowed}/echo`, data: { method: 'POST', body: 'keep=this', cookie: 'redirect=preserved' } });
    await page.goto(`${allowed}/post`);
    expect(page.url()).toBe(`${allowed}/echo`);
  } finally {
    await context.close();
    await browser.close();
  }
});

it.each([true, false])('enforces redirect restrictions through MCP with isolated=%s', async isolated => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'network-policy-'));
  const server = await createConnection({
    browser: { browserName: 'chromium', isolated, userDataDir: directory, launchOptions: { channel: 'chromium', headless: true } },
    network: { blockedOrigins: [new URL(blocked).host] },
  });
  const client = new Client({ name: 'network-policy-test', version: '1' });
  try {
    await client.connect(new InProcessTransport(server));
    hits.length = 0;
    const result = await client.callTool({ name: 'browser_navigate', arguments: { url: `${allowed}/redirect` } });
    expect(result.isError).toBe(true);
    expect(hits).toEqual([]);
  } finally {
    await client.callTool({ name: 'browser_close', arguments: {} }).catch(() => {});
    await client.close();
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('characterizes the documented worker-WebSocket limitation of page routing', async () => {
  browser = await chromium.launch();
  const context = await browser.newContext();
  try {
    await ensureNetworkPolicyRoutes(await resolveConfig({ network: { blockedOrigins: [new URL(blocked).host] } }), context);
    const page = await context.newPage();
    await page.goto(allowed);
    hits.length = 0;
    const result = await page.evaluate(url => new Promise<string>((resolve, reject) => {
      const source = `const socket = new WebSocket(${JSON.stringify(url.replace('http:', 'ws:'))}); socket.onopen = () => { postMessage('opened'); socket.close(); }; socket.onerror = () => postMessage('error');`;
      const objectURL = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const worker = new Worker(objectURL);
      worker.onmessage = event => { worker.terminate(); URL.revokeObjectURL(objectURL); resolve(event.data); };
      worker.onerror = event => { worker.terminate(); URL.revokeObjectURL(objectURL); reject(new Error(event.message)); };
    }), blocked);
    expect(result).toBe('opened');
    expect(hits).toEqual(['websocket']);
  } finally {
    await context.close();
    await browser.close();
  }
});

it('blocks page socket handshakes while preserving allowed socket messages', async () => {
  browser = await chromium.launch();
  const context = await browser.newContext();
  try {
    await ensureNetworkPolicyRoutes(await resolveConfig({ network: { blockedOrigins: [new URL(blocked).host] } }), context);
    const page = await context.newPage();
    await page.goto(allowed);
    hits.length = 0;
    const result = await page.evaluate(async urls => {
      const exchange = (url: string) => new Promise<string>(resolve => {
        const socket = new WebSocket(url.replace('http:', 'ws:'));
        socket.onopen = () => socket.send('unchanged message');
        socket.onmessage = event => { resolve(event.data); socket.close(); };
        socket.onclose = () => resolve('closed');
        socket.onerror = () => resolve('error');
      });
      return Promise.all(urls.map(exchange));
    }, [allowed, blocked]);
    expect(result[0]).toBe('unchanged message');
    expect(['closed', 'error']).toContain(result[1]);
    expect(hits).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
  }
});

it('filters redirect destinations from a verified out-of-process iframe', async () => {
  browser = await chromium.launch({ args: ['--site-per-process'] });
  const context = await browser.newContext();
  try {
    await ensureNetworkPolicyRoutes(await resolveConfig({ network: { blockedOrigins: [new URL(blocked).host] } }), context);
    const page = await context.newPage();
    await page.goto(allowed);
    const childOrigin = allowed.replace('127.0.0.1', 'localhost');
    await page.evaluate(url => new Promise<void>(resolve => {
      const frame = document.createElement('iframe');
      frame.onload = () => resolve();
      frame.src = url;
      document.body.append(frame);
    }), childOrigin);
    const session = await browser.newBrowserCDPSession();
    const targets = await session.send('Target.getTargets');
    expect(targets.targetInfos.some(target => target.type === 'iframe' && target.url.startsWith(childOrigin))).toBe(true);
    await session.detach();
    const frame = page.frames().find(frame => frame.url() === `${childOrigin}/`)!;
    hits.length = 0;
    await frame.evaluate(url => fetch(`${url}/redirect`).catch(() => {}), childOrigin);
    expect(hits).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
  }
});
