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

import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';
import * as playwright from 'playwright';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { resolveConfig } from '../src/config.js';

const browserName = process.env.MCP_TEST_BROWSER_NAME || 'chromium';
if (browserName !== 'chromium' && browserName !== 'firefox' && browserName !== 'webkit')
  throw new Error(`MCP_TEST_BROWSER_NAME must be chromium, firefox or webkit, got ${browserName}`);
const require = createRequire(import.meta.url);
const playwrightCoreVersion: string = require('playwright-core/package.json').version;

// Playwright's US layout: unshifted numpad keys act with NumLock off, Shift
// yields the digit or decimal point, and every event is at the numpad location.
const DOM_KEY_LOCATION_NUMPAD = 3;
const presses = [
  { press: 'NumpadSubtract', key: '-', code: 'NumpadSubtract', typed: '-' },
  { press: 'NumpadDecimal', key: 'Delete', code: 'NumpadDecimal', typed: '' },
  { press: 'Shift+Numpad1', key: '1', code: 'Numpad1', typed: '1' },
  { press: 'Shift+NumpadDecimal', key: '.', code: 'NumpadDecimal', typed: '.' },
];

// Deviations recorded on the paired pins with Chromium 153.0.8010.12, Firefox
// 155.0 and WebKit 26.6 (microsoft/playwright#42913, merged after 1.63.0, and
// #42927, unmerged when recorded). A Playwright version or browser without an
// entry must deliver every key as modeled above.
const knownDeviations: Record<string, string[]> = {
  '1.63.0/chromium': [
    'NumpadSubtract keyup location is not numpad',
    'NumpadDecimal keydown key "\\u0000"',
    'NumpadDecimal keyup key "\\u0000"',
    'NumpadDecimal keyup location is not numpad',
    'Shift+Numpad1 keyup location is not numpad',
    'Shift+Numpad1 typed ""',
    'Shift+NumpadDecimal keyup location is not numpad',
    'Shift+NumpadDecimal typed ""',
  ],
  '1.63.0/firefox': [
    'NumpadDecimal keydown key "\\u0000"',
    'NumpadDecimal keyup key "\\u0000"',
  ],
  '1.63.0/webkit': [
    'NumpadDecimal keydown key "\\u0000"',
    'NumpadDecimal keyup key "\\u0000"',
  ],
};

type RecordedEvent = { type: string, key: string, code: string, location: number, keyCode: number };

let browser: playwright.Browser | undefined;
let backend: BrowserServerBackend | undefined;

afterEach(async () => {
  backend?.serverClosed();
  await browser?.close();
  browser = backend = undefined;
});

it(`records numpad key events delivered by browser_press_key (${browserName}, #244)`, async () => {
  browser = await playwright[browserName].launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(`<textarea aria-label="Numpad target"></textarea><script>
    window.recorded = [];
    for (const type of ['keydown', 'keyup'])
      document.querySelector('textarea').addEventListener(type, event => window.recorded.push({
        type, key: event.key, code: event.code, location: event.location, keyCode: event.keyCode,
      }));
  </script>`);
  await page.focus('textarea');
  const config = await resolveConfig({ timeouts: { settle: 50 } });
  backend = new BrowserServerBackend(config, {
    createContext: async () => ({ browserContext: context, close: async () => context.close() }),
  });
  await backend.initialize({ notifyToolListChanged: async () => {} }, { name: 'vitest', version: '1.0.0' });
  // Adopts the prepared page as the current tab, as a client's first look would.
  const snapshot = await backend.callTool('browser_snapshot', {});
  expect(JSON.stringify(snapshot.content)).toContain('Numpad target');

  const found: string[] = [];
  const observed: Record<string, { events: RecordedEvent[], typed: string }> = {};
  for (const expected of presses) {
    await page.evaluate(() => {
      (window as any).recorded = [];
      document.querySelector('textarea')!.value = '';
    });
    const result = await backend.callTool('browser_press_key', { key: expected.press });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    const events = (await page.evaluate(() => (window as any).recorded) as RecordedEvent[]).filter(event => event.key !== 'Shift');
    const typed = await page.locator('textarea').inputValue();
    observed[expected.press] = { events, typed };
    for (const type of ['keydown', 'keyup']) {
      const event = events.find(event => event.type === type);
      if (!event) {
        found.push(`${expected.press} sent no ${type}`);
        continue;
      }
      if (event.key !== expected.key)
        found.push(`${expected.press} ${type} key ${JSON.stringify(event.key)}`);
      if (event.code !== expected.code)
        found.push(`${expected.press} ${type} code ${JSON.stringify(event.code)}`);
      if (event.location !== DOM_KEY_LOCATION_NUMPAD)
        found.push(`${expected.press} ${type} location is not numpad`);
    }
    if (typed !== expected.typed)
      found.push(`${expected.press} typed ${JSON.stringify(typed)}`);
  }
  const pin = `${playwrightCoreVersion}/${browserName}`;
  process.stdout.write(JSON.stringify({ pin, browserVersion: browser.version(), platform: process.platform, found, observed }) + '\n');
  expect(found).toEqual(knownDeviations[pin] ?? []);
});
