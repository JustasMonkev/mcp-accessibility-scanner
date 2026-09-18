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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import type { Config } from '../config.js';
import type { Context } from '../src/context.js';
import { outputFile, resolveConfig } from '../src/config.js';
import { Response } from '../src/response.js';
import screenshotTools from '../src/tools/screenshot.js';
import pdfTools from '../src/tools/pdf.js';
import { quote } from '../src/utils/codegen.js';
import { writeJsonReport } from '../src/tools/report.js';

describe('output path rendering with real files', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, chromiumSandbox: false });
  });
  afterAll(async () => { await browser?.close(); });

  for (const filePaths of [undefined, 'relative', 'absolute'] satisfies Config['filePaths'][]) {
    it.each(['relative output directory', 'default temp directory'])('%s with policy ' + filePaths, async directory => {
      const configuredDir = directory === 'relative output directory'
        ? await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-path #render-')) : undefined;
      const config = await resolveConfig({
        filePaths,
        outputDir: configuredDir ? path.relative(process.cwd(), configuredDir) : undefined,
      });
      const page = await browser.newPage();
      const tab = { page, context: { outputFile: (name: string, exclusive: boolean) => outputFile(config, name, exclusive) }, modalStates: () => [] };
      // SAFETY: these tools only access config and currentTabOrDie; the tab uses a real Playwright page.
      const context = { config, currentTabOrDie: () => tab } as Context;
      const reportPath = await outputFile(config, 'report #1.json');
      const display = (file: string) => filePaths === 'absolute' ? path.resolve(file)
        : filePaths === 'relative' ? path.relative(process.cwd(), path.resolve(file)) : file;
      try {
        await page.setContent('<h1>Path rendering</h1>');
        for (const [tool, filename] of [[screenshotTools[0], 'shot.png'], [pdfTools[0], 'page.pdf']] as const) {
          const response = new Response(context, tool.schema.name, {});
          await tool.handle(context, tool.schema.inputSchema.parse({ filename }), response);
          const file = path.join(path.dirname(reportPath), filename);
          expect(response.result()).toBe(tool.schema.name === 'browser_take_screenshot'
            ? `Took the viewport screenshot and saved it as ${display(file)}` : `Saved page as ${display(file)}`);
          expect(response.code()).toContain(`path: ${quote(display(file))}`);
          expect((await fs.stat(file)).size).toBeGreaterThan(0);
          const text = response.serialize().content.find(item => item.type === 'text');
          expect(text).toMatchObject({ type: 'text', text: expect.stringContaining(display(file)) });
        }
        const response = new Response(context, 'report', {});
        const report = { unchanged: 'report payload' };
        const resource = await writeJsonReport(response, reportPath, report, { name: 'report', title: 'Report', description: 'Test report' });
        expect(resource.path).toBe(display(reportPath));
        expect(resource.uri).toBe(pathToFileURL(reportPath).href);
        const specialPath = path.join(path.dirname(reportPath), 'space #.json');
        const specialUri = response.addFileResourceLink(specialPath).uri;
        expect(specialUri).toContain('space%20%23.json');
        expect(fileURLToPath(specialUri)).toBe(path.resolve(specialPath));
        expect(response.resourceLinks()[0].uri).toBe(resource.uri);
        expect(JSON.parse(await fs.readFile(reportPath, 'utf8'))).toEqual(report);
      } finally {
        await page.close();
        await fs.rm(path.dirname(path.resolve(reportPath)), { recursive: true, force: true });
      }
    });
  }
});
