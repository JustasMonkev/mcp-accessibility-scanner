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

import { settleWithin } from '../utils/timeout.js';

import type * as playwright from 'playwright';
import type { Request } from 'playwright';
import type { Tab } from '../tab.js';

const scheduledWorkWindowMs = 100;
const pageActivityTimeoutMs = 10_000;
const targetClosedMessage = /Target (?:page, context or browser has been closed|page closed|closed)/i;

export async function waitForCompletion<R>(tab: Tab, callback: () => Promise<R>): Promise<R> {
  const settleMs = tab.context.config.timeouts.settle ?? 500;
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
  private _markIdle: () => void = () => {};
  private readonly _idle = new Promise<void>(resolve => { this._markIdle = resolve; });
  private _markFirstActivity: () => void = () => {};
  private readonly _firstActivity = new Promise<void>(resolve => { this._markFirstActivity = resolve; });
  private readonly _timeout: ReturnType<typeof setTimeout>;

  constructor(tab: Tab) {
    this._tab = tab;
    tab.page.on('request', this._onRequest);
    tab.page.on('requestfinished', this._onRequestSettled);
    tab.page.on('requestfailed', this._onRequestSettled);
    tab.page.on('framenavigated', this._onFrameNavigated);
    this._timeout = setTimeout(() => {
      this.dispose();
      this._markIdle();
    }, pageActivityTimeoutMs);
  }

  async waitUntilIdle(firstActivityWindowMs: number): Promise<void> {
    if (!this._sawRequest && !this._mainFrameNavigated)
      await settleWithin(this._firstActivity, firstActivityWindowMs);
    if (!this._inFlightRequests.size && !this._mainFrameNavigated)
      this._markIdle();
    await this._idle;
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
    this._markFirstActivity();
  };

  private _onRequestSettled = (request: Request) => {
    this._inFlightRequests.delete(request);
    if (!this._inFlightRequests.size)
      this._markIdle();
  };

  private _onFrameNavigated = (frame: playwright.Frame) => {
    this._markFirstActivity();
    if (frame.parentFrame())
      return;
    this._mainFrameNavigated = true;
    this.dispose();
    void this._tab.waitForLoadState('load').then(this._markIdle);
  };
}

async function waitForDomOnlyWork(tab: Tab, settleMs: number): Promise<void> {
  if (tab.page.isClosed())
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
