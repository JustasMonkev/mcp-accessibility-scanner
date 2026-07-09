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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import evaluateTools from '../src/tools/evaluate.js';
import { Response } from '../src/response.js';

import type { Context } from '../src/context.js';
import type { Tab } from '../src/tab.js';

const evaluateTool = evaluateTools.find(t => t.schema.name === 'browser_evaluate')!;

describe('browser_evaluate tool', () => {
  let mockContext: Context;
  let mockTab: any;
  let pageEvaluate: ReturnType<typeof vi.fn>;
  let response: Response;

  beforeEach(() => {
    pageEvaluate = vi.fn(async (callback: (source: string) => unknown, source: string) => callback(source));

    mockTab = {
      modalStates: vi.fn().mockReturnValue([]),
      page: { evaluate: pageEvaluate },
      refLocator: vi.fn(),
      waitForCompletion: vi.fn(async (callback: () => Promise<void>) => {
        await callback();
      }),
    };

    mockContext = {
      currentTabOrDie: () => mockTab as Tab,
      config: {},
    } as any;

    response = new Response(mockContext, 'browser_evaluate', {});
  });

  it('exists with the expected schema', () => {
    expect(evaluateTool).toBeDefined();
    expect(evaluateTool.schema.name).toBe('browser_evaluate');
    expect(evaluateTool.capability).toBe('core');
    expect(evaluateTool.schema.inputSchema.parse({ function: '1 + 1' })).toEqual({ function: '1 + 1' });
  });

  it('evaluates a page-scoped function and returns its value', async () => {
    await evaluateTool.handle(mockContext, { function: '() => 2 + 2' }, response);

    expect(pageEvaluate).toHaveBeenCalledTimes(1);
    expect(pageEvaluate.mock.calls[0][1]).toBe('() => 2 + 2');
    expect(response.result()).toBe('4');
    expect(response.code()).toContain(`await page.evaluate(() => 2 + 2);`);
    expect(response.isError()).toBeFalsy();
  });

  it('evaluates a plain expression and emits runnable code', async () => {
    await evaluateTool.handle(mockContext, { function: '(1 + 1)' }, response);

    expect(pageEvaluate.mock.calls[0][1]).toBe('(1 + 1)');
    expect(response.result()).toBe('2');
    expect(response.code()).toContain(`await page.evaluate(() => ((1 + 1)));`);
    expect(response.isError()).toBeFalsy();
  });

  it('does not misclassify an expression containing an arrow callback', async () => {
    await evaluateTool.handle(mockContext, { function: '[1, 2, 3].map(value => value * 2)' }, response);

    expect(response.result()).toBe('[\n  2,\n  4,\n  6\n]');
    expect(response.code()).toContain(`await page.evaluate(() => ([1, 2, 3].map(value => value * 2)));`);
  });

  it('awaits promise expressions', async () => {
    await evaluateTool.handle(mockContext, { function: 'Promise.resolve(42)' }, response);

    expect(response.result()).toBe('42');
    expect(response.code()).toContain(`() => (Promise.resolve(42))`);
  });

  it('uses the public evaluate API instead of the removed _evaluateFunction helper', async () => {
    mockTab.page._evaluateFunction = vi.fn();

    await evaluateTool.handle(mockContext, { function: '() => "ok"' }, response);

    expect(mockTab.page._evaluateFunction).not.toHaveBeenCalled();
    expect(typeof pageEvaluate.mock.calls[0][0]).toBe('function');
    expect(pageEvaluate.mock.calls[0][1]).toBe('() => "ok"');
  });

  it('evaluates against an element locator when ref and element are provided', async () => {
    const locatorEvaluate = vi.fn(async (
      callback: (element: { textContent: string }, source: string) => unknown,
      source: string
    ) => callback({ textContent: 'hello' }, source));
    mockTab.refLocator.mockResolvedValue({
      evaluate: locatorEvaluate,
      normalize: async () => ({ toString: () => `locator('#button')` }),
    });

    await evaluateTool.handle(
        mockContext,
        { function: '(element) => element.textContent', element: 'the button', ref: 'e1' },
        response
    );

    expect(mockTab.refLocator).toHaveBeenCalledWith({ ref: 'e1', element: 'the button' });
    expect(locatorEvaluate).toHaveBeenCalledTimes(1);
    expect(locatorEvaluate.mock.calls[0][1]).toBe('(element) => element.textContent');
    expect(pageEvaluate).not.toHaveBeenCalled();
    expect(response.result()).toBe('"hello"');
    expect(response.code()).toContain(`await page.locator('#button').evaluate((element) => element.textContent);`);
  });

  it('emits an element parameter for locator-scoped plain expressions', async () => {
    const locatorEvaluate = vi.fn(async (
      callback: (element: { textContent: string }, source: string) => unknown,
      source: string
    ) => callback({ textContent: 'hello' }, source));
    mockTab.refLocator.mockResolvedValue({
      evaluate: locatorEvaluate,
      normalize: async () => ({ toString: () => `locator('#button')` }),
    });

    await evaluateTool.handle(
        mockContext,
        { function: 'element.textContent', element: 'the button', ref: 'e1' },
        response
    );

    expect(response.result()).toBe('"hello"');
    expect(response.code()).toContain(`await page.locator('#button').evaluate((element) => (element.textContent));`);
  });

  it('reports invalid expressions as tool errors', async () => {
    await evaluateTool.handle(mockContext, { function: 'not valid javascript {' }, response);

    expect(response.isError()).toBe(true);
    expect(response.result()).toContain('Unexpected');
  });

  it('falls back cleanly when the result cannot be JSON-stringified', async () => {
    pageEvaluate.mockResolvedValueOnce((() => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      return { result: circular, isFunction: false };
    })());

    await evaluateTool.handle(mockContext, { function: 'globalThis' }, response);

    expect(response.isError()).toBeFalsy();
    expect(response.result()).toBe('[object Object]');
  });
});
