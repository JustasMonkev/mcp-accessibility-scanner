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

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { contextFactory } from '../lib/browserContextFactory.js';
import { resolveConfig } from '../lib/config.js';

for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'])
  delete process.env[key];
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-authenticated-proxy-'));
const proxyAuthorization = `Basic ${Buffer.from('disposable-proxy:proxy-password').toString('base64')}`;
const originAuthorization = `Basic ${Buffer.from('disposable-origin:origin-password').toString('base64')}`;
const servers = [];
const sockets = new Set();
const results = [];
let originRequests = [];
let proxyChallenges = 0;
let proxyAuthenticated = 0;
const listen = async server => {
  servers.push(server);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return server.address().port;
};
try {
  const origin = http.createServer((request, response) => {
    originRequests.push({ path: request.url, authorization: request.headers.authorization });
    if (request.url === '/challenge' && request.headers.authorization !== originAuthorization) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="disposable-origin"' });
      response.end('origin authentication required');
      return;
    }
    response.end('fixture');
  });
  const proxy = http.createServer((request, response) => {
    if (request.headers['proxy-authorization'] !== proxyAuthorization) {
      ++proxyChallenges;
      response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="disposable-proxy"' });
      response.end('proxy authentication required');
      return;
    }
    ++proxyAuthenticated;
    const target = new URL(request.url);
    const headers = { ...request.headers };
    delete headers['proxy-authorization'];
    const forward = http.request({ hostname: target.hostname, port: target.port, path: target.pathname,
      method: request.method, headers }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    });
    forward.on('error', error => response.destroy(error));
    request.pipe(forward);
  });
  const originPort = await listen(origin);
  const proxyPort = await listen(proxy);
  const proxySettings = { server: `http://127.0.0.1:${proxyPort}`, username: 'disposable-proxy', password: 'proxy-password' };
  for (const isolated of [true, false]) {
    for (const proxySource of ['launch', 'context']) {
      for (const originCredentials of [false, true]) {
        const config = await resolveConfig({ browser: {
          isolated,
          ...(!isolated && { userDataDir: await fs.mkdtemp(path.join(directory, 'profile-')) }),
          launchOptions: { channel: 'chromium-headless-shell', headless: true, chromiumSandbox: false, timeout: 30_000,
            ...(proxySource === 'launch' && { proxy: proxySettings }) },
          contextOptions: {
            ...(proxySource === 'context' && { proxy: proxySettings }),
            ...(originCredentials && { httpCredentials: { username: 'disposable-origin', password: 'origin-password' } }),
          },
        } });
        proxyChallenges = 0;
        proxyAuthenticated = 0;
        originRequests = [];
        const result = await contextFactory(config).createContext({}, new AbortController().signal, undefined);
        try {
          const page = await result.browserContext.newPage();
          await page.goto(`http://127.0.0.1:${originPort}/prime`, { timeout: 10_000 });
          assert.equal(await page.textContent('body'), 'fixture');
          assert.ok(proxyChallenges > 0, 'The proxy must challenge before the origin 401');
          assert.ok(proxyAuthenticated > 0, 'The proxy credentials must be accepted and cached');
          try {
            await page.goto(`http://127.0.0.1:${originPort}/challenge`, { timeout: 10_000 });
          } catch (error) {
            if (originCredentials || !String(error).includes('net::ERR_INVALID_AUTH_CREDENTIALS'))
              throw error;
          }
          const challenged = originRequests.filter(request => request.path === '/challenge');
          assert.ok(challenged.length > 0, 'The origin must receive the challenged request');
          assert.ok(challenged.some(request => !request.authorization), 'The origin must issue a 401 before credentials are supplied');
          assert.ok(originRequests.every(request => request.authorization !== proxyAuthorization), 'Proxy credentials must never reach the origin');
          assert.ok(challenged.every(request => !request.authorization || request.authorization === originAuthorization), 'Only explicitly configured origin credentials may answer a 401');
          if (originCredentials) {
            assert.ok(challenged.some(request => request.authorization === originAuthorization));
            assert.equal(await page.textContent('body'), 'fixture');
          }
          results.push({ isolated, proxySource, originCredentials, proxyChallenges, proxyAuthenticated, originChallenges: challenged.length });
        } finally {
          await result.close();
        }
      }
    }
  }
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
} finally {
  for (const socket of sockets)
    socket.destroy();
  try {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
