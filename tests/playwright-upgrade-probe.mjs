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

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as playwright from 'playwright';

const require = createRequire(import.meta.url);
const log = value => process.stdout.write(JSON.stringify(value) + '\n');
for (const name of ['playwright', 'playwright-core'])
  assert.equal(require(`${name}/package.json`).version, '1.65.1');
const name = process.env.MCP_TEST_BROWSER_NAME || 'chromium';
assert.ok(['chromium', 'firefox', 'webkit'].includes(name));
const browser = await playwright[name].launch({ headless: true });
const timer = setTimeout(async () => {
  process.stderr.write('Browser upgrade probe exceeded 120 seconds\n');
  process.exitCode = 1;
  await browser.close();
}, 120_000).unref();

async function fixture(context) {
  await context.route('https://upgrade.test/**', route => route.fulfill({
    contentType: 'text/html', body: '<title>Upgrade fixture</title>',
  }));
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto('https://upgrade.test/');
  return page;
}

try {
  assert.equal(browser.version(), { chromium: '159.0.8154.6', firefox: '159.0', webkit: '27.2' }[name]);
  log({ browser: name, version: browser.version(), node: process.version, platform: process.platform });
  const original = await browser.newContext();
  try {
    const page = await fixture(original);
    await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('collections', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('records', 'readwrite');
        tx.objectStore('records').put(new Map([['key', 'value']]), 'map');
        tx.objectStore('records').put(new Set([1, 2]), 'set');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    }));
    // slop-check-ignore no-json-clone -- recorded storage-state files use JSON; exercise that serialized contract.
    const state = JSON.parse(JSON.stringify(await original.storageState({ indexedDB: true })));
    for (const mode of ['newContext', 'setStorageState']) {
      const restored = await browser.newContext(mode === 'newContext' ? { storageState: state } : {});
      try {
        if (mode === 'setStorageState')
          await restored.setStorageState(state);
        const restoredPage = await fixture(restored);
        const values = await restoredPage.evaluate(() => new Promise((resolve, reject) => {
          const request = indexedDB.open('collections', 1);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('records', 'readonly');
            const map = tx.objectStore('records').get('map');
            const set = tx.objectStore('records').get('set');
            tx.oncomplete = () => {
              db.close();
              resolve({ isMap: map.result instanceof Map, map: map.result instanceof Map ? [...map.result] : map.result,
                isSet: set.result instanceof Set, set: set.result instanceof Set ? [...set.result] : set.result });
            };
            tx.onerror = () => { db.close(); reject(tx.error); };
          };
        }));
        assert.deepEqual(values, { isMap: true, map: [['key', 'value']], isSet: true, set: [1, 2] });
        log({ indexedDB: mode, values });
      } finally {
        await restored.close();
      }
    }
  } finally {
    await original.close();
  }

  if (name === 'chromium') {
    for (const device of ['iPhone 15', 'Pixel 10']) {
      const descriptor = playwright.devices[device];
      const context = await browser.newContext(descriptor);
      try {
        const page = await fixture(context);
        const measured = await page.evaluate(() => ({ ua: navigator.userAgent, width: screen.width, height: screen.height, dpr: devicePixelRatio }));
        assert.deepEqual(measured, { ua: descriptor.userAgent, ...descriptor.screen, dpr: descriptor.deviceScaleFactor });
        if (device === 'Pixel 10')
          assert.match(measured.ua, /Chrome\/159\./);
        log({ device, measured });
      } finally {
        await context.close();
      }
    }
    const context = await browser.newContext({ hasTouch: true, viewport: { width: 800, height: 600 } });
    try {
      const page = await fixture(context);
      const touch = () => page.evaluate(() => ({ points: navigator.maxTouchPoints, coarse: matchMedia('(pointer: coarse)').matches }));
      assert.deepEqual(await touch(), { points: 1, coarse: true });
      await page.setContent('<div style="height:2200px">Tall screenshot target</div>');
      for (const capture of [() => page.screenshot({ fullPage: true }), () => page.locator('div').screenshot()]) {
        await capture();
        assert.deepEqual(await touch(), { points: 1, coarse: true });
      }
      await page.goto('https://upgrade.test/after');
      assert.deepEqual(await touch(), { points: 1, coarse: true });
      log('Touch properties preserved after both screenshot modes and navigation');
      // Same fixed-header retry geometry as microsoft/playwright#42626.
      await page.setContent(`<style>html{scroll-behavior:smooth}body{margin:0}.spacer{height:2000px}
        #header{position:fixed;top:0;left:0;right:0;height:calc(100vh - 50px);background:#eee}button{height:30px}</style>
        <div id="header"></div><div class="spacer"></div><button onclick="document.body.dataset.clicked='yes'">Target</button><div class="spacer"></div>
        <script>addEventListener('scroll',()=>document.body.dataset.scrolls=String(Number(document.body.dataset.scrolls||0)+1))</script>`);
      await page.click('button');
      assert.equal(await page.locator('body').getAttribute('data-clicked'), 'yes');
      const scrolls = Number(await page.locator('body').getAttribute('data-scrolls'));
      assert.ok(scrolls <= 2, `Smooth-scroll retry emitted ${scrolls} events`);
      log({ scrollRetryEvents: scrolls });
    } finally {
      await context.close();
    }
  }
} finally {
  clearTimeout(timer);
  await browser.close();
}
