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
import { afterEach, describe, expect, it } from 'vitest';
import { chromium, type BrowserContext } from 'playwright';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { BrowserSessionRegistry } from '../src/browserSessions.js';
import { contextFactory, type BrowserContextFactory } from '../src/browserContextFactory.js';
import { resolveConfig, type FullConfig } from '../src/config.js';

const resultText = (result: Awaited<ReturnType<BrowserServerBackend['callTool']>>) =>
  result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');

// Real recorder events: no mocked private methods or hand-dispatched sink events.
describe('recorder compatibility with pinned Playwright (#218)', () => {
  let ownedContext: BrowserContext | undefined;
  let directory: string | undefined;
  const backends: BrowserServerBackend[] = [];
  let registry: BrowserSessionRegistry | undefined;

  afterEach(async () => {
    await registry?.disposeAll();
    registry = undefined;
    for (const backend of backends.splice(0)) {
      await backend.callTool('browser_close', {});
      backend.serverClosed();
    }
    await ownedContext?.close();
    ownedContext = undefined;
    if (directory) {
      const logs = (await fs.readdir(directory)).filter(name => name.startsWith('session-'));
      await expect.poll(async () => {
        const entries = await Promise.all(logs.map(folder => fs.readFile(path.join(directory!, folder, 'session.md'), 'utf8')));
        return entries.every(log => log.includes('### Tool call: browser_close'));
      }).toBe(true);
      await fs.rm(directory, { recursive: true, force: true });
    }
    directory = undefined;
  });

  async function backend(config: FullConfig, factory: BrowserContextFactory, stateless = false) {
    const instance = new BrowserServerBackend(config, factory, registry, { ephemeralDefaultContext: stateless });
    backends.push(instance);
    await instance.initialize({ notifyToolListChanged: async () => {} }, { name: 'recorder-test', version: '1' });
    return instance;
  }

  async function call(instance: BrowserServerBackend, name: string, args = {}) {
    const result = await instance.callTool(name, args);
    expect(result.isError, resultText(result)).not.toBe(true);
    return result;
  }

  it('shares real CDP recording across clients, filters sibling tools, and survives stop/disconnect/restart', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-recorder-'));
    const profile = path.join(directory, 'profile');
    ownedContext = await chromium.launchPersistentContext(profile, { args: ['--remote-debugging-port=0'] });
    const page = ownedContext.pages()[0];
    await page.setContent('<button>User action</button><input aria-label="Name"><input aria-label="Other">');
    const port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    const config = await resolveConfig({
      browser: { cdpEndpoint: `http://127.0.0.1:${port}` },
      capabilities: ['devtools'], outputDir: directory, saveSession: true, timeouts: { settle: 50 },
    });
    const factory = contextFactory(config);
    const first = await backend(config, factory);
    const second = await backend(config, factory);
    await Promise.all([call(first, 'browser_start_recording'), call(second, 'browser_start_recording')]);
    const duplicate = await first.callTool('browser_start_recording', {});
    expect(duplicate.isError).toBe(true);
    expect(resultText(duplicate)).toContain('Recording is already in progress');

    await page.getByRole('button').click();
    const firstRecording = resultText(await call(first, 'browser_stop_recording'));
    expect(firstRecording).toContain("getByRole('button', { name: 'User action' }).click()");
    const snapshot = resultText(await call(first, 'browser_snapshot'));
    const ref = snapshot.match(/textbox "Name" \[ref=([^\]]+)\]/)?.[1];
    expect(ref).toBeDefined();
    await call(first, 'browser_type', { element: 'Name', ref, text: 'Sibling tool' });
    await call(first, 'browser_close');
    first.serverClosed();
    backends.splice(backends.indexOf(first), 1);
    expect(page.isClosed()).toBe(false);
    const folders = (await fs.readdir(directory)).filter(name => name.startsWith('session-'));
    expect(folders).toHaveLength(2);
    const logs = () => Promise.all(folders.map(folder => fs.readFile(path.join(directory!, folder, 'session.md'), 'utf8')));
    // Playwright resolves fill before delivering its recorder event. Wait for receipt
    // in the real session log before asking stop to reject further unbuffered input.
    await page.getByRole('textbox', { name: 'Other' }).fill('After disconnect');
    await expect.poll(async () => (await logs()).some(log => log.includes("fill('After disconnect')"))).toBe(true);
    const secondRecording = resultText(await call(second, 'browser_stop_recording'));
    expect(secondRecording).toContain("getByRole('button', { name: 'User action' }).click()");
    expect(secondRecording).toContain("fill('After disconnect')");
    // Inspect the code block only: the stop response's snapshot contains the current field value.
    expect(secondRecording.split('~~~js')[1]?.split('~~~')[0]).not.toContain('Sibling tool');

    await call(second, 'browser_start_recording');
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Restarted');
    await expect.poll(async () => (await logs()).some(log => log.includes("fill('Restarted')"))).toBe(true);
    const restarted = resultText(await call(second, 'browser_stop_recording'));
    const restartedCode = restarted.split('~~~js')[1]?.split('~~~')[0];
    expect(restartedCode).toContain("fill('Restarted')");
    expect(restartedCode).not.toContain('After disconnect');

    // --save-session still receives user actions alongside explicit recording.
    expect((await logs()).filter(log => log.includes('### User action: click'))).toHaveLength(2);
  });

  it('retains explicit recording across stateless backends and rejects ephemeral recording', async () => {
    const browser = await chromium.launch();
    try {
      registry = new BrowserSessionRegistry();
      const config = await resolveConfig({ capabilities: ['devtools'], timeouts: { settle: 50 } });
      const factory: BrowserContextFactory = {
        createContext: async () => {
          const context = await browser.newContext();
          ownedContext = context;
          return { browserContext: context, close: () => context.close() };
        },
      };
      const opener = await backend(config, factory, true);
      const rejected = await opener.callTool('browser_start_recording', {});
      expect(rejected.isError).toBe(true);
      expect(resultText(rejected)).toContain('requires a browserSessionId');
      expect(browser.contexts()).toHaveLength(0);
      const opened = await call(opener, 'browser_session_open');
      const content = opened.structuredContent;
      if (!content || typeof content !== 'object' || !('browserSessionId' in content) || typeof content.browserSessionId !== 'string')
        throw new Error('Expected a browser session handle');
      const browserSessionId = content.browserSessionId;
      const args = { browserSessionId };
      await call(opener, 'browser_snapshot', args);
      const page = ownedContext!.pages()[0];
      await page.setContent('<input aria-label="Saved session">');
      await call(opener, 'browser_start_recording', args);
      opener.serverClosed();
      const recordingContext = registry.resolve(browserSessionId);
      const beforeInput = recordingContext.recordingActivityAt()!;
      await page.getByRole('textbox').fill('Across requests');
      await expect.poll(() => recordingContext.recordingActivityAt()).toBeGreaterThan(beforeInput);
      const nextRequest = await backend(config, factory, true);
      const recorded = resultText(await call(nextRequest, 'browser_stop_recording', args));
      expect(recorded).toContain("fill('Across requests')");
      // With no session logger holding the hub open, stop puts the real
      // recorder in standby; a later request must re-arm it.
      await call(nextRequest, 'browser_start_recording', args);
      nextRequest.serverClosed();
      const beforeRestart = recordingContext.recordingActivityAt()!;
      await page.getByRole('textbox').fill('After standby');
      await expect.poll(() => recordingContext.recordingActivityAt()).toBeGreaterThan(beforeRestart);
      const lastRequest = await backend(config, factory, true);
      const restarted = resultText(await call(lastRequest, 'browser_stop_recording', args));
      expect(restarted).toContain("fill('After standby')");
      expect(restarted).not.toContain('Across requests');
      await call(lastRequest, 'browser_session_close', args);
      expect(page.isClosed()).toBe(true);
      expect(browser.contexts()).toHaveLength(0);
    } finally {
      await registry?.disposeAll();
      await browser.close();
    }
  });
});
