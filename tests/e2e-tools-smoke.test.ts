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
      <div id="dropzone" role="region" aria-label="Drop target">Drop target</div>
    </main>
    <script>
      const dropzone = document.querySelector('#dropzone');
      dropzone.addEventListener('dragover', event => event.preventDefault());
      dropzone.addEventListener('drop', async event => {
        event.preventDefault();
        const file = event.dataTransfer.files[0];
        dropzone.dataset.dropped = file ? await file.text() : event.dataTransfer.getData('text/plain');
      });
    </script>
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
    if (requestUrl.pathname === '/api/data') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        headers: { 'x-fixture-response': 'network-detail' },
        body: JSON.stringify({ name: 'Ada' }),
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

function extractResourceLinks(result: { content: Array<{ type: string, uri?: string, name?: string }> }) {
  return result.content.filter(item => item.type === 'resource_link');
}

const hasBundledChromium = fs.existsSync(chromium.executablePath());
async function canLaunchBundledChromium(): Promise<boolean> {
  if (!hasBundledChromium)
    return false;

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: false,
    });
    return true;
  } catch {
    return false;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

const canRunE2E = await canLaunchBundledChromium();

describe.skipIf(!canRunE2E)('E2E smoke: accessibility tools', () => {
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
    const dropFilePath = path.join(outputDir, 'drop.txt');
    await fs.promises.writeFile(dropFilePath, 'dropped file contents');
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
    expect(toolNames).toContain('browser_network_request');
    expect(toolNames).toContain('browser_drop');

    const navigateResult = await backend.callTool('browser_navigate', { url: `${fixtureOrigin}/` });
    expect(navigateResult.isError).not.toBe(true);

    // Regression guards for #84 and #116: browser_evaluate must use the public
    // evaluate API and accept a plain expression against a real page.
    const evaluateResult = await backend.callTool('browser_evaluate', { function: 'document.title' });
    expect(evaluateResult.isError).not.toBe(true);
    expect((evaluateResult.content[0] as any).text).toContain('"Home"');

    const fetchResult = await backend.callTool('browser_evaluate', {
      function: `fetch('/api/data').then(response => response.json())`,
    });
    expect(fetchResult.isError).not.toBe(true);
    expect((fetchResult.content[0] as any).text).toContain('"name": "Ada"');

    const networkList = await backend.callTool('browser_network_requests', {});
    expect(networkList.isError).not.toBe(true);
    const networkListText = (networkList.content[0] as any).text as string;
    const networkIndex = networkListText.match(/^(\d+)\. \[GET\] .*\/api\/data => \[200\]/m)?.[1];
    expect(networkIndex).toBeDefined();

    const networkBody = await backend.callTool('browser_network_request', {
      index: Number(networkIndex),
      part: 'response-body',
    });
    expect(networkBody.isError).not.toBe(true);
    expect((networkBody.content[0] as any).text).toContain('{"name":"Ada"}');

    const pageSnapshot = await backend.callTool('browser_snapshot', {});
    const pageSnapshotText = (pageSnapshot.content[0] as any).text as string;
    const dropRef = pageSnapshotText.match(/region "Drop target" \[ref=(e\d+)\]/)?.[1];
    expect(dropRef).toBeDefined();

    const dropResult = await backend.callTool('browser_drop', {
      element: 'Drop target',
      ref: dropRef,
      data: { 'text/plain': 'dropped from MCP' },
    });
    expect(dropResult.isError).not.toBe(true);

    const droppedValue = await backend.callTool('browser_evaluate', {
      function: `document.querySelector('#dropzone').dataset.dropped`,
    });
    expect(droppedValue.isError).not.toBe(true);
    expect((droppedValue.content[0] as any).text).toContain('"dropped from MCP"');

    const fileDropResult = await backend.callTool('browser_drop', {
      element: 'Drop target',
      ref: dropRef,
      paths: [dropFilePath],
    });
    expect(fileDropResult.isError).not.toBe(true);

    const droppedFileValue = await backend.callTool('browser_evaluate', {
      function: `document.querySelector('#dropzone').dataset.dropped`,
    });
    expect(droppedFileValue.isError).not.toBe(true);
    expect((droppedFileValue.content[0] as any).text).toContain('"dropped file contents"');

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
    expect(keyboardResult1.structuredContent).toMatchObject({
      kind: 'audit_keyboard',
      report: {
        path: keyboardReportPath1,
      },
      summary: expect.objectContaining({
        skipLinkFound: true,
      }),
    });
    expect(extractResourceLinks(keyboardResult1 as any)).toEqual([
      expect.objectContaining({
        type: 'resource_link',
        uri: pathToFileURL(keyboardReportPath1).toString(),
        name: 'audit-keyboard-report',
      }),
    ]);

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
    expect(matrixResult.structuredContent).toMatchObject({
      kind: 'scan_page_matrix',
      report: {
        path: matrixReportPath,
      },
      baselineVariant: 'baseline',
      variants: [
        expect.objectContaining({ name: 'baseline' }),
        expect.objectContaining({ name: 'mobile' }),
      ],
    });
    expect(extractResourceLinks(matrixResult as any)).toEqual([
      expect.objectContaining({
        type: 'resource_link',
        uri: pathToFileURL(matrixReportPath).toString(),
        name: 'scan-page-matrix-report',
      }),
    ]);

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
    expect(siteResult.structuredContent).toMatchObject({
      kind: 'audit_site',
      report: {
        path: siteReportPath,
      },
      totals: expect.objectContaining({
        scannedPages: siteReport.summary.totals.scannedPages,
      }),
    });
    expect(extractResourceLinks(siteResult as any)).toEqual([
      expect.objectContaining({
        type: 'resource_link',
        uri: pathToFileURL(siteReportPath).toString(),
        name: 'audit-site-report',
      }),
    ]);

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
    expect(keyboardResult2.structuredContent).toMatchObject({
      kind: 'audit_keyboard',
      report: {
        path: keyboardReportPath2,
      },
    });
  }, 120000);
});
