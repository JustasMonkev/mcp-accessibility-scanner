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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { contextFactory } from '../lib/browserContextFactory.js';
import { resolveConfig } from '../lib/config.js';

// Run after npm run build and playwright install chromium. Uses only local
// origins, a recording proxy, and disposable self-signed fixture certificates.
// Ambient proxy settings must not disguise a dropped configured route.
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'])
  delete process.env[key];
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-certificate-proxy-'));
const sockets = new Set();
const servers = [];
let requests = [];
const results = [];
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
  for (const name of ['server', 'client']) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', path.join(directory, `${name}.key`), '-out', path.join(directory, `${name}.crt`),
      '-subj', `/CN=disposable-${name}`, '-days', '1'], { stdio: 'ignore' });
  }
  const origin = http.createServer((request, response) => {
    requests.push({ kind: 'origin', path: request.url });
    response.end('fixture');
  });
  const secureOrigin = https.createServer({
    key: await fs.readFile(path.join(directory, 'server.key')),
    cert: await fs.readFile(path.join(directory, 'server.crt')),
    requestCert: true, rejectUnauthorized: false,
  }, (request, response) => {
    requests.push({ kind: 'tls-origin', path: request.url, client: request.socket.getPeerCertificate().subject?.CN });
    response.end('fixture');
  });
  const proxy = http.createServer((request, response) => {
    requests.push({ kind: 'proxy-http', path: request.url });
    const url = new URL(request.url);
    const forward = http.request({ hostname: url.hostname, port: url.port, path: url.pathname,
      method: request.method, headers: request.headers }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    });
    forward.on('error', error => response.destroy(error));
    request.pipe(forward);
  });
  proxy.on('connect', (request, socket, head) => {
    requests.push({ kind: 'proxy-connect', path: request.url });
    const target = new URL(`http://${request.url}`);
    const upstream = net.connect(Number(target.port), target.hostname, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length)
        upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  const originPort = await listen(origin);
  const tlsPort = await listen(secureOrigin);
  const proxyPort = await listen(proxy);
  const clientCertificates = [{ origin: `https://127.0.0.1:${tlsPort}`,
    certPath: path.join(directory, 'client.crt'), keyPath: path.join(directory, 'client.key') }];
  for (const isolated of [true, false]) {
    for (const certificates of [false, true]) {
      for (const bypass of [false, true]) {
        const options = { browser: {
          isolated,
          ...(!isolated && { userDataDir: await fs.mkdtemp(path.join(directory, 'profile-')) }),
          launchOptions: { channel: 'chromium-headless-shell', headless: true, chromiumSandbox: false, timeout: 30_000,
            proxy: { server: `http://127.0.0.1:${proxyPort}`, ...(bypass && { bypass: '127.0.0.1' }) } },
          contextOptions: { ignoreHTTPSErrors: true, ...(certificates && { clientCertificates }) },
        } };
        const scenario = { isolated, certificates, bypass };
        if (certificates && bypass) {
          await assert.rejects(resolveConfig(options), /clientCertificates with proxy.bypass is unsupported/);
          results.push({ ...scenario, rejectedBeforeLaunch: true });
          continue;
        }
        const config = await resolveConfig(options);
        const result = await contextFactory(config).createContext({}, new AbortController().signal, undefined);
        try {
          requests = [];
          const page = await result.browserContext.newPage();
          for (const [scheme, port] of [['http', originPort], ['https', tlsPort]]) {
            await page.goto(`${scheme}://127.0.0.1:${port}/probe`, { timeout: 10_000 });
            assert.equal(await page.textContent('body'), 'fixture');
          }
          const proxyRequests = requests.filter(request => request.kind.startsWith('proxy-'));
          assert.equal(proxyRequests.length > 0, !bypass, JSON.stringify({ ...scenario, requests }));
          assert.ok(requests.some(request => request.kind === 'origin' && request.path === '/probe'));
          assert.ok(requests.some(request => request.kind === 'tls-origin' && request.path === '/probe'
            && request.client === (certificates ? 'disposable-client' : undefined)));
          if (!bypass) {
            assert.ok(proxyRequests.some(request => request.path.includes(`:${originPort}`)), 'HTTP must pass through the proxy');
            assert.ok(proxyRequests.some(request => request.path.includes(`:${tlsPort}`)), 'HTTPS must pass through the proxy');
          }
          results.push({ ...scenario, proxyRequests: proxyRequests.length, clientCertificateVerified: certificates });
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
