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
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';
import playwrightPackage from 'playwright/package.json';
import playwrightCorePackage from 'playwright-core/package.json';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { contextFactory } from '../src/browserContextFactory.js';
import { resolveConfig } from '../src/config.js';
import { Context } from '../src/context.js';
import { wrapInProcess } from '../src/mcp/server.js';

const channel = process.env.MCP_TEST_BROWSER_CHANNEL || 'chromium';
const enabled = process.platform === 'win32' || process.env.MCP_TEST_WINDOWS_NETWORK === '1';

it.skipIf(!enabled).each([true, false])('completes bounded Chromium TCP churn through MCP (isolated=%s)', async isolated => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-windows-network-'));
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    response.setHeader('Connection', 'close');
    response.setHeader('Cache-Control', 'no-store');
    const url = new URL(request.url!, 'http://fixture.local');
    if (url.pathname.startsWith('/data/')) {
      requests.push(url.pathname);
      response.end(`received:${url.pathname}`);
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<title>Navigation ${url.pathname}</title><h1>Network fixture ${url.pathname}</h1>`);
    }
  });
  const client = new Client({ name: 'windows-network-test', version: '1' });
  const config = await resolveConfig({
    browser: { browserName: 'chromium', isolated, userDataDir: isolated ? undefined : path.join(directory, 'profile'),
      launchOptions: { channel, headless: true } },
    outputDir: path.join(directory, 'output'),
    timeouts: { navigationTimeout: 10000, defaultTimeout: 10000, settle: 0 },
  });
  const factory = contextFactory(config);
  const createContext = factory.createContext.bind(factory);
  let browserVersion: string | undefined;
  factory.createContext = async (...args) => {
    const handle = await createContext(...args);
    browserVersion = handle.browserContext.browser()?.version();
    return handle;
  };
  const backend = new BrowserServerBackend(config, factory);
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Fixture did not receive a TCP port');
    const origin = `http://127.0.0.1:${address.port}`;
    await client.connect(await wrapInProcess(backend));
    for (let iteration = 0; iteration < 12; iteration++) {
      const navigation = await client.callTool({ name: 'browser_navigate', arguments: { url: `${origin}/page/${iteration}` } }, { timeout: 15000 });
      expect(navigation.isError, JSON.stringify(navigation.content)).not.toBe(true);
      expect(JSON.stringify(navigation.content)).toContain(`Network fixture /page/${iteration}`);
      const resources = await client.callTool({ name: 'browser_evaluate', arguments: {
        function: `async () => Promise.all(Array.from({ length: 4 }, async (_, resource) => {
          const response = await fetch('/data/${iteration}/' + resource);
          if (!response.ok) throw new Error('Unexpected status ' + response.status);
          return response.text();
        }))`,
      } }, { timeout: 15000 });
      expect(resources.isError, JSON.stringify(resources.content)).not.toBe(true);
      for (let resource = 0; resource < 4; resource++)
        expect(JSON.stringify(resources.content)).toContain(`received:/data/${iteration}/${resource}`);
    }
    expect(browserVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(requests.sort()).toEqual(Array.from({ length: 12 }, (_, iteration) =>
      Array.from({ length: 4 }, (_, resource) => `/data/${iteration}/${resource}`)).flat().sort());
    const followup = await client.callTool({ name: 'browser_snapshot', arguments: {} }, { timeout: 5000 });
    expect(followup.isError, JSON.stringify(followup.content)).not.toBe(true);
    expect(JSON.stringify(followup.content)).toContain('Network fixture /page/11');
    process.stdout.write(JSON.stringify({ scenario: 'bounded-network-churn', platform: process.platform, release: os.release(), machine: os.machine(),
      node: process.version, playwright: playwrightPackage.version, playwrightCore: playwrightCorePackage.version,
      channel, isolated, browserVersion, navigations: 12, resourceResponses: requests.length }) + '\n');
  } finally {
    await client.close();
    backend.serverClosed();
    await Context.disposeAll();
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 60000);
