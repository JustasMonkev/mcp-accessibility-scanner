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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium, type Browser, type BrowserContext } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import { resolveConfig } from '../src/config.js';
import { Context } from '../src/context.js';

import type { BrowserContextFactory } from '../src/browserContextFactory.js';

describe.skipIf(!fs.existsSync(chromium.executablePath()))('trace recovery in a real browser', () => {
  it('starts another trace after saving the previous trace fails', async () => {
    const outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-a11y-trace-'));
    let browser: Browser | undefined;
    let browserContext: BrowserContext | undefined;

    try {
      const notADirectory = path.join(outputDir, 'not-a-directory');
      const recoveredTrace = path.join(outputDir, 'recovered.zip');
      await fs.promises.writeFile(notADirectory, '');

      browser = await chromium.launch({ headless: true, chromiumSandbox: false });
      browserContext = await browser.newContext();
      const stop = browserContext.tracing.stop.bind(browserContext.tracing);
      let stopCount = 0;
      vi.spyOn(browserContext.tracing, 'stop').mockImplementation(() => stop({
        path: ++stopCount === 1 ? path.join(notADirectory, 'failed.zip') : recoveredTrace,
      }));
      const factory: BrowserContextFactory = {
        createContext: async () => ({ browserContext, close: async () => {} }),
      };
      const config = await resolveConfig({ saveTrace: true });
      const newContext = () => new Context({
        tools: [],
        config,
        browserContextFactory: factory,
        sessionLog: undefined,
        clientInfo: {},
      });

      const first = newContext();
      await first.newTab();
      await first.closeBrowserContext();

      const second = newContext();
      await second.newTab();
      await second.closeBrowserContext();

      const archive = await fs.promises.readFile(recoveredTrace);
      expect(stopCount).toBe(2);
      expect(archive.subarray(0, 4)).toEqual(Buffer.from('PK\x03\x04'));
      expect(archive.includes(Buffer.from('trace.trace'))).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await Context.disposeAll();
      await browserContext?.close();
      await browser?.close();
      await fs.promises.rm(outputDir, { recursive: true, force: true });
    }
  });
});
