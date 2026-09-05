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
import { describe, expect, it } from 'vitest';

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
      // Direct assignment rather than vi.spyOn: the spy's wrapper does not
      // settle Playwright's API-call promise under the vitest worker.
      const stop = browserContext.tracing.stop.bind(browserContext.tracing);
      let stopCount = 0;
      browserContext.tracing.stop = () => {
        ++stopCount;
        // Stop 1 models a failing save (unwritable target). The recovery
        // retry inside releaseTrace is bare — no path — which is what ends
        // the still-started server-side recording. Stop 3 is the second
        // session's release, exporting to the recovered path.
        const target = stopCount === 1
            ? path.join(notADirectory, 'failed.zip')
            : stopCount === 3 ? recoveredTrace : undefined;
        return stop(target ? { path: target } : undefined);
      };
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
      // Three stops: the first context's failed save, the bare retry that
      // ends the still-started recording, and the second context's release —
      // whose export lands on the recovered path.
      expect(stopCount).toBe(3);
      expect(archive.subarray(0, 4)).toEqual(Buffer.from('PK\x03\x04'));
      expect(archive.includes(Buffer.from('trace.trace'))).toBe(true);
    } finally {

      await Context.disposeAll();
      await browserContext?.close();
      await browser?.close();
      await fs.promises.rm(outputDir, { recursive: true, force: true });
    }
  });
});
