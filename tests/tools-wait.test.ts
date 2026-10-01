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

  // Strip the per-call AbortSignal so option objects can be compared exactly.
  function waitOptions(waitFor: ReturnType<typeof vi.fn>) {
    return waitFor.mock.calls.map(([{ signal, ...options }]) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return options;
    });
  }

  it.each([undefined, 0, 70])('races text and textGone, using time %s as their timeout', async time => {
    const { context, response, waitFor } = setup();
    const pending = waitTools[0].handle(context, { time, text: 'Ready', textGone: 'Loading' }, response);
    await vi.runAllTimersAsync();
    await pending;
    // A clamped time becomes the waitFor timeout; a missing/zero time leaves the default.
    const timeout = time ? { timeout: 30000 } : {};
    expect(waitOptions(waitFor)).toEqual([{ state: 'visible', ...timeout }, { state: 'hidden', ...timeout }]);
    // Both stubs resolve immediately, so the appearance wait (first in the race) wins.
    expect(response.result()).toBe('Waited for Ready');
    // The generated code replays the same race with the effective (capped) timeout.
    const options = time ? ', timeout: 30000' : '';
    expect(response.code()).toBe([
      'await Promise.race([',
      `  page.getByText("Ready").first().waitFor({ state: 'visible'${options} }),`,
      `  page.getByText("Loading").first().waitFor({ state: 'hidden'${options} }),`,
      ']);',
    ].join('\n'));
  });

  it('aborts the losing wait once the race settles', async () => {
    const { context, response, waitFor } = setup();
    let lose: (error: Error) => void = () => {};
    waitFor
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => {
          lose = reject;
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }));
    await waitTools[0].handle(context, { text: 'Ready', textGone: 'Loading' }, response);
    const signals = waitFor.mock.calls.map(([{ signal }]) => signal as AbortSignal);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    lose(new Error('late failure'));
    expect(response.result()).toBe('Waited for Ready');
  });

  it('aborts the other wait when the race fails', async () => {
    const { context, response, waitFor } = setup();
    waitFor
        .mockImplementationOnce(({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }))
        .mockRejectedValueOnce(new Error('Timeout 30000ms exceeded'));
    await expect(waitTools[0].handle(context, { time: 30, text: 'Ready', textGone: 'Loading' }, response))
        .rejects.toThrow('Timeout 30000ms exceeded');
    expect(waitFor.mock.calls.every(([{ signal }]) => (signal as AbortSignal).aborted)).toBe(true);
  });

  it('waits for text to appear', async () => {
    const { context, response, waitFor } = setup();
    await waitTools[0].handle(context, { text: 'Ready' }, response);
    expect(waitOptions(waitFor)).toEqual([{ state: 'visible' }]);
    expect(response.result()).toBe('Waited for Ready');
    expect(response.code()).toBe(`await page.getByText("Ready").first().waitFor({ state: 'visible' });`);
  });

  it('waits for text to disappear with a timeout', async () => {
    const { context, response, waitFor } = setup();
    await waitTools[0].handle(context, { time: 2, textGone: 'Loading' }, response);
    expect(waitOptions(waitFor)).toEqual([{ state: 'hidden', timeout: 2000 }]);
    expect(response.result()).toBe('Waited for Loading');
    expect(response.code()).toBe(`await page.getByText("Loading").first().waitFor({ state: 'hidden', timeout: 2000 });`);
  });

  it('rejects a negative time in the input schema', () => {
    const schema = waitTools[0].schema.inputSchema;
    expect(schema.safeParse({ time: -1, text: 'Ready' }).success).toBe(false);
    expect(schema.safeParse({ time: 0, text: 'Ready' }).success).toBe(true);
  });

  it.each([{}, { time: 0 }])('preserves missing-condition errors for %j', async params => {
    const { context, response } = setup();
    await expect(waitTools[0].handle(context, params, response)).rejects.toThrow('Either time, text or textGone must be provided');
    expect(vi.getTimerCount()).toBe(0);
  });
});
