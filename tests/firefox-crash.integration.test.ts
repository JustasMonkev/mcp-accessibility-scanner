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
import { firefox, type Page } from 'playwright';

// Process-killing probe: opt in only on a disposable Linux runner. Every target
// must still descend from the exact Firefox process launched by this test.
const enabled = process.env.MCP_TEST_FIREFOX_CRASH === '1';
if (enabled && process.platform !== 'linux')
  throw new Error('MCP_TEST_FIREFOX_CRASH requires a disposable Linux runner');

async function processTree(root: number): Promise<number[]> {
  const descendants: number[] = [];
  let threads: string[];
  try {
    threads = await fs.readdir(`/proc/${root}/task`);
  } catch (error) {
    // A child listed by its parent may exit before its own threads are read.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return descendants;
    throw error;
  }
  for (const thread of threads) {
    try {
      const children = await fs.readFile(`/proc/${root}/task/${thread}/children`, 'utf8');
      for (const entry of children.trim().split(/\s+/).filter(Boolean)) {
        const pid = Number(entry);
        descendants.push(pid, ...await processTree(pid));
      }
    } catch (error) {
      // A browser thread or child may exit while /proc is being traversed.
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        throw error;
    }
  }
  return descendants;
}

async function readProcessFile(pid: number, name: 'comm' | 'cmdline') {
  try {
    return await fs.readFile(`/proc/${pid}/${name}`, 'utf8');
  } catch (error) {
    // A process from the descendant snapshot may exit before inspection.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  }
}

async function crashPage(page: Page, root: number) {
  const targets: number[] = [];
  for (const pid of await processTree(root)) {
    const name = (await readProcessFile(pid, 'comm'))?.trim();
    if (name === 'Web Content' || name === 'Isolated Web Co')
      targets.push(pid);
  }
  expect(targets.length).toBeGreaterThan(0);
  const crashed = page.waitForEvent('crash', { timeout: 10000 });
  // Attach the rejection handler before sending signals, including on failure.
  const result = crashed.then(() => undefined, (error: Error) => error);
  let signalled = 0;
  for (const pid of targets) {
    if (!(await processTree(root)).includes(pid))
      continue;
    try {
      process.kill(pid, 'SIGKILL');
      signalled++;
    } catch (error) {
      // The child can exit between the ancestry recheck and the signal.
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
        throw error;
    }
  }
  expect(signalled).toBeGreaterThan(0);
  expect(await result).toBeUndefined();
}

async function rssMiB(pid: number) {
  const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
  const rss = status.match(/^VmRSS:\s+(\d+)/m);
  if (!rss)
    throw new Error(`Missing RSS for Firefox parent ${pid}`);
  return Number(rss[1]) / 1024;
}

it.skipIf(!enabled)('records Firefox crash-cycle retention and persistent-browser survival (#42956)', async () => {
  const server = await firefox.launchServer();
  const root = server.process().pid;
  if (!root)
    throw new Error('Firefox server has no process id');
  try {
    const browser = await firefox.connect(server.wsEndpoint());
    try {
      for (const { crash, cycles } of [{ crash: false, cycles: 2 }, { crash: false, cycles: 10 }, { crash: true, cycles: 10 }]) {
        const before = await rssMiB(root);
        for (let cycle = 0; cycle < cycles; cycle++) {
          const context = await browser.newContext();
          try {
            const page = await context.newPage();
            await page.goto('about:blank');
            if (crash)
              await crashPage(page, root);
          } finally {
            await context.close();
          }
          expect(browser.contexts()).toHaveLength(0);
        }
        process.stdout.write(JSON.stringify({ browserVersion: browser.version(), crash, cycles, parentRssDeltaMiB: await rssMiB(root) - before }) + '\n');
      }
      const survivor = await browser.newPage();
      expect(await survivor.evaluate(() => 6 * 7)).toBe(42);
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-firefox-crash-'));
  try {
    const context = await firefox.launchPersistentContext(directory);
    try {
      const roots: number[] = [];
      for (const pid of await processTree(process.pid)) {
        const args = (await readProcessFile(pid, 'cmdline'))?.split('\0');
        if (args?.includes(directory))
          roots.push(pid);
      }
      expect(roots).toHaveLength(1);
      await crashPage(context.pages()[0], roots[0]);
      for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
        const page = await context.newPage();
        expect(await page.evaluate(() => 6 * 7)).toBe(42);
      }
    } finally {
      await context.close();
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 90000);
