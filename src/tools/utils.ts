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

// How long the DOM must stay mutation-free before the settle ends early. The
// configured settle delay remains the ceiling: a page that keeps mutating (a
// spinner toggling classes, a carousel) still gets the full budget, while the
// common case - an action that changed nothing more after it ran - stops
// paying a fixed half-second on every tool call. This is also the minimum
// wall-clock length of the settle, which is what lets it double as the watch
// for work an action scheduled rather than started (see waitForCompletion).
//
// Ceiling: the observer watches the top document only. Mutations confined to a
// shadow root or a child frame's document do not reach it, so timer work that
// lands there between the quiet threshold and the old fixed delay is no longer
// waited for. Child-frame *navigations* still get a full settle window - the
// framenavigated listener marks them as page work - and shadow-root updates
// driven by requests or light-DOM changes are seen through those signals;
// only DOM-only timer work entirely inside a shadow root is quicker now.
const domQuietMs = 100;

// Runs in the page: resolves once the DOM has been mutation-free for quietMs,
// or after maxMs, whichever comes first. The deadline lives in-page too, so a
// caller abandoning the evaluate never leaves an observer running forever.
function inPageDomQuietWait({ quietMs, maxMs }: { quietMs: number, maxMs: number }) {
  return new Promise<void>(resolve => {
    let quietTimer: ReturnType<typeof setTimeout>;
    const done = () => {
      observer.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(deadline);
      resolve();
    };
    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(done, quietMs);
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    quietTimer = setTimeout(done, quietMs);
    const deadline = setTimeout(done, maxMs);
  });
}

// The settle delay after an action, ended early once the DOM goes quiet. Timers
// can schedule DOM-only work without producing any observable page signal, so
// some delay must remain - but a fixed sleep charges every action for the page
// that might mutate, and almost none do. Watching mutations keeps the returned
// snapshot just as fresh at a fraction of the wall-clock cost.
async function settleAfterAction(tab: Tab, settleMs: number): Promise<void> {
  const startedAt = Date.now();
  try {
    // Raced against the full settle budget rather than awaited bare: a dialog
    // blocking JavaScript would hold the evaluate open indefinitely, and the
    // old fixed sleep never waited longer than settleMs either.
    await raceTimeout(
        callOnPageNoTrace(tab.page, page => page.evaluate(inPageDomQuietWait, {
          quietMs: Math.min(domQuietMs, settleMs),
          maxMs: settleMs,
        })),
        settleMs,
    );
    return;
  } catch {
    // The page could not host the observer - a navigation racing the settle,
    // or the page closing. Fall back to the fixed delay for whatever remains
    // of the budget, through the path that understands blocked JavaScript.
  }
  const remainingMs = settleMs - (Date.now() - startedAt);
  if (remainingMs > 0 && !tab.page.isClosed()) {
    try {
      await tab.waitForTimeout(remainingMs);
    } catch (error) {
      const targetClosed = error instanceof Error && /Target (?:page, context or browser has been closed|page closed|closed)/i.test(error.message);
      if (!tab.page.isClosed() || !targetClosed)
        throw error;
    }
  }
}

export async function waitForCompletion<R>(tab: Tab, callback: () => Promise<R>): Promise<R> {
  const settleMs = tab.context.config.timeouts.settle ?? 500;
  const requests = new Set<playwright.Request>();
  let requestSeen = false;
  let frameNavigated = false;
  let childFrameNavigated = false;
  let waitCallback: () => void = () => {};
  const waitBarrier = new Promise<void>(f => { waitCallback = f; });

  const requestListener = (request: playwright.Request) => {
    requestSeen = true;
    requests.add(request);
  };
  // A request that fails - offline, blocked by CORS, aborted - emits
  // `requestfailed` and never `requestfinished`. Without the same removal path
  // it would sit in the set until the 10s timeout below, turning a click that
  // fired one doomed fetch into a ten-second tool call.
  const requestSettledListener = (request: playwright.Request) => {
    requests.delete(request);
    if (!requests.size)
      waitCallback();
  };

  const frameNavigateListener = (frame: playwright.Frame) => {
    if (frame.parentFrame()) {
      // A child frame swapping documents is page work too, and it can issue no
      // request at all. It must not gate the barrier on a top-level load state
      // that this navigation will never produce - but it must still earn the
      // post-work settle below: the DOM-quiet observer watches the top
      // document only and cannot see the new frame's contents initializing.
      childFrameNavigated = true;
      return;
    }
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
  tab.page.on('requestfinished', requestSettledListener);
  tab.page.on('requestfailed', requestSettledListener);
  tab.page.on('framenavigated', frameNavigateListener);
  const timeout = setTimeout(onTimeout, 10000);

  const dispose = () => {
    tab.page.off('request', requestListener);
    tab.page.off('requestfinished', requestSettledListener);
    tab.page.off('requestfailed', requestSettledListener);
    tab.page.off('framenavigated', frameNavigateListener);
    clearTimeout(timeout);
  };

  try {
    const result = await callback();
    // An action that finished quietly may still be about to do work - a click
    // handler whose fetch fires from a timer has issued nothing by the time its
    // own promise resolves. The DOM-quiet settle doubles as that watch: it
    // lasts at least the quiet threshold with the request listeners still
    // armed, so work the action scheduled is seen either as a request (awaited
    // through the barrier below) or as the DOM mutations it makes.
    if (!requestSeen && !frameNavigated && !childFrameNavigated && !tab.page.isClosed())
      await settleAfterAction(tab, settleMs);
    if (!requests.size && !frameNavigated)
      waitCallback();
    await waitBarrier;
    // Requests and navigations usually finish in DOM updates. Settle again so
    // the returned snapshot includes them - but end as soon as the DOM goes
    // quiet rather than sleeping the full budget.
    if ((requestSeen || frameNavigated || childFrameNavigated) && !tab.page.isClosed())
      await settleAfterAction(tab, settleMs);
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
