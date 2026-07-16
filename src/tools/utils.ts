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

import coreBundle from 'playwright-core/lib/coreBundle';

const { asLocator } = coreBundle.iso;

import type * as playwright from 'playwright';
import type { Tab } from '../tab.js';

export async function waitForCompletion<R>(tab: Tab, callback: () => Promise<R>): Promise<R> {
  const requests = new Set<playwright.Request>();
  let frameNavigated = false;
  let waitCallback: () => void = () => {};
  const waitBarrier = new Promise<void>(f => { waitCallback = f; });

  const requestListener = (request: playwright.Request) => requests.add(request);
  const requestFinishedListener = (request: playwright.Request) => {
    requests.delete(request);
    if (!requests.size)
      waitCallback();
  };

  const frameNavigateListener = (frame: playwright.Frame) => {
    if (frame.parentFrame())
      return;
    frameNavigated = true;
    dispose();
    clearTimeout(timeout);
    void tab.waitForLoadState('load').then(waitCallback);
  };

  const onTimeout = () => {
    dispose();
    waitCallback();
  };

  tab.page.on('request', requestListener);
  tab.page.on('requestfinished', requestFinishedListener);
  tab.page.on('framenavigated', frameNavigateListener);
  const timeout = setTimeout(onTimeout, 10000);

  const dispose = () => {
    tab.page.off('request', requestListener);
    tab.page.off('requestfinished', requestFinishedListener);
    tab.page.off('framenavigated', frameNavigateListener);
    clearTimeout(timeout);
  };

  try {
    const result = await callback();
    if (!requests.size && !frameNavigated)
      waitCallback();
    await waitBarrier;
    await tab.waitForTimeout(1000);
    return result;
  } finally {
    dispose();
  }
}

export async function generateLocator(locator: playwright.Locator): Promise<string> {
  // playwright-core 1.61 replaced the private `_resolveSelector` helper with the
  // public `Locator.normalize()` method (microsoft/playwright). `normalize()`
  // returns a locator whose `toString()` is the resolved JavaScript locator
  // expression, which is exactly what the "Ran Playwright code" snippet needs.
  if (typeof (locator as any).normalize === 'function') {
    try {
      const normalized = await locator.normalize();
      return normalized.toString();
    } catch {
      // Fall through to the legacy/string strategies below.
    }
  }

  // Older cores (< 1.61) still expose the private `_resolveSelector` helper.
  if (typeof (locator as any)._resolveSelector === 'function') {
    const { resolvedSelector } = await (locator as any)._resolveSelector();
    return asLocator('javascript', resolvedSelector);
  }

  // `generateLocator` only renders the "Ran Playwright code" snippet. It must
  // not block the actual action when Playwright removes private helpers.
  const locatorText = String(locator);
  return locatorText === '[object Object]' ? `locator('<unresolved>')` : locatorText;
}

export async function callOnPageNoTrace<T>(page: playwright.Page, callback: (page: playwright.Page) => Promise<T>): Promise<T> {
  return await (page as any)._wrapApiCall(() => callback(page), { internal: true });
}
