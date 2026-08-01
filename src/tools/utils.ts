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

// How long an action that finished quietly is watched for work it scheduled
// rather than started - a click handler whose fetch fires from a timer has
// issued nothing by the time its own promise resolves. Capped by the settle
// delay it defers to, so lowering that lowers this with it.
const quietWindowMs = 100;

export async function waitForCompletion<R>(tab: Tab, callback: () => Promise<R>): Promise<R> {
  const settleMs = tab.context.config.timeouts.settle ?? 500;
  const requests = new Set<playwright.Request>();
  let requestSeen = false;
  let frameNavigated = false;
  let waitCallback: () => void = () => {};
  const waitBarrier = new Promise<void>(f => { waitCallback = f; });
  // Resolves on the first sign of page work, whenever it arrives.
  let signalCallback: () => void = () => {};
  const firstSignal = new Promise<void>(f => { signalCallback = f; });

  const requestListener = (request: playwright.Request) => {
    requestSeen = true;
    requests.add(request);
    signalCallback();
  };
  const requestFinishedListener = (request: playwright.Request) => {
    requests.delete(request);
    if (!requests.size)
      waitCallback();
  };

  const frameNavigateListener = (frame: playwright.Frame) => {
    if (frame.parentFrame())
      return;
    frameNavigated = true;
    signalCallback();
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
    // Nothing has happened yet, which is not the same as nothing being about to:
    // watch briefly for work the action scheduled instead of started.
    if (!requestSeen && !frameNavigated)
      await raceTimeout(firstSignal, Math.min(quietWindowMs, settleMs));
    if (!requests.size && !frameNavigated)
      waitCallback();
    await waitBarrier;
    // The settle delay covers work the page reported and is still finishing -
    // a response being rendered, a navigation still painting. An action that
    // issued no request and navigated nowhere within the window above started
    // none of that, so there is nothing left to wait out. Skipping it is worth
    // ~500ms on every click, keypress and form fill.
    if (requestSeen || frameNavigated)
      await tab.waitForTimeout(settleMs);
    return result;
  } finally {
    dispose();
  }
}

// Resolves with `promise` or when the timeout elapses, whichever comes first.
// Both branches resolve, so the losing one leaves nothing unhandled behind.
async function raceTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>(resolve => {
        timeoutId = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
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
