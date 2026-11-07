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

import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { chromium, type Browser, type ConnectOverCDPOptions } from 'playwright';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectOverCDP, filterAutoAttach } from '../src/utils/cdpConnection.js';

const cleanup: Array<() => Promise<unknown>> = [];
const browsers: Browser[] = [];
const commandSchema = z.object({ id: z.number(), method: z.string(), sessionId: z.string().optional(), params: z.record(z.string(), z.unknown()).optional() });
const version = { product: 'HeadlessChrome/158.0.8127.18', userAgent: 'HeadlessChrome', revision: 'fixture', jsVersion: 'fixture', protocolVersion: '1.3' };

async function listen(server: http.Server | net.Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP fixture');
  return address.port;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const browser of browsers.splice(0))
    await browser.close();
  for (const close of cleanup.splice(0).reverse())
    await close();
  vi.restoreAllMocks();
});

function relayEndpoint(calls: ReadonlyArray<ReadonlyArray<unknown>>) {
  const endpoint = calls[0]?.[0];
  if (typeof endpoint !== 'string')
    throw new Error('Expected a standard CDP URL');
  return endpoint;
}

async function expectRelayClosed(endpoint: string) {
  const url = new URL(endpoint);
  await expect.poll(() => new Promise<boolean>((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => {
      socket.destroy();
      if ('code' in error && error.code === 'ECONNREFUSED')
        resolve(true);
      else
        reject(error);
    });
  })).toBe(true);
}

async function rejectedHandshake(endpoint: string, headers?: Record<string, string>) {
  return new Promise<number | undefined>((resolve, reject) => {
    const socket = new WebSocket(endpoint, { headers });
    let rejected = false;
    socket.on('unexpected-response', (_request, response) => {
      rejected = true;
      response.resume();
      socket.terminate();
      resolve(response.statusCode);
    });
    socket.on('error', error => {
      if (!rejected)
        reject(error);
    });
  });
}

async function cdpFixture(respond = true) {
  const requests: Array<{ url: string | undefined; headers: http.IncomingHttpHeaders }> = [];
  const upgrades: http.IncomingHttpHeaders[] = [];
  const commands: z.infer<typeof commandSchema>[] = [];
  let port = 0;
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/browser` }));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket, request) => {
    upgrades.push(request.headers);
    socket.on('message', data => {
      const command = commandSchema.parse(JSON.parse(data.toString()));
      commands.push(command);
      if (!respond)
        return;
      const result = command.method === 'Browser.getVersion' ? version
        : command.method === 'Target.getTargetInfo' ? { targetInfo: { type: 'browser' } }
        : command.method === 'Target.attachToBrowserTarget' ? { sessionId: `session-${command.id}` } : {};
      socket.send(JSON.stringify({ id: command.id, sessionId: command.sessionId, result }));
    });
  });
  cleanup.push(async () => {
    for (const socket of sockets.clients)
      socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  port = await listen(server);
  return { server, sockets, requests, upgrades, commands, url: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/browser` };
}

describe('CDP root target filtering', () => {
  it('excludes only unsupported shared workers while preserving native default filters and parameters', () => {
    const input = { id: 2, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: false } };
    expect(filterAutoAttach(input)).toEqual({ ...input, params: { ...input.params, filter: [
      { type: 'shared_worker', exclude: true }, { type: 'browser', exclude: true }, { type: 'tab', exclude: true }, {},
    ] } });
    expect(input.params).not.toHaveProperty('filter');
  });

  it('retains explicit filters and leaves child sessions, disabling and unrelated commands unchanged', () => {
    const root = { method: 'Target.setAutoAttach', params: { autoAttach: true, filter: [{ type: 'page' }, { exclude: true }] } };
    expect(filterAutoAttach(root)).toEqual({ ...root, params: { ...root.params, filter: [{ type: 'shared_worker', exclude: true }, { type: 'page' }, { exclude: true }] } });
    for (const message of [
      { ...root, sessionId: 'child' },
      { method: 'Target.setAutoAttach', params: { autoAttach: false } },
      { method: 'Fetch.enable', params: { patterns: [{ urlPattern: '*' }] } },
    ])
      expect(filterAutoAttach(message)).toBe(message);
  });
});

it.each(['http', 'ws'])('preserves %s upstream credentials and remote options without forwarding credentials to the loopback relay', async mode => {
  const fixture = await cdpFixture();
  const connect = vi.spyOn(chromium, 'connectOverCDP');
  const browser = await connectOverCDP(mode === 'http' ? `${fixture.url}/gateway?key=fixture` : fixture.ws, {
    headers: { 'Authorization': 'Bearer fixture-token', 'User-Agent': 'fixture-client', 'Origin': 'https://gateway.example', 'Host': 'gateway.example' },
    timeout: 2000, noDefaults: true, isLocal: false,
  });
  browsers.push(browser);
  expect(connect).toHaveBeenCalledWith(expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+\/[a-zA-Z0-9-]+$/), expect.objectContaining({ headers: undefined, isLocal: false, noDefaults: true, timeout: expect.any(Number) }));
  expect(fixture.upgrades[0]).toMatchObject({ 'authorization': 'Bearer fixture-token', 'user-agent': 'fixture-client', 'origin': 'https://gateway.example', 'host': 'gateway.example' });
  if (mode === 'http')
    expect(fixture.requests[0]).toMatchObject({ url: '/gateway/json/version/?key=fixture', headers: { authorization: 'Bearer fixture-token' } });
  const root = fixture.commands.find(command => command.method === 'Target.setAutoAttach' && !command.sessionId);
  expect(root?.params).toMatchObject({ filter: [{ type: 'shared_worker', exclude: true }, { type: 'browser', exclude: true }, { type: 'tab', exclude: true }, {}] });
  const session = await browser.newBrowserCDPSession();
  await session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'service_worker' }] });
  expect(fixture.commands.at(-1)?.params).toMatchObject({ filter: [{ type: 'service_worker' }] });
  await browser.close();
  await expect.poll(() => fixture.sockets.clients.size).toBe(0);
  await expectRelayClosed(relayEndpoint(connect.mock.calls));
});

it('retains the pinned provider credential-stripping policy for WebSocket redirects', async () => {
  const fixture = await cdpFixture();
  const redirect = http.createServer();
  redirect.on('upgrade', (_request, socket) => socket.end(`HTTP/1.1 302 Found\r\nLocation: ${fixture.ws}\r\nConnection: close\r\n\r\n`));
  cleanup.push(() => new Promise<void>(resolve => redirect.close(() => resolve())));
  const port = await listen(redirect);
  const browser = await connectOverCDP(`ws://127.0.0.1:${port}/redirect`, { headers: { 'Authorization': 'Bearer fixture-token', 'x-access-key': 'fixture-secret', 'User-Agent': 'fixture-client' }, timeout: 2000 });
  browsers.push(browser);
  expect(fixture.upgrades[0]).not.toHaveProperty('authorization');
  expect(fixture.upgrades[0]).not.toHaveProperty('x-access-key');
  expect(fixture.upgrades[0]['user-agent']).toBe('fixture-client');
});

it('cancels a stalled HTTP discovery request at the whole connection deadline', async () => {
  const sockets = new Set<net.Socket>();
  let requests = 0;
  const server = http.createServer(() => requests++);
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = await listen(server);
  await expect(connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 150 })).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(requests).toBe(1);
  await expect.poll(() => sockets.size).toBe(0);
});

it('cancels a stalled WebSocket handshake rather than leaving a pending connection', async () => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.resume(); });
  cleanup.push(() => new Promise<void>(resolve => {
    for (const socket of sockets)
      socket.destroy();
    server.close(() => resolve());
  }));
  const port = await listen(server);
  await expect(connectOverCDP(`ws://127.0.0.1:${port}`, { timeout: 150 })).rejects.toMatchObject({ name: 'TimeoutError' });
  await expect.poll(() => sockets.size).toBe(0);
});

it('cleans the relay and upstream when browser initialization exceeds the remaining budget', async () => {
  const connect = vi.spyOn(chromium, 'connectOverCDP');
  const fixture = await cdpFixture(false);
  await expect(connectOverCDP(fixture.ws, { timeout: 150 })).rejects.toMatchObject({ name: 'TimeoutError', message: expect.stringContaining('<ws connected>') });
  expect(fixture.commands.some(command => command.method === 'Browser.getVersion')).toBe(true);
  await expect.poll(() => fixture.sockets.clients.size).toBe(0);
  await expectRelayClosed(relayEndpoint(connect.mock.calls));
});

it('preserves explicit timeout zero and the default user agent', async () => {
  const fixture = await cdpFixture();
  const connect = vi.spyOn(chromium, 'connectOverCDP');
  const browser = await connectOverCDP(fixture.ws, { timeout: 0 });
  browsers.push(browser);
  expect(connect).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ timeout: 0 }));
  expect(fixture.upgrades[0]['user-agent']).toMatch(/^Playwright\//);
  expect(browser.isConnected()).toBe(true);
});


it('rejects bad nonces and browser Origins before accepting its only legitimate CDP client', async () => {
  const fixture = await cdpFixture();
  const original = chromium.connectOverCDP.bind(chromium);
  vi.spyOn(chromium, 'connectOverCDP').mockImplementation(async (endpoint: unknown, options?: ConnectOverCDPOptions) => {
    if (typeof endpoint !== 'string')
      throw new Error('Expected standard URL transport');
    expect(await rejectedHandshake(`${endpoint}-invalid`)).toBe(401);
    expect(await rejectedHandshake(endpoint, { Origin: 'https://untrusted.example' })).toBe(401);
    return original(endpoint, options);
  });
  const browser = await connectOverCDP(fixture.ws, { timeout: 2000 });
  browsers.push(browser);
  expect(browser.isConnected()).toBe(true);
});

it('clears a finite startup deadline after a successful connection', async () => {
  const fixture = await cdpFixture();
  const connect = vi.spyOn(chromium, 'connectOverCDP');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const browser = await connectOverCDP(fixture.ws, { timeout: 1000 });
  browsers.push(browser);
  await vi.advanceTimersByTimeAsync(1500);
  const session = await browser.newBrowserCDPSession();
  expect((await session.send('Browser.getVersion')).product).toBe(version.product);
  expect(await rejectedHandshake(relayEndpoint(connect.mock.calls))).toBe(401);
});
