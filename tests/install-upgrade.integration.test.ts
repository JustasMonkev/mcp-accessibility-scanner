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

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { resolveConfig } from '../src/config.js';

const require = createRequire(import.meta.url);

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('promptly reports an unwritable browser cache through browser_install and keeps MCP responsive (#295)', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-install-cache-'));
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const backend = new BrowserServerBackend(await resolveConfig({
    browser: { browserName: 'chromium' }, allowedTools: ['browser_install'],
  }), { createContext: async () => { throw new Error('This permission failure must precede browser launch'); } });
  try {
    await fs.chmod(directory, 0o555);
    process.env.PLAYWRIGHT_BROWSERS_PATH = directory;
    await backend.initialize({ notifyToolListChanged: async () => {} }, { name: 'install-upgrade', version: '1' });
    const started = Date.now();
    const result = await backend.callTool('browser_install', {});
    const elapsed = Date.now() - started;
    const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    process.stdout.write(JSON.stringify({ case: 'unwritable-browser-cache', platform: process.platform, node: process.version,
      uid: process.getuid?.(), playwright: require('playwright/package.json').version,
      playwrightCore: require('playwright-core/package.json').version, elapsed, text }) + '\n');
    expect(result.isError, text).toBe(true);
    expect(text).toMatch(/EACCES|EROFS/);
    expect(text).toContain('Set PLAYWRIGHT_BROWSERS_PATH to a writable directory.');
    expect(elapsed).toBeLessThan(10000);
    const followup = await backend.callTool('browser_close', {});
    expect(followup.isError, JSON.stringify(followup.content)).not.toBe(true);
    expect((await backend.listTools()).some(tool => tool.name === 'browser_install')).toBe(true);
  } finally {
    backend.serverClosed();
    if (previous === undefined)
      delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else
      process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
    await fs.chmod(directory, 0o755);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
