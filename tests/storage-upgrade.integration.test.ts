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

import http from 'node:http';
import { expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

async function collections(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('collections', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      const store = db.transaction('store', 'readonly').objectStore('store');
      const [map, set] = await Promise.all(['map', 'set'].map(key => new Promise<unknown>((resolve, reject) => {
        const request = store.get(key);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      })));
      return { isMap: map instanceof Map, map: map instanceof Map ? [...map] : map, isSet: set instanceof Set, set: set instanceof Set ? [...set] : set };
    } finally {
      db.close();
    }
  });
}

it('round-trips Map/Set without worker execution, but cannot restore worker registrations (#42664, #42707)', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/sw.js') {
      response.writeHead(200, { 'content-type': 'application/javascript' });
      response.end(`
        self.addEventListener('activate', event => event.waitUntil(clients.claim()));
        self.addEventListener('fetch', event => {
          if (new URL(event.request.url).pathname === '/')
            event.respondWith(new Response('<script>localStorage.worker = "ran"</script>', { headers: { 'content-type': 'text/html' } }));
        });
      `);
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<title>Storage fixture</title>');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP server');
  const origin = `http://127.0.0.1:${address.port}`;
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const source = await browser.newContext();
    const page = await source.newPage();
    await page.goto(origin);
    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('collections', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('store');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction('store', 'readwrite');
          transaction.objectStore('store').put(new Map([['mk', 'mv']]), 'map');
          transaction.objectStore('store').put(new Set([1, 2]), 'set');
          transaction.oncomplete = () => { db.close(); resolve(); };
          transaction.onerror = () => reject(transaction.error);
        };
      });
      localStorage.original = 'kept';
      const controlled = new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
      await navigator.serviceWorker.register('/sw.js');
      await controlled;
    });
    await page.goto('about:blank');
    const state = await source.storageState({ indexedDB: true });
    expect(page.url()).toBe('about:blank');
    expect(state.origins[0].localStorage).toEqual([{ name: 'original', value: 'kept' }]);
    await page.goto(`${origin}/inspect`);
    expect(await page.evaluate(() => ({ ...localStorage }))).toEqual({ original: 'kept' });
    const expected = { isMap: true, map: [['mk', 'mv']], isSet: true, set: [1, 2] };
    expect(await collections(page)).toEqual(expected);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(1);
    await page.goto(origin);
    expect(await page.evaluate(() => localStorage.worker)).toBe('ran');
    await page.evaluate(() => localStorage.removeItem('worker'));
    await page.goto('about:blank');
    await source.setStorageState(state);
    expect(page.url()).toBe('about:blank');
    await page.goto(`${origin}/inspect`);
    expect(await page.evaluate(() => ({ ...localStorage }))).toEqual({ original: 'kept' });
    expect(await collections(page)).toEqual(expected);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
    const fresh = await browser.newContext({ storageState: state });
    const imported = await fresh.newPage();
    await imported.goto(`${origin}/inspect`);
    expect(await imported.evaluate(() => ({ ...localStorage }))).toEqual({ original: 'kept' });
    expect(await collections(imported)).toEqual(expected);
    await page.goto(origin);
    expect(await page.evaluate(() => localStorage.worker)).toBeUndefined();
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
