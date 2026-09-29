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
import { chromium, type Browser, type BrowserContext, type Route } from 'playwright';
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
        let heldRequest: Route | undefined;
        await browserContext.route('http://fixture.local/**', async route => {
          const type = new URL(route.request().url()).pathname.slice(1);
          // 'outgoing' keeps a request open and alerts once it is answered, which
          // happens only when 'delayed' is requested: its dialog opens while the
          // crawl is already navigating away, before 'delayed' commits.
          if (type === 'hold') {
            heldRequest = route;
            return;
          }
          if (type === 'delayed') {
            await heldRequest?.fulfill({ body: '' });
            heldRequest = undefined;
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          // 'late' opens its dialog once the document is parsed and interactive, so
          // the navigation itself succeeds and only the work after it is frozen.
          const script = type === 'late'
            ? '<script>addEventListener("load", () => alert("After load"));</script>'
            : type === 'outgoing'
              // Drops the session cookie just before its dialog, as a sign-out timer would.
              ? '<script>fetch("/hold").then(() => { document.cookie = "sid=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT"; alert("From the previous page"); });</script>'
              : type === 'outgoing-pushstate'
                // A same-document navigation first, which Playwright also reports as framenavigated.
                ? '<script>fetch("/hold").then(() => { history.pushState(null, "", location.pathname + "#moved"); alert("From the previous page"); });</script>'
                : ['alert', 'confirm', 'prompt'].includes(type)
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

  it('names the blocked handler when a dialog appears and browser_handle_dialog is blocked', async () => {
    const blockedConfig = await resolveConfig({
      browser: { browserName: 'chromium', isolated: true },
      timeouts: { navigationTimeout: 15000, defaultTimeout: 5000, settle: 0 },
      blockedTools: ['browser_handle_dialog'],
    });
    let blockedContext: BrowserContext | undefined;
    const blockedBackend = new BrowserServerBackend(blockedConfig, {
      createContext: async () => {
        blockedContext = await browser.newContext();
        await blockedContext.route('http://fixture.local/**', route => route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><html lang="en"><head><title>Load dialog</title></head><body><script>alert("During load");</script></body></html>',
        }));
        return { browserContext: blockedContext, close: () => blockedContext!.close() };
      },
    });
    await blockedBackend.initialize({ notifyToolListChanged: vi.fn().mockResolvedValue(undefined) }, { name: 'vitest', version: 'blocked-dialog' });
    try {
      const guidance = 'would be handled by the "browser_handle_dialog" tool, but this server blocks it (blockedTools)';
      const navigation = await blockedBackend.callTool('browser_navigate', { url: 'http://fixture.local/alert' });
      expect(navigation.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(guidance) });
      expect(navigation.content[0]).toMatchObject({ type: 'text', text: expect.not.stringContaining('undefined') });
      // Ordinary tools stay refused while the modal is open and repeat the same explanation.
      const refused = await blockedBackend.callTool('browser_navigate', { url: 'http://fixture.local/after' });
      expect(refused.isError).toBe(true);
      expect(refused.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(guidance) });
      await expect(blockedBackend.callTool('browser_handle_dialog', { accept: true })).rejects.toThrow(/not found/);
    } finally {
      blockedBackend.serverClosed();
      await blockedContext?.close();
    }
  });

  it('delivers a navigation timeout that lands while the dialog is open, without server stack frames', async () => {
    config.timeouts.navigationTimeout = 500;
    const navigation = await backend.callTool('browser_navigate', { url: 'http://fixture.local/alert' });
    expect(navigation.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('"alert" dialog with message "During load"') });
    // The goto timeout expires while nobody has answered the dialog.
    await new Promise(resolve => setTimeout(resolve, 900));

    const handled = await backend.callTool('browser_handle_dialog', { accept: true });
    expect(handled.isError).not.toBe(true);
    expect(handled.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Navigation failed after dialog interruption: page.goto: Timeout 500ms exceeded') });
    const messages = await backend.callTool('browser_console_messages', {});
    const text = (messages.content[0] as { text: string }).text;
    expect(text).toContain('Error: Navigation failed after dialog interruption: page.goto: Timeout 500ms exceeded');
    expect(text).not.toMatch(/\n\s+at /);
  });

  it('reports a dialog-blocked crawl page as soon as its dialog opens, without evaluating the document', async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), 'mcp-crawl-dialog-'));
    config.outputDir = outputDir;
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
      // Far below the 15-second navigation timeout the page would otherwise wait out.
      await vi.waitFor(() => expect(auditReturned).toBe(true), { timeout: 5000 });
      const result = await audit;
      expect(result.structuredContent).toMatchObject({ totals: { scannedPages: 0, erroredPages: 1 } });
      const files = await readdir(outputDir);
      expect(files).toHaveLength(1);
      const report = JSON.parse(await readFile(path.join(outputDir, files[0]), 'utf8'));
      expect(report.pages[0]).toMatchObject({
        status: 'error',
        error: expect.stringContaining('The page opened a dialog that the crawl does not answer, so it was not audited: "alert" dialog with message "During load"'),
      });
    } finally {
      await browserContext.close();
      await audit;
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('does not let a dialog a crawled page opens fail the pages after it', async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), 'mcp-crawl-dialog-'));
    config.outputDir = outputDir;
    // Short enough that an unfixed crawl finishes and fails on its results, not on the clock.
    config.timeouts.navigationTimeout = 1000;
    await backend.callTool('browser_navigate', { url: 'http://fixture.local/after' });
    const urls = ['alert', 'first', 'confirm', 'prompt', 'second'].map(name => `http://fixture.local/${name}`);
    const audit = backend.callTool('audit_site', {
      startUrl: urls[0], strategy: 'provided', urls, maxPages: 5, waitAfterNavigationMs: 0,
    });
    let auditReturned = false;
    void audit.then(() => { auditReturned = true; });
    try {
      // Without the fix every page after the first dialog waits out the navigation timeout and fails.
      await vi.waitFor(() => expect(auditReturned).toBe(true), { timeout: 15000 });
      const result = await audit;
      expect(result.structuredContent).toMatchObject({ totals: { scannedPages: 2, erroredPages: 3 } });
      const files = await readdir(outputDir);
      expect(files).toHaveLength(1);
      const report = JSON.parse(await readFile(path.join(outputDir, files[0]), 'utf8'));
      expect(report.pages.map((page: { url: string, status: string }) => [page.url, page.status])).toEqual([
        [urls[0], 'error'], [urls[1], 'scanned'], [urls[2], 'error'], [urls[3], 'error'], [urls[4], 'scanned'],
      ]);
      // Each page after a dialog ran in a fresh tab, without the old tab's sessionStorage, and the report says so.
      expect(report.crawlTabRestarts).toEqual([{ url: urls[1] }, { url: urls[3] }, { url: urls[4] }]);
      expect(result.structuredContent).toMatchObject({ crawlTabRestarts: report.crawlTabRestarts });
      expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(`the crawl continued in a fresh tab from ${urls[1]}`) });
      // Only the pages that opened a dialog carry a note about it, and it names their own dialog.
      expect(report.pages[0].error).toContain('"alert" dialog with message "During load"');
      expect(report.pages[2].error).toContain('"confirm" dialog with message "During load"');
      expect(report.pages[3].error).toContain('"prompt" dialog with message "During load"');
      expect(report.pages[1].error).toBeNull();
      expect(report.pages[4].error).toBeNull();
      // Every crawl tab, including the ones a dialog froze, is gone; the tab the tool was called from is untouched.
      expect(browserContext.pages()).toHaveLength(1);
      const snapshot = await backend.callTool('browser_snapshot', {});
      expect(snapshot.isError).not.toBe(true);
      expect(snapshot.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('http://fixture.local/after') });
    } finally {
      await browserContext.close();
      await audit;
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('does not hang the crawl on a dialog that opens after the navigation succeeded', async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), 'mcp-crawl-dialog-'));
    config.outputDir = outputDir;
    await backend.callTool('browser_navigate', { url: 'http://fixture.local/after' });
    const urls = ['first', 'late', 'second'].map(name => `http://fixture.local/${name}`);
    const audit = backend.callTool('audit_site', {
      startUrl: urls[0], strategy: 'provided', urls, maxPages: 3, waitAfterNavigationMs: 0,
    });
    let auditReturned = false;
    void audit.then(() => { auditReturned = true; });
    try {
      // Without the fix the page's evaluate never returns: the audit waits forever.
      await vi.waitFor(() => expect(auditReturned).toBe(true), { timeout: 8000 });
      const result = await audit;
      expect(result.structuredContent).toMatchObject({ totals: { scannedPages: 2, erroredPages: 1 } });
      const files = await readdir(outputDir);
      const report = JSON.parse(await readFile(path.join(outputDir, files[0]), 'utf8'));
      expect(report.pages.map((page: { url: string, status: string }) => [page.url, page.status])).toEqual([
        [urls[0], 'scanned'], [urls[1], 'error'], [urls[2], 'scanned'],
      ]);
      expect(report.pages[1].error).toContain('"alert" dialog with message "After load"');
      expect(browserContext.pages()).toHaveLength(1);
    } finally {
      // Settles a hung audit so a regression fails here instead of leaking the crawl.
      await browserContext.close();
      await audit;
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('does not take a same-document navigation by the previous page for the next page committing', async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), 'mcp-crawl-dialog-'));
    config.outputDir = outputDir;
    await backend.callTool('browser_navigate', { url: 'http://fixture.local/after' });
    const urls = ['outgoing-pushstate', 'delayed', 'second'].map(name => `http://fixture.local/${name}`);
    const audit = backend.callTool('audit_site', {
      startUrl: urls[0], strategy: 'provided', urls, maxPages: 3, waitAfterNavigationMs: 0,
    });
    let auditReturned = false;
    void audit.then(() => { auditReturned = true; });
    try {
      await vi.waitFor(() => expect(auditReturned).toBe(true), { timeout: 10000 });
      const result = await audit;
      // Without telling the two apart, the pushState counts as 'delayed' committing and it fails.
      expect(result.structuredContent).toMatchObject({ totals: { scannedPages: 3, erroredPages: 0 } });
      expect(browserContext.pages()).toHaveLength(1);
    } finally {
      await browserContext.close();
      await audit;
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('audits a page again when the previous page raised its dialog during the navigation to it', async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), 'mcp-crawl-dialog-'));
    config.outputDir = outputDir;
    await backend.callTool('browser_navigate', { url: 'http://fixture.local/after' });
    const urls = ['outgoing', 'delayed', 'second'].map(name => `http://fixture.local/${name}`);
    await browserContext.addCookies([{ name: 'sid', value: 'signed-in', url: 'http://fixture.local/' }]);
    const audit = backend.callTool('audit_site', {
      startUrl: urls[0], strategy: 'provided', urls, maxPages: 3, waitAfterNavigationMs: 0,
    });
    let auditReturned = false;
    void audit.then(() => { auditReturned = true; });
    try {
      await vi.waitFor(() => expect(auditReturned).toBe(true), { timeout: 10000 });
      const result = await audit;
      // Without the retry, 'delayed' is reported as failed for the previous page's dialog.
      expect(result.structuredContent).toMatchObject({ totals: { scannedPages: 3, erroredPages: 0 } });
      const files = await readdir(outputDir);
      const report = JSON.parse(await readFile(path.join(outputDir, files[0]), 'utf8'));
      expect(report.pages.map((page: { url: string, status: string }) => [page.url, page.status])).toEqual([
        [urls[0], 'scanned'], [urls[1], 'scanned'], [urls[2], 'scanned'],
      ]);
      // The cookie went while the outgoing page was still the one running.
      expect(report.sessionLosses).toEqual([{ url: urls[0], cookies: ['sid'] }]);
      expect(browserContext.pages()).toHaveLength(1);
    } finally {
      await browserContext.close();
      await audit;
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
