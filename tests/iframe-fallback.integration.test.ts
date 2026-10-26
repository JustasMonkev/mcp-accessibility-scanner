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

import { existsSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as playwright from 'playwright';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { resolveConfig } from '../src/config.js';

const requestedBrowser = process.env.MCP_TEST_BROWSER_NAME;
const browserName = requestedBrowser || 'chromium';
if (browserName !== 'chromium' && browserName !== 'firefox' && browserName !== 'webkit')
  throw new Error(`Unsupported MCP_TEST_BROWSER_NAME: ${browserName}`);
// Explicit engine requests must fail rather than silently skip a missing browser.
const canRun = !!requestedBrowser || existsSync(playwright.chromium.executablePath());
const require = createRequire(import.meta.url);
const versions = {
  playwright: require('playwright/package.json').version,
  playwrightCore: require('playwright-core/package.json').version,
};
// Only the measured paired pin may retain #298. A dependency upgrade must
// preserve the child tree instead of inheriting this known failure.
const knownFallbackLoss = versions.playwright === '1.63.0' && versions.playwrightCore === '1.63.0';
const fallback = 'Your browser does not support frames';
const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<!doctype html><meta charset="utf-8">' + (request.url === '/child'
    ? `<button onclick="this.dataset.clicked=String(Number(this.dataset.clicked || 0)+1)">Frame action</button><input aria-label="Frame input">`
    : `<title>Iframe fallback</title><iframe src="/child">${request.url === '/fallback' ? fallback : ''}</iframe>`));
});

function expectControls(snapshot: string, present: boolean) {
  for (const control of ['button "Frame action"', 'textbox "Frame input"']) {
    if (present)
      expect(snapshot).toMatch(new RegExp(`${control}[^\\n]*\\[ref=`));
    else
      expect(snapshot).not.toContain(control);
  }
}

function text(result: Awaited<ReturnType<BrowserServerBackend['callTool']>>) {
  return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}

function ok(result: Awaited<ReturnType<BrowserServerBackend['callTool']>>) {
  expect(result.isError, text(result)).not.toBe(true);
  return text(result);
}

function buttonRef(snapshot: string) {
  const ref = snapshot.match(/button "Frame action"[^\n]*?\[ref=([^\]]+)\]/)?.[1];
  expect(ref, snapshot).toBeDefined();
  return ref!;
}

describe.skipIf(!canRun)(`iframe fallback snapshots (${browserName}) #298`, () => {
  let origin: string;
  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP fixture server');
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it.each([false, true])('checks child controls, find and cached/refreshed refs with boxes=%s', async boxes => {
    const browser = await playwright[browserName].launch();
    let backend: BrowserServerBackend | undefined;
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.setDefaultTimeout(3000);
      backend = new BrowserServerBackend(await resolveConfig({
        snapshot: { boxes },
        timeouts: { navigationTimeout: 3000, defaultTimeout: 3000, settle: 50 },
      }), { createContext: async () => ({ browserContext: context, close: () => context.close() }) });
      await backend.initialize({ notifyToolListChanged: async () => {} }, { name: 'iframe-fallback', version: '1' });
      await page.goto(origin);
      const child = page.frameLocator('iframe');
      const button = child.getByRole('button');
      await button.waitFor();
      const before = await page.ariaSnapshot({ mode: 'ai', boxes });
      expectControls(before, true);
      expectControls(ok(await backend.callTool('browser_snapshot', { boxes })), true);
      const ref = buttonRef(before);
      expect(ok(await backend.callTool('browser_find', { text: 'Frame action' }))).toContain(`[ref=${ref}]`);

      // Change only fallback text on the same iframe: document, controls and
      // refs remain identical, so exact snapshot equality is meaningful.
      await page.locator('iframe').evaluate((element, value) => { element.textContent = value; }, fallback);
      const after = await page.ariaSnapshot({ mode: 'ai', boxes });
      expectControls(after, !knownFallbackLoss);
      if (knownFallbackLoss) {
        expect(after).toContain(fallback);
        expect(after).not.toBe(before);
      } else {
        expect(after).toBe(before);
      }

      // A pre-fallback cached ref still revalidates against the child itself.
      // The action response then refreshes the cached full-page snapshot.
      const cachedClick = ok(await backend.callTool('browser_click', { ref, element: 'Frame action' }));
      expect(await button.getAttribute('data-clicked')).toBe('1');
      expectControls(cachedClick, !knownFallbackLoss);
      expectControls(ok(await backend.callTool('browser_snapshot', { boxes })), !knownFallbackLoss);
      const find = ok(await backend.callTool('browser_find', { text: 'Frame action' }));
      expect(find).toContain(knownFallbackLoss ? 'No matches found for "Frame action".' : `[ref=${ref}]`);
      // Playwright still resolves the ref: rejection is the scanner's check
      // against the rendered snapshot, not removal of the DOM control.
      expect(await page.locator(`aria-ref=${ref}`).count()).toBe(1);
      const refreshedClick = await backend.callTool('browser_click', { ref, element: 'Frame action' });
      if (knownFallbackLoss) {
        expect(refreshedClick.isError, text(refreshedClick)).toBe(true);
        expect(text(refreshedClick)).toContain(`Ref ${ref} not found in the current page snapshot`);
        expect(await button.getAttribute('data-clicked')).toBe('1');
      } else {
        ok(refreshedClick);
        expect(await button.getAttribute('data-clicked')).toBe('2');
      }

      // Removal is a fixture control, not a proposed page-mutation workaround.
      await page.locator('iframe').evaluate(element => { element.textContent = ''; });
      const recovered = ok(await backend.callTool('browser_snapshot', { boxes }));
      expectControls(recovered, true);
      expect(buttonRef(recovered)).toBe(ref);
      ok(await backend.callTool('browser_click', { ref, element: 'Frame action' }));
      expect(await button.getAttribute('data-clicked')).toBe(knownFallbackLoss ? '2' : '3');

      // Also cover fallback present from first load, without a good cached ref.
      const initial = ok(await backend.callTool('browser_navigate', { url: `${origin}/fallback` }));
      await button.waitFor();
      expectControls(initial, !knownFallbackLoss);
      const initialFind = ok(await backend.callTool('browser_find', { text: 'Frame input' }));
      expect(initialFind).toContain(knownFallbackLoss ? 'No matches found for "Frame input".' : 'textbox "Frame input" [ref=');
      if (!knownFallbackLoss) {
        ok(await backend.callTool('browser_click', { ref: buttonRef(initial), element: 'Frame action' }));
        expect(await button.getAttribute('data-clicked')).toBe('1');
      }
      process.stdout.write(JSON.stringify({ ...versions, browserName, browserVersion: browser.version(), boxes, knownFallbackLoss, before, after }) + '\n');
    } finally {
      backend?.serverClosed();
      await browser.close();
    }
  });
});
