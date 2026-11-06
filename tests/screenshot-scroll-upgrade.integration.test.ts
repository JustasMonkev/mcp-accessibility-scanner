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
import { afterEach, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { resolveConfig } from '../src/config.js';

let browser: Browser | undefined;
let backend: BrowserServerBackend | undefined;
let directory: string | undefined;

afterEach(async () => {
  try {
    backend?.serverClosed();
    await browser?.close();
  } finally {
    if (directory)
      await fs.rm(directory, { recursive: true, force: true });
    browser = backend = directory = undefined;
  }
});

async function setup(hasTouch = false) {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-screenshot-scroll-'));
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 720 }, hasTouch });
  const page = await context.newPage();
  backend = new BrowserServerBackend(await resolveConfig({ outputDir: directory, timeouts: { settle: 0 } }), {
    createContext: async () => ({ browserContext: context, close: () => context.close() }),
  });
  await backend.initialize({ notifyToolListChanged: async () => {} }, { name: 'screenshot-scroll-upgrade', version: '1' });
  return { page, backend };
}

it.each(['full-page', 'element'] as const)('preserves touch emulation after an oversized %s screenshot and navigation (#42617)', async mode => {
  const { page, backend } = await setup(true);
  await page.goto('data:text/html,<button style="height:2500px">Tall target</button>');
  const touchState = () => page.evaluate(() => ({
    touchStart: 'ontouchstart' in window,
    points: navigator.maxTouchPoints,
    coarse: matchMedia('(pointer: coarse)').matches,
  }));
  const before = await touchState();
  expect(before).toEqual({ touchStart: true, points: 1, coarse: true });
  const snapshot = await backend.callTool('browser_snapshot', {});
  const text = snapshot.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  const ref = text.match(/button "Tall target" \[ref=([^\]]+)\]/)?.[1];
  expect(ref, text).toBeDefined();
  const result = await backend.callTool('browser_take_screenshot', mode === 'full-page'
    ? { fullPage: true }
    : { element: 'Tall target', ref });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  expect(await touchState()).toEqual(before);
  await page.goto('data:text/html,<p>Next document</p>');
  expect(await touchState()).toEqual(before);
});

it('uses instant retry scrolling under a fixed header with smooth CSS scrolling (#42626)', async () => {
  const { page, backend } = await setup();
  await page.setContent(`<style>
    html { scroll-behavior: smooth }
    body { margin: 0 }
    header { position: fixed; inset: 0 0 50px; background: silver }
    section { height: 2000px }
    button { height: 30px }
  </style><header></header><section></section>
  <button onclick="document.body.dataset.clicked = 'yes'">Scroll target</button><section></section>`);
  await page.evaluate(() => {
    const positions: number[] = [];
    addEventListener('scroll', () => {
      positions.push(scrollY);
      document.body.dataset.scrolls = JSON.stringify(positions);
    });
  });
  const snapshot = await backend.callTool('browser_snapshot', {});
  const text = snapshot.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  const ref = text.match(/button "Scroll target" \[ref=([^\]]+)\]/)?.[1];
  expect(ref, text).toBeDefined();
  const result = await backend.callTool('browser_click', { element: 'Scroll target', ref });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const state = await page.evaluate(() => ({ clicked: document.body.dataset.clicked, positions: JSON.parse(document.body.dataset.scrolls || '[]') }));
  process.stdout.write(JSON.stringify({ case: 'smooth-retry-scroll', ...state }) + '\n');
  expect(state.clicked).toBe('yes');
  expect(state.positions.length).toBeGreaterThan(0);
  expect(state.positions.length).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('smooth');
});
