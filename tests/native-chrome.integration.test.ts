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
import playwrightPackage from 'playwright/package.json' with { type: 'json' };
import playwrightCorePackage from 'playwright-core/package.json' with { type: 'json' };
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { contextFactory } from '../src/browserContextFactory.js';
import { resolveConfig } from '../src/config.js';
import { Context } from '../src/context.js';
import { wrapInProcess } from '../src/mcp/server.js';

const executablePath = process.env.MCP_TEST_NATIVE_CHROME_PATH;

it.skipIf(process.platform !== 'win32' || !executablePath)(
    'navigates and detects an Axe violation with provisioned native ARM64 Chrome through MCP (requires Windows and MCP_TEST_NATIVE_CHROME_PATH)', async () => {
      if (!executablePath)
        throw new Error('MCP_TEST_NATIVE_CHROME_PATH must name the provisioned ARM64 Chrome executable');
      const executable = await fs.readFile(executablePath);
      expect(executable.readUInt16LE(0)).toBe(0x5a4d);
      const peOffset = executable.readUInt32LE(0x3c);
      expect(executable.subarray(peOffset, peOffset + 4)).toEqual(Buffer.from('PE\0\0'));
      const machine = executable.readUInt16LE(peOffset + 4);
      expect(machine, 'Chrome PE machine must be ARM64, not emulated x64').toBe(0xaa64);
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-native-chrome-'));
      const server = http.createServer((request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html lang="en"><title>Native Chrome fixture</title><main><h1>Native ARM64 Chrome</h1><img id="missing-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></main></html>');
      });
      const client = new Client({ name: 'native-chrome-test', version: '1' });
      const config = await resolveConfig({
        browser: { browserName: 'chromium', isolated: true, launchOptions: { executablePath, headless: true } },
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
        const url = `http://127.0.0.1:${address.port}/native-chrome`;
        await client.connect(await wrapInProcess(backend));
        const navigation = await client.callTool({ name: 'browser_navigate', arguments: { url } }, { timeout: 15000 });
        expect(navigation.isError, JSON.stringify(navigation.content)).not.toBe(true);
        expect(JSON.stringify(navigation.content)).toContain('Native ARM64 Chrome');
        const scan = await client.callTool({ name: 'scan_page', arguments: { withRules: ['image-alt'] } }, { timeout: 15000 });
        const text = JSON.stringify(scan.content);
        expect(scan.isError, text).not.toBe(true);
        expect(text).toContain('Violations: 1');
        expect(text).toContain('Violation rule: image-alt');
        expect(text).toContain('missing-alt');
        expect(browserVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
        await client.ping({ timeout: 2000 });
        process.stdout.write(JSON.stringify({ scenario: 'native-chrome-mcp-navigation-and-axe', platform: process.platform,
          release: os.release(), machine: os.machine(), node: process.version, nodeArchitecture: process.arch,
          playwright: playwrightPackage.version, playwrightCore: playwrightCorePackage.version,
          executablePath, chromePEMachine: `0x${machine.toString(16)}`, browserVersion, axeRule: 'image-alt', violations: 1 }) + '\n');
      } finally {
        try {
          await client.close();
        } finally {
          backend.serverClosed();
          try {
            await Context.disposeAll();
          } finally {
            if (server.listening) {
              server.closeAllConnections();
              await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            }
            await fs.rm(directory, { recursive: true, force: true });
          }
        }
      }
    }, 45000);
