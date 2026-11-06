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

import childProcess, { ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/client';
import { expect, it, vi } from 'vitest';
import playwrightPackage from 'playwright/package.json' with { type: 'json' };
import playwrightCorePackage from 'playwright-core/package.json' with { type: 'json' };
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { contextFactory } from '../src/browserContextFactory.js';
import { resolveConfig } from '../src/config.js';
import { Context } from '../src/context.js';
import { wrapInProcess } from '../src/mcp/server.js';

const expectedNativeMachine = process.env.MCP_TEST_EXPECT_NATIVE_MACHINE;
const enabled = process.platform === 'win32' && !!expectedNativeMachine;

it.skipIf(!enabled).each(['chrome', 'chrome-beta'])(
    'checks real Windows native architecture before %s installer delegation (requires Windows and MCP_TEST_EXPECT_NATIVE_MACHINE)', async channel => {
      expect(expectedNativeMachine).toMatch(/^(ARM64|X64)$/);
      if (process.env.MCP_TEST_EXPECT_NODE_ARCH)
        expect(process.arch).toBe(process.env.MCP_TEST_EXPECT_NODE_ARCH);
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-native-architecture-'));
      const client = new Client({ name: 'windows-architecture-test', version: '1' });
      const config = await resolveConfig({
        capabilities: ['install'],
        browser: { browserName: 'chromium', isolated: true, launchOptions: { channel } },
        outputDir: path.join(directory, 'output'),
      });
      const backend = new BrowserServerBackend(config, contextFactory(config));
      const fork = vi.spyOn(childProcess, 'fork').mockImplementation(() => {
        const child = new ChildProcess();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        queueMicrotask(() => child.emit('close', 0));
        return child;
      });
      syncBuiltinESMExports();
      try {
        await client.connect(await wrapInProcess(backend));
        const started = performance.now();
        const result = await client.callTool({ name: 'browser_install', arguments: {} }, { timeout: 8000 });
        const text = JSON.stringify(result.content);
        const elapsedMs = performance.now() - started;
        process.stdout.write(JSON.stringify({ scenario: 'real-windows-native-architecture', channel,
          expectedNativeMachine, platform: process.platform, release: os.release(), machine: os.machine(),
          node: process.version, nodeArchitecture: process.arch, playwright: playwrightPackage.version,
          playwrightCore: playwrightCorePackage.version, elapsedMs, installerForks: fork.mock.calls.length,
          installerExecution: 'stubbed; no browser installation attempted', isError: result.isError }) + '\n');
        if (expectedNativeMachine === 'ARM64') {
          expect(result.isError, text).toBe(true);
          expect(text).toMatch(/Windows ARM64.*native Chrome.*executablePath/);
          expect(fork).not.toHaveBeenCalled();
        } else {
          expect(result.isError, text).not.toBe(true);
          expect(fork).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/[/\\]cli\.js$/), ['install', channel], { stdio: 'pipe' });
          expect(text).toContain(`Browser ${channel} installed successfully.`);
        }
        await client.ping({ timeout: 2000 });
        const followup = await client.callTool({ name: 'browser_default_timeout', arguments: { timeout: 30000 } }, { timeout: 2000 });
        expect(followup.isError, JSON.stringify(followup.content)).not.toBe(true);
        expect(JSON.stringify(followup.content)).toContain('Default timeout set to 30000ms');
      } finally {
        fork.mockRestore();
        syncBuiltinESMExports();
        try {
          await client.close();
        } finally {
          backend.serverClosed();
          try {
            await Context.disposeAll();
          } finally {
            await fs.rm(directory, { recursive: true, force: true });
          }
        }
      }
    }, 15000);
