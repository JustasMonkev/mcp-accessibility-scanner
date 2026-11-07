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
import { fileURLToPath } from 'node:url';

export async function runClientCertificateProxyProbe({ contextFactory, resolveConfig, browserName = 'chromium' }) {
  if (!['chromium', 'firefox'].includes(browserName))
    throw new Error('This loopback certificate fixture supports Chromium and Firefox only.');
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
      const forward = http.request({ hostname: '127.0.0.1', port: url.port, path: url.pathname,
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
      const upstream = net.connect(Number(target.port), '127.0.0.1', () => {
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
    const clientCertificates = ['127.0.0.1', 'certificate-proxy.test'].map(host => ({ origin: `https://${host}:${tlsPort}`,
      certPath: path.join(directory, 'client.crt'), keyPath: path.join(directory, 'client.key') }));
    for (const isolated of [true, false]) {
      for (const certificates of [false, true]) {
        for (const route of ['proxy', 'bypass', 'direct', 'override']) {
          const bypass = route === 'bypass';
          const useProxy = route !== 'direct';
          const options = { browser: {
            browserName, isolated,
            ...(!isolated && { userDataDir: await fs.mkdtemp(path.join(directory, 'profile-')) }),
            launchOptions: { ...(browserName === 'chromium' && { channel: 'chromium-headless-shell' }), headless: true, chromiumSandbox: false, timeout: 30_000,
              ...(useProxy && { proxy: { server: route === 'override' ? 'http://127.0.0.1:1' : `http://127.0.0.1:${proxyPort}`, ...(bypass && { bypass: '127.0.0.1' }) } }) },
            contextOptions: { ignoreHTTPSErrors: true, ...(certificates && { clientCertificates }),
              ...(route === 'override' && { proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: '' } }) },
          } };
          const scenario = { browserName, isolated, certificates, route };
          if (browserName === 'firefox' && !isolated && certificates && useProxy) {
            await assert.rejects(async () => contextFactory(await resolveConfig(options)), /Persistent Firefox does not support clientCertificates together with a proxy/);
            results.push({ ...scenario, unsupportedCombinationRejectedBeforeLaunch: true });
            continue;
          }
          if (certificates && bypass) {
            const unsupported = structuredClone(options);
            unsupported.browser.launchOptions.proxy.bypass = '127.0.0.1,<local>';
            await assert.rejects(resolveConfig(unsupported), /clientCertificates supports only host and domain entries in proxy\.bypass/);
            results.push({ ...scenario, unsupportedBypassRejectedBeforeLaunch: true });
          }
          const config = await resolveConfig(options);
          const result = await contextFactory(config).createContext({}, new AbortController().signal, undefined);
          try {
            requests = [];
            const page = await result.browserContext.newPage();
            for (const [scheme, port] of [['http', originPort], ['https', tlsPort]]) {
              const host = useProxy && !bypass ? 'certificate-proxy.test' : '127.0.0.1';
              await page.goto(`${scheme}://${host}:${port}/probe`, { timeout: 10_000 });
              assert.equal(await page.textContent('body'), 'fixture');
            }
            const proxyRequests = requests.filter(request => request.kind.startsWith('proxy-'));
            assert.equal(proxyRequests.length > 0, useProxy && !bypass, JSON.stringify({ ...scenario, requests }));
            assert.ok(requests.some(request => request.kind === 'origin' && request.path === '/probe'));
            assert.ok(requests.some(request => request.kind === 'tls-origin' && request.path === '/probe'
              && request.client === (certificates ? 'disposable-client' : undefined)), JSON.stringify({ ...scenario, requests }));
            if (useProxy && !bypass) {
              assert.ok(proxyRequests.some(request => request.path.includes(`:${originPort}`)), 'HTTP must pass through the proxy');
              assert.ok(proxyRequests.some(request => request.path.includes(`:${tlsPort}`)), 'HTTPS must pass through the proxy');
            }
            results.push({ ...scenario, browserVersion: result.browserContext.browser()?.version(), proxyRequests: proxyRequests.length, clientCertificateVerified: certificates });
          } finally {
            await result.close();
          }
        }
      }
    }
    return results;
  } finally {
    for (const socket of sockets)
      socket.destroy();
    try {
      await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'])
    delete process.env[key];
  const { contextFactory } = await import('../lib/browserContextFactory.js');
  const { resolveConfig } = await import('../lib/config.js');
  const results = await runClientCertificateProxyProbe({ contextFactory, resolveConfig, browserName: process.env.MCP_TEST_BROWSER_NAME || 'chromium' });
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
}
