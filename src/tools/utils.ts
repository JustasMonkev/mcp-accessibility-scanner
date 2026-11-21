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

import { setImmediate } from 'node:timers/promises';
import { settleWithin } from '../utils/timeout.js';

import type * as playwright from 'playwright';
import type { Request } from 'playwright';
import type { Tab } from '../tab.js';

const scheduledWorkWindowMs = 100;
// A short window for protocol events already on their way, not a DOM settle delay.
const zeroSettleDeliveryGraceMs = 2;
const pageActivityTimeoutMs = 10_000;
const targetClosedMessage = /Target (?:page, context or browser has been closed|page closed|closed)/i;

export async function waitForCompletion<R>(tab: Tab, callback: () => Promise<R>, settleMs = tab.context.config.timeouts.settle ?? 500): Promise<R> {
  const activity = new PageActivity(tab);
  try {
    const result = await callback();
    await activity.waitUntilIdle(Math.min(scheduledWorkWindowMs, settleMs));
    await waitForDomOnlyWork(tab, settleMs);
    return result;
  } finally {
    activity.dispose();
  }
}

class PageActivity {
  private readonly _tab: Tab;
  private readonly _inFlightRequests = new Set<Request>();
  private _sawRequest = false;
  private _mainFrameNavigated = false;
  private _waitingForIdle = false;
  private readonly _idle = Promise.withResolvers<void>();
  private readonly _firstActivity = Promise.withResolvers<void>();
  private readonly _timeout: ReturnType<typeof setTimeout>;

  constructor(tab: Tab) {
    this._tab = tab;
    tab.page.on('request', this._onRequest);
    tab.page.on('requestfinished', this._onRequestSettled);
    tab.page.on('requestfailed', this._onRequestSettled);
    tab.page.on('framenavigated', this._onFrameNavigated);
    this._timeout = setTimeout(() => {
      this.dispose();
      this._idle.resolve();
    }, pageActivityTimeoutMs);
  }

  async waitUntilIdle(firstActivityWindowMs: number): Promise<void> {
    const zeroSettle = firstActivityWindowMs <= 0;
    if (zeroSettle)
      await setImmediate();
    if (!this._sawRequest && !this._mainFrameNavigated)
      await settleWithin(this._firstActivity.promise, zeroSettle ? zeroSettleDeliveryGraceMs : firstActivityWindowMs);
    this._waitingForIdle = true;
    if (!this._inFlightRequests.size && !this._mainFrameNavigated)
      this._idle.resolve();
    await this._idle.promise;
  }

  dispose(): void {
    this._tab.page.off('request', this._onRequest);
    this._tab.page.off('requestfinished', this._onRequestSettled);
    this._tab.page.off('requestfailed', this._onRequestSettled);
    this._tab.page.off('framenavigated', this._onFrameNavigated);
    clearTimeout(this._timeout);
  }

  private _onRequest = (request: Request) => {
    this._sawRequest = true;
    this._inFlightRequests.add(request);
    this._firstActivity.resolve();
  };

  private _onRequestSettled = (request: Request) => {
    this._inFlightRequests.delete(request);
    if (this._waitingForIdle && !this._inFlightRequests.size)
      this._idle.resolve();
  };

  private _onFrameNavigated = (frame: playwright.Frame) => {
    this._firstActivity.resolve();
    if (frame.parentFrame())
      return;
    this._mainFrameNavigated = true;
    this.dispose();
    void this._tab.waitForLoadState('load').then(this._idle.resolve);
  };
}

async function waitForDomOnlyWork(tab: Tab, settleMs: number): Promise<void> {
  if (settleMs <= 0 || tab.page.isClosed())
    return;
  try {
    await tab.waitForTimeout(settleMs);
  } catch (error) {
    const pageClosedWhileSettling = tab.page.isClosed() && error instanceof Error && targetClosedMessage.test(error.message);
    if (!pageClosedWhileSettling)
      throw error;
  }
}

export async function generateLocator(locator: playwright.Locator): Promise<string> {
  try {
    return (await locator.normalize()).toString();
  } catch {
    const locatorText = String(locator);
    return locatorText === '[object Object]' ? `locator('<unresolved>')` : locatorText;
  }
}

export async function callOnPageNoTrace<T>(page: playwright.Page, callback: (page: playwright.Page) => Promise<T>): Promise<T> {
  const internalPage = page as playwright.Page & { _wrapApiCall: (callback: () => Promise<T>, options: { internal: boolean }) => Promise<T> };
  return await internalPage._wrapApiCall(() => callback(page), { internal: true });
}
