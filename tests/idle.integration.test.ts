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
import { expect, it } from 'vitest';
import { chromium, type BrowserContext } from 'playwright';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { contextFactory } from '../src/browserContextFactory.js';
import { resolveConfig } from '../src/config.js';
import { Context } from '../src/context.js';

it.each(['allow', 'only'] as const)('reopens an idle owned context and reports recovery once with image responses %s', async imageResponses => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-idle-owned-'));
  const browser = await chromium.launch();
  const contexts: BrowserContext[] = [];
  const closed = Promise.withResolvers<void>();
  const config = await resolveConfig({ outputDir: directory, imageResponses, timeouts: { idle: 50, settle: 0 } });
  const backend = new BrowserServerBackend(config, {
    createContext: async () => {
      const browserContext = await browser.newContext();
      await browserContext.newPage();
      contexts.push(browserContext);
      browserContext.once('close', () => closed.resolve());
      return { browserContext, close: () => browserContext.close() };
    },
  });
  try {
    await backend.initialize({ notifyToolListChanged: async () => {} }, { name: 'idle-test', version: '1' });
    const initial = await backend.callTool('browser_navigate', { url: 'about:blank' });
    expect(initial.isError).not.toBe(true);
    await closed.promise;
    expect(contexts).toHaveLength(1);
    const resumed = await backend.callTool('browser_take_screenshot', {});
    expect(resumed.isError, JSON.stringify(resumed.content)).not.toBe(true);
    expect(contexts).toHaveLength(2);
    expect(resumed.content).toContainEqual(expect.objectContaining({ type: 'text', text: expect.stringContaining('Use browser_navigate') }));
    expect(resumed.content.some(item => item.type === 'image')).toBe(true);
    if (imageResponses === 'only')
      expect(resumed.content).not.toContainEqual(expect.objectContaining({ type: 'text', text: expect.stringContaining('Took the') }));
    const next = await backend.callTool('browser_snapshot', {});
    expect(next.content).not.toContainEqual(expect.objectContaining({ type: 'text', text: expect.stringContaining('released after inactivity') }));
    await new Promise<void>(resolve => contexts[1].once('close', () => resolve()));
    const opened = await backend.callTool('browser_session_open', {});
    expect(opened.isError).not.toBe(true);
    const sessionClosed = await backend.callTool('browser_session_close', { browserSessionId: opened.structuredContent?.browserSessionId });
    expect(sessionClosed.isError).not.toBe(true);
    const browserClosed = await backend.callTool('browser_close', {});
    expect(browserClosed.isError).not.toBe(true);
    expect(contexts).toHaveLength(2);
  } finally {
    await Context.disposeAll();
    await browser.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('disconnects an idle CDP client while preserving the external page and reconnects on demand', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-idle-cdp-'));
  const external = await chromium.launchPersistentContext(directory, { headless: true, args: ['--remote-debugging-port=0'] });
  const disconnected = Promise.withResolvers<void>();
  try {
    const page = external.pages()[0];
    await page.setContent('<title>External page</title><button>Still here</button>');
    const port = (await fs.readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    const config = await resolveConfig({ browser: { cdpEndpoint: `http://127.0.0.1:${port}` }, timeouts: { idle: 50, settle: 0 } });
    const factory = contextFactory(config);
    const backend = new BrowserServerBackend(config, {
      createContext: async (...args) => {
        const result = await factory.createContext(...args);
        result.browserContext.browser()!.once('disconnected', () => disconnected.resolve());
        return result;
      },
    });
    await backend.initialize({ notifyToolListChanged: async () => {} }, { name: 'idle-cdp-test', version: '1' });
    const initial = await backend.callTool('browser_snapshot', {});
    expect(initial.isError).not.toBe(true);
    await disconnected.promise;
    expect(page.isClosed()).toBe(false);
    expect(await page.title()).toBe('External page');
    const resumed = await backend.callTool('browser_snapshot', {});
    expect(resumed.isError).not.toBe(true);
    expect(resumed.content).toContainEqual(expect.objectContaining({ type: 'text', text: expect.stringContaining('Still here') }));
    expect(resumed.content).toContainEqual(expect.objectContaining({ type: 'text', text: expect.stringContaining('released after inactivity') }));
  } finally {
    await Context.disposeAll();
    await external.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
