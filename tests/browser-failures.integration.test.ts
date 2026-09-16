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
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chromium, type BrowserContext } from 'playwright';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { contextFactory } from '../src/browserContextFactory.js';
import { resolveConfig } from '../src/config.js';

describe('pinned browser failure regressions (#224, #226)', () => {
  let context: BrowserContext | undefined;
  let backend: BrowserServerBackend | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    backend?.serverClosed();
    await context?.browser()?.close();
    if (directory)
      await fs.rm(directory, { recursive: true, force: true });
    context = backend = directory = undefined;
  });

  async function setup(html: string) {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-browser-failure-'));
    const browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 100, height: 100 }, deviceScaleFactor: 2 });
    const ownedContext = context;
    const page = await context.newPage();
    await page.setContent(html);
    const config = await resolveConfig({ outputDir: directory, timeouts: { settle: 50 } });
    backend = new BrowserServerBackend(config, {
      createContext: async () => ({ browserContext: ownedContext, close: async () => ownedContext.close() }),
    });
    await backend.initialize({ notifyToolListChanged: async () => {} }, { name: 'vitest', version: '1.0.0' });
    return { page, backend, directory };
  }

  it.each(['css', 'device'])('rejects oversized WebP page/element captures at %s scale and cleans output', async scale => {
    const { backend, page, directory } = await setup('<div role="button" aria-label="Tall capture" style="width:50px;height:16384px;background:red"></div>');
    const snapshot = await backend.callTool('browser_snapshot', {});
    const text = snapshot.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    const ref = text.match(/button "Tall capture" \[ref=([^\]]+)\]/)?.[1];
    expect(ref).toBeDefined();
    for (const capture of [{ fullPage: true }, { element: 'Tall capture', ref }]) {
      const result = await backend.callTool('browser_take_screenshot', { type: 'webp', scale, ...capture });
      expect(result.isError).toBe(true);
      expect(result.content.some(item => item.type === 'image')).toBe(false);
      expect(await fs.readdir(directory)).toEqual([]);
    }
    await page.locator('div').evaluate(element => { element.style.height = '40px'; });
    const control = await backend.callTool('browser_take_screenshot', { type: 'webp', scale });
    expect(control.isError).not.toBe(true);
    expect(control.content.some(item => item.type === 'image')).toBe(true);
    expect(await fs.readdir(directory)).toHaveLength(1);
  });

  it.each([false, true])('retains an actual setFiles failure for retry (clear selection: %s)', async clear => {
    const { backend, page, directory } = await setup(`<input type="file" onchange="setTimeout(() => document.querySelector('output').textContent = this.files[0]?.name || 'empty', 10)"><output></output>`);
    const first = path.join(directory, 'first.txt');
    const second = path.join(directory, 'second.txt');
    await fs.writeFile(first, 'first');
    await fs.writeFile(second, 'second');
    await backend.callTool('browser_snapshot', {});
    const chooser = page.waitForEvent('filechooser');
    await page.locator('input').click();
    await chooser;
    const failed = await backend.callTool('browser_file_upload', { paths: [first, second] });
    expect(failed.isError).toBe(true);
    expect(failed.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('Non-multiple file input') })]));
    const retry = await backend.callTool('browser_file_upload', { paths: clear ? [] : [first] });
    expect(retry.isError).not.toBe(true);
    expect(await page.$eval('input', input => input.files?.length)).toBe(clear ? 0 : 1);
    expect(await page.locator('output').textContent()).toBe(clear ? 'empty' : 'first.txt');
  });

  it('rejects storage imports before worker execution or IndexedDB Map/Set loss, while allowing isolated import', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-storage-failure-'));
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
      throw new Error('Expected a TCP fixture server');
    const origin = `http://127.0.0.1:${address.port}`;
    let isolated: Awaited<ReturnType<ReturnType<typeof contextFactory>['createContext']>> | undefined;
    try {
      context = await chromium.launchPersistentContext(directory, { headless: true, args: ['--remote-debugging-port=0'] });
      const page = context.pages()[0];
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
      const port = (await fs.readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
      const storageState = { cookies: [], origins: [{
        origin,
        localStorage: [{ name: 'imported', value: 'yes' }],
        indexedDB: [{ name: 'collections', version: 1, stores: [{
          name: 'store', autoIncrement: false, indexes: [], records: [{ key: 'session', value: { authenticated: true } }],
        }] }],
      }] };
      const browserOptions = { cdpEndpoint: `http://127.0.0.1:${port}`, contextOptions: { storageState } };
      const config = await resolveConfig({ browser: browserOptions });
      await expect(contextFactory(config).createContext({}, new AbortController().signal, undefined)).rejects.toThrow('Cannot apply --storage-state');
      expect(page.isClosed()).toBe(false);
      expect(page.url()).toBe('about:blank');
      await page.goto(`${origin}/inspect`);
      expect(await page.evaluate(() => ({ ...localStorage }))).toEqual({ original: 'kept' });
      expect(await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('collections', 1);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });
        const transaction = db.transaction('store', 'readonly');
        transaction.oncomplete = () => db.close();
        const [map, set] = await Promise.all(['map', 'set'].map(key => new Promise<unknown>((resolve, reject) => {
          const request = transaction.objectStore('store').get(key);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        })));
        // Check inside the browser: evaluate() itself does not preserve Map/Set.
        return { isMap: map instanceof Map, map: map instanceof Map ? [...map] : map, isSet: set instanceof Set, set: set instanceof Set ? [...set] : set };
      })).toEqual({ isMap: true, map: [['mk', 'mv']], isSet: true, set: [1, 2] });
      // The existing profile's worker remains active and still serves navigations.
      await page.goto(origin);
      expect(await page.evaluate(() => localStorage.worker)).toBe('ran');
      isolated = await contextFactory(await resolveConfig({ browser: { ...browserOptions, isolated: true } }))
          .createContext({}, new AbortController().signal, undefined);
      const fresh = await isolated.browserContext.newPage();
      await fresh.goto(`${origin}/inspect`);
      expect(await fresh.evaluate(() => ({ ...localStorage }))).toEqual({ imported: 'yes' });
      expect(await fresh.evaluate(() => new Promise<unknown>((resolve, reject) => {
        const request = indexedDB.open('collections', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction('store', 'readonly');
          transaction.oncomplete = () => db.close();
          const record = transaction.objectStore('store').get('session');
          record.onerror = () => reject(record.error);
          record.onsuccess = () => resolve(record.result);
        };
      }))).toEqual({ authenticated: true });
    } finally {
      await isolated?.close();
      await context?.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
