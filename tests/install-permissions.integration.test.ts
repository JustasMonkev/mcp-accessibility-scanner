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

import childProcess, { type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { expect, it, vi } from 'vitest';
import playwrightPackage from 'playwright/package.json';
import playwrightCorePackage from 'playwright-core/package.json';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { contextFactory } from '../src/browserContextFactory.js';
import { resolveConfig } from '../src/config.js';
import { Context } from '../src/context.js';
import { wrapInProcess } from '../src/mcp/server.js';

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('returns a prompt read-only browser-cache error through MCP and remains responsive', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-install-permissions-'));
  const cache = path.join(directory, 'cache');
  const children: ChildProcess[] = [];
  const originalFork = childProcess.fork;
  const fork = vi.spyOn(childProcess, 'fork').mockImplementation((...args: Parameters<typeof originalFork>) => {
    const child = originalFork(...args);
    children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  const client = new Client({ name: 'install-permissions-test', version: '1' });
  const config = await resolveConfig({
    capabilities: ['install'],
    browser: { browserName: 'chromium', isolated: true },
    outputDir: path.join(directory, 'output'),
  });
  const backend = new BrowserServerBackend(config, contextFactory(config));
  try {
    await fs.mkdir(cache, { mode: 0o555 });
    await expect(fs.writeFile(path.join(cache, 'must-not-write'), 'probe')).rejects.toMatchObject({ code: 'EACCES' });
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', cache);
    await client.connect(await wrapInProcess(backend));
    const started = performance.now();
    const result = await client.callTool({ name: 'browser_install', arguments: {} }, { timeout: 8000 });
    const elapsedMs = performance.now() - started;
    const text = JSON.stringify(result.content);
    process.stdout.write(JSON.stringify({ scenario: 'read-only-browser-cache', platform: process.platform, machine: os.machine(), node: process.version,
      playwright: playwrightPackage.version, playwrightCore: playwrightCorePackage.version, elapsedMs, isError: result.isError }) + '\n');
    expect(result.isError).toBe(true);
    expect(text).toMatch(/EACCES|EROFS/);
    expect(text).toContain('Failed to install browser');
    expect(elapsedMs).toBeLessThan(5000);
    expect(children).toHaveLength(1);
    expect(children[0].exitCode).not.toBeNull();
    expect(children[0].exitCode).not.toBe(0);
    expect(await fs.readdir(cache)).toEqual([]);
    const tools = await client.listTools({}, { timeout: 2000 });
    expect(tools.tools.some(tool => tool.name === 'browser_install')).toBe(true);
    const followup = await client.callTool({ name: 'browser_default_timeout', arguments: { timeout: 30000 } }, { timeout: 2000 });
    expect(followup.isError, JSON.stringify(followup.content)).not.toBe(true);
    expect(JSON.stringify(followup.content)).toContain('Default timeout set to 30000ms');
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill('SIGKILL');
        await closed;
      }
    }
    await client.close();
    backend.serverClosed();
    await Context.disposeAll();
    fork.mockRestore();
    syncBuiltinESMExports();
    vi.unstubAllEnvs();
    await fs.chmod(cache, 0o755);
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 15000);
