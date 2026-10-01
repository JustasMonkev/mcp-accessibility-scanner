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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import waitTools from '../src/tools/wait.js';
import { Response } from '../src/response.js';
import type { Context } from '../src/context.js';

describe('browser_wait_for', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const waitFor = vi.fn().mockResolvedValue(undefined);
    const getByText = vi.fn(() => ({ first: () => ({ waitFor }) }));
    // SAFETY: the handler and Response only read this page stub and snapshot config.
    const context = { config: { snapshot: {} }, currentTabOrDie: () => ({ page: { getByText } }) } as Context;
    return { context, waitFor, response: new Response(context, 'browser_wait_for', {}) };
  }

  it.each([
    [0.5, 0.5],
    [30, 30],
    [31, 30],
    [70, 30],
  ])('reports and replays the actual delay for %s seconds', async (requested, actual) => {
    const { context, response } = setup();
    const done = vi.fn();
    const pending = waitTools[0].handle(context, { time: requested }, response).then(done);
    await vi.advanceTimersByTimeAsync(actual * 1000 - 1);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(response.code()).toBe(`await new Promise(f => setTimeout(f, ${actual} * 1000));`);
    expect(response.result()).toBe(requested === actual
      ? `Waited for ${actual} seconds`
      : `Waited for ${actual} seconds (requested ${requested}, maximum is 30)`);
  });

  it.each([undefined, 0, 70])('races text and textGone, using time %s as their timeout', async time => {
    const { context, response, waitFor } = setup();
    const pending = waitTools[0].handle(context, { time, text: 'Ready', textGone: 'Loading' }, response);
    await vi.runAllTimersAsync();
    await pending;
    // A clamped time becomes the waitFor timeout; a missing/zero time leaves the default.
    const visible = time ? { state: 'visible', timeout: 30000 } : { state: 'visible' };
    const hidden = time ? { state: 'hidden', timeout: 30000 } : { state: 'hidden' };
    expect(waitFor.mock.calls).toEqual([[visible], [hidden]]);
    // Both stubs resolve immediately, so the appearance wait (first in the race) wins.
    expect(response.result()).toBe('Waited for Ready');
    // The generated code mirrors the effective (capped) timeout so a replay keeps the limit.
    expect(response.code()).toBe(time
      ? `await page.getByText("Ready").first().waitFor({ state: 'visible', timeout: 30000 });`
      : `await page.getByText("Ready").first().waitFor({ state: 'visible' });`);
    expect(response.code()).not.toContain('setTimeout');
  });

  it('waits for text to appear', async () => {
    const { context, response, waitFor } = setup();
    await waitTools[0].handle(context, { text: 'Ready' }, response);
    expect(waitFor.mock.calls).toEqual([[{ state: 'visible' }]]);
    expect(response.result()).toBe('Waited for Ready');
    expect(response.code()).toBe(`await page.getByText("Ready").first().waitFor({ state: 'visible' });`);
  });

  it('waits for text to disappear', async () => {
    const { context, response, waitFor } = setup();
    await waitTools[0].handle(context, { textGone: 'Loading' }, response);
    expect(waitFor.mock.calls).toEqual([[{ state: 'hidden' }]]);
    expect(response.result()).toBe('Waited for Loading');
    expect(response.code()).toBe(`await page.getByText("Loading").first().waitFor({ state: 'hidden' });`);
  });

  it.each([{}, { time: 0 }])('preserves missing-condition errors for %j', async params => {
    const { context, response } = setup();
    await expect(waitTools[0].handle(context, params, response)).rejects.toThrow('Either time, text or textGone must be provided');
    expect(vi.getTimerCount()).toBe(0);
  });
});
