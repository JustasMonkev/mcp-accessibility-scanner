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

import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { resolveConfig } from '../src/config.js';

const fixtureOrigin = 'http://fixture.local';

const homeHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Home</title>
    <style>
      .sr-only {
        position: absolute;
        left: -9999px;
      }
      .sr-only:focus {
        left: 12px;
        top: 12px;
        background: #fff;
        padding: 6px;
      }
      button:focus {
        outline: 2px solid #005fcc;
      }
    </style>
  </head>
  <body>
    <a class="sr-only" href="#main">Skip to main content</a>
    <a href="/about">About</a>
    <a href="https://example.org/outside">External</a>
    <main id="main">
      <input aria-label="Search" />
      <button type="button">Open menu</button>
    </main>
  </body>
</html>`;

const aboutHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>About</title>
  </head>
  <body>
    <a href="/">Home</a>
    <main><h1>About page</h1></main>
  </body>
</html>`;

async function installFixtureRoutes(browserContext: BrowserContext): Promise<void> {
  await browserContext.route(`${fixtureOrigin}/**`, async route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname === '/') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: homeHtml,
      });
      return;
    }
    if (requestUrl.pathname === '/about') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: aboutHtml,
      });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: 'text/plain; charset=utf-8',
      body: 'Not Found',
    });
  });
}

function extractReportPath(text: string): string {
  const match = text.match(/JSON report:\s*(.+)\s*$/m);
  if (!match?.[1])
    throw new Error(`Could not find report path in tool output:\n${text}`);
  return match[1].trim();
}

const hasBundledChromium = fs.existsSync(chromium.executablePath());

describe.skipIf(!hasBundledChromium)('E2E smoke: accessibility tools', () => {
  const launchResources: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (launchResources.length) {
      const close = launchResources.pop();
      if (close)
        await close();
    }
  });

  it('runs tool flow end-to-end against a real browser and local pages', async () => {
    const outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-a11y-e2e-'));
    launchResources.push(async () => {
      await fs.promises.rm(outputDir, { recursive: true, force: true });
    });

    const config = await resolveConfig({
      outputDir,
      browser: {
        browserName: 'chromium',
        isolated: true,
        launchOptions: {
          headless: true,
          chromiumSandbox: false,
        },
        contextOptions: {
          viewport: { width: 1280, height: 800 },
        },
      },
      timeouts: {
        navigationTimeout: 15000,
        defaultTimeout: 10000,
      },
    });

    let browser: Browser | undefined;
    let browserContext: BrowserContext | undefined;

    const backend = new BrowserServerBackend(config, {
      createContext: async () => {
        browser = await chromium.launch({
          headless: true,
          chromiumSandbox: false,
        });
        browserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        await installFixtureRoutes(browserContext);
        return {
          browserContext,
          close: async () => {
            await browserContext?.close();
            await browser?.close();
          },
        };
      },
    });

    launchResources.push(async () => {
      backend.serverClosed();
      await browserContext?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    });

    await backend.initialize(
      {} as any,
      { name: 'vitest', version: 'e2e-smoke' },
      [{ uri: pathToFileURL(outputDir).toString(), name: 'workspace' } as any]
    );

    const tools = await backend.listTools();
    const toolNames = tools.map(tool => tool.name);
    expect(toolNames).toContain('audit_keyboard');
    expect(toolNames).toContain('audit_site');
    expect(toolNames).toContain('scan_page_matrix');

    const navigateResult = await backend.callTool('browser_navigate', { url: `${fixtureOrigin}/` });
    expect(navigateResult.isError).not.toBe(true);

    const keyboardResult1 = await backend.callTool('audit_keyboard', {
      maxTabs: 12,
      checkSkipLink: true,
      skipLinkMaxTabs: 3,
      activateSkipLink: true,
      checkFocusTrap: true,
      checkFocusVisibility: true,
      checkFocusJumps: true,
      jumpScrollThresholdPx: 600,
      screenshotOnIssue: false,
      maxIssueScreenshots: 2,
      includeShiftTab: false,
      stopOnCycle: true,
      cycleWindow: 8,
    });
    expect(keyboardResult1.isError).not.toBe(true);
    const keyboardText1 = (keyboardResult1.content[0] as any).text as string;
    expect(keyboardText1).toContain('Skip link: found');
    const keyboardReportPath1 = extractReportPath(keyboardText1);
    expect(fs.existsSync(keyboardReportPath1)).toBe(true);

    const matrixResult = await backend.callTool('scan_page_matrix', {
      variants: [
        { name: 'baseline' },
        { name: 'mobile', viewport: { width: 390, height: 844 } },
      ],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 5,
      waitAfterApplyMs: 50,
      reloadBetweenVariants: true,
    });
    expect(matrixResult.isError).not.toBe(true);
    const matrixText = (matrixResult.content[0] as any).text as string;
    const matrixReportPath = extractReportPath(matrixText);
    const matrixReport = JSON.parse(await fs.promises.readFile(matrixReportPath, 'utf-8'));
    expect(matrixReport.variants).toHaveLength(2);
    expect(matrixReport.variants[0].name).toBe('baseline');

    const siteResult = await backend.callTool('audit_site', {
      startUrl: `${fixtureOrigin}/`,
      strategy: 'links',
      maxPages: 5,
      maxDepth: 1,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: ['logout|signout'],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 5,
      waitAfterNavigationMs: 50,
    });
    expect(siteResult.isError).not.toBe(true);
    const siteText = (siteResult.content[0] as any).text as string;
    const siteReportPath = extractReportPath(siteText);
    const siteReport = JSON.parse(await fs.promises.readFile(siteReportPath, 'utf-8'));
    expect(siteReport.summary.totals.scannedPages).toBeGreaterThanOrEqual(2);
    expect(siteReport.pages.some((page: any) => page.url.endsWith('/about'))).toBe(true);

    const keyboardResult2 = await backend.callTool('audit_keyboard', {
      maxTabs: 8,
      checkSkipLink: true,
      skipLinkMaxTabs: 3,
      activateSkipLink: false,
      checkFocusTrap: true,
      checkFocusVisibility: true,
      checkFocusJumps: true,
      jumpScrollThresholdPx: 600,
      screenshotOnIssue: false,
      maxIssueScreenshots: 2,
      includeShiftTab: false,
      stopOnCycle: true,
      cycleWindow: 8,
    });
    expect(keyboardResult2.isError).not.toBe(true);
    const keyboardText2 = (keyboardResult2.content[0] as any).text as string;
    const keyboardReportPath2 = extractReportPath(keyboardText2);
    expect(fs.existsSync(keyboardReportPath2)).toBe(true);
  }, 120000);
});
