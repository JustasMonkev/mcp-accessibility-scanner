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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { resolveConfig } from '../src/config.js';

describe('navigation interrupted by a load-time dialog', () => {
  let browser: Browser;
  let browserContext: BrowserContext;
  let backend: BrowserServerBackend;
  let config: Awaited<ReturnType<typeof resolveConfig>>;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, chromiumSandbox: false });
  });

  beforeEach(async () => {
    config = await resolveConfig({
      browser: { browserName: 'chromium', isolated: true },
      timeouts: { navigationTimeout: 15000, defaultTimeout: 5000, settle: 0 },
    });
    backend = new BrowserServerBackend(config, {
      createContext: async () => {
        browserContext = await browser.newContext();
        await browserContext.route('http://fixture.local/**', route => {
          const type = new URL(route.request().url()).pathname.slice(1);
          const script = ['alert', 'confirm', 'prompt'].includes(type)
            ? `<script>window.dialogResult = ${type}('During load');</script>`
            : '';
          return route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><html lang="en"><head><title>Load dialog</title></head><body>${script}<button>Loaded</button></body></html>`,
          });
        });
        return { browserContext, close: () => browserContext.close() };
      },
    });
    await backend.initialize({ notifyToolListChanged: vi.fn().mockResolvedValue(undefined) }, { name: 'vitest', version: 'load-dialog' });
  });

  afterEach(async () => {
    backend?.serverClosed();
    await browserContext?.close();
  });

  afterAll(async () => {
    await browser?.close();
  });

  it.each([
    { type: 'alert', accept: true, promptText: undefined, value: undefined },
    { type: 'confirm', accept: false, promptText: undefined, value: false },
    { type: 'prompt', accept: true, promptText: 'Provided', value: 'Provided' },
  ])('returns the $type before timeout and allows handling it', async ({ type, accept, promptText, value }) => {
    const navigation = backend.callTool('browser_navigate', { url: `http://fixture.local/${type}` });
    let navigationReturned = false;
    void navigation.then(() => { navigationReturned = true; });
    // Well below the navigation timeout: the unfixed implementation leaves
    // this tool waiting until its 15-second goto timeout expires.
    await vi.waitFor(() => expect(navigationReturned).toBe(true), { timeout: 5000 });
    const navigationResult = await navigation;
    expect(navigationResult.isError).not.toBe(true);
    expect(navigationResult.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(`"${type}" dialog with message "During load"`) });
    expect(navigationResult.content[0]).toMatchObject({ type: 'text', text: expect.not.stringContaining('await page.goto(') });

    const blocked = await backend.callTool('browser_navigate', { url: 'http://fixture.local/after' });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('browser_handle_dialog') });
    expect(browserContext.pages()[0].url()).toBe(`http://fixture.local/${type}`);

    const handled = await backend.callTool('browser_handle_dialog', { accept, promptText });
    expect(handled.isError).not.toBe(true);
    expect(handled.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('button "Loaded"') });
    expect(await browserContext.pages()[0].evaluate('window.dialogResult')).toBe(value);

    const next = await backend.callTool('browser_navigate', { url: 'http://fixture.local/after' });
    expect(next.isError).not.toBe(true);
    expect(next.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('button "Loaded"') });
    expect(next.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('await page.goto(') });
  });

  it('reports a crawl navigation timeout without evaluating a dialog-blocked document', async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), 'mcp-crawl-dialog-'));
    config.outputDir = outputDir;
    config.timeouts.navigationTimeout = 500;
    await backend.callTool('browser_navigate', { url: 'http://fixture.local/after' });
    const audit = backend.callTool('audit_site', {
      startUrl: 'http://fixture.local/alert',
      strategy: 'provided',
      urls: ['http://fixture.local/alert'],
      maxPages: 1,
      waitAfterNavigationMs: 0,
    });
    let auditReturned = false;
    void audit.then(() => { auditReturned = true; });
    try {
      await vi.waitFor(() => expect(auditReturned).toBe(true), { timeout: 5000 });
      const result = await audit;
      expect(result.structuredContent).toMatchObject({ totals: { scannedPages: 0, erroredPages: 1 } });
      const files = await readdir(outputDir);
      expect(files).toHaveLength(1);
      const report = JSON.parse(await readFile(path.join(outputDir, files[0]), 'utf8'));
      expect(report.pages[0]).toMatchObject({ status: 'error', error: expect.stringContaining('Timeout 500ms exceeded') });
    } finally {
      await browserContext.close();
      await audit;
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
