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

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    pageEvaluate = vi.fn(async () => ({ result: undefined, isFunction: true }));

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
  });

  it('evaluates a page-scoped function and returns its value', async () => {
    pageEvaluate.mockResolvedValueOnce({ result: 4, isFunction: true });

    await evaluateTool.handle(mockContext, { function: '() => 2 + 2' }, response);

    expect(pageEvaluate).toHaveBeenCalledTimes(1);
    expect(response.result()).toContain('4');
    expect(response.isError()).toBeFalsy();
  });

  it('forwards the user source as the evaluate argument (no _evaluateFunction)', async () => {
    // Regression guard for #84: playwright-core 1.59 removed _evaluateFunction,
    // so the tool must call the public evaluate() with an in-page callback that
    // receives the user source as its argument.
    mockTab.page._evaluateFunction = vi.fn();

    await evaluateTool.handle(mockContext, { function: '() => window.location.href' }, response);

    expect(mockTab.page._evaluateFunction).not.toHaveBeenCalled();
    const [passedFunction, passedSource] = pageEvaluate.mock.calls[0];
    expect(typeof passedFunction).toBe('function');
    expect(passedSource).toBe('() => window.location.href');
    expect(response.code()).toContain('await page.evaluate(() => window.location.href);');
  });

  it('in-page callback runs functions, expressions, and promises', async () => {
    await evaluateTool.handle(mockContext, { function: '() => 1' }, response);
    const callback = pageEvaluate.mock.calls[0][0];

    await expect(callback('() => 2 + 2')).resolves.toEqual({ result: 4, isFunction: true });
    await expect(callback('1 + 2')).resolves.toEqual({ result: 3, isFunction: false });
    await expect(callback('Promise.resolve(7)')).resolves.toEqual({ result: 7, isFunction: false });
    await expect(callback('() => { throw new Error("boom") }')).rejects.toThrow('boom');
  });

  it('in-page callback evaluates the source in global scope, not the wrapper scope', async () => {
    // Regression guard: a direct eval would make wrapper locals like `value`
    // or `result` shadow same-named page globals and throw a TDZ error.
    await evaluateTool.handle(mockContext, { function: '() => 1' }, response);
    const callback = pageEvaluate.mock.calls[0][0];

    (globalThis as any).result = 42;
    try {
      await expect(callback('() => result')).resolves.toEqual({ result: 42, isFunction: true });
      await expect(callback('result')).resolves.toEqual({ result: 42, isFunction: false });
    } finally {
      delete (globalThis as any).result;
    }
  });

  it('supports bare expressions and reflects them in the generated code', async () => {
    // Regression guard: the source is auto-detected in the page, so a bare
    // expression like `document.title` must be reported as a wrapped function
    // in the generated code rather than failing with "result is not a function".
    pageEvaluate.mockResolvedValueOnce({ result: 'My Title', isFunction: false });

    await evaluateTool.handle(mockContext, { function: 'document.title' }, response);

    expect(pageEvaluate.mock.calls[0][1]).toBe('document.title');
    expect(response.result()).toContain('My Title');
    expect(response.code()).toContain('await page.evaluate(() => (document.title));');
    expect(response.isError()).toBeFalsy();
  });

  it('accepts expression statements with trailing semicolons', async () => {
    pageEvaluate.mockResolvedValueOnce({ result: 'My Title', isFunction: false });

    await evaluateTool.handle(mockContext, { function: 'document.title;' }, response);

    expect(pageEvaluate.mock.calls[0][1]).toBe('document.title');
    expect(response.code()).toContain('await page.evaluate(() => (document.title));');
    expect(response.isError()).toBeFalsy();
  });

  it('evaluates against an element locator when ref and element are provided', async () => {
    const locatorEvaluate = vi.fn().mockResolvedValue({ result: 'hello', isFunction: true });
    mockTab.refLocator.mockResolvedValue({
      evaluate: locatorEvaluate,
      _resolveSelector: async () => ({ resolvedSelector: 'internal:role=button' }),
    });

    await evaluateTool.handle(
        mockContext,
        { function: '(el) => el.textContent', element: 'the button', ref: 'e1' },
        response
    );

    expect(mockTab.refLocator).toHaveBeenCalledWith({ ref: 'e1', element: 'the button' });
    expect(locatorEvaluate).toHaveBeenCalledTimes(1);
    expect(pageEvaluate).not.toHaveBeenCalled();
    const [passedFunction, passedSource] = locatorEvaluate.mock.calls[0];
    expect(typeof passedFunction).toBe('function');
    expect(passedSource).toBe('(el) => el.textContent');
    expect(response.result()).toContain('hello');

    // Run the captured in-page callback: functions receive the element as
    // their argument, bare expressions can reference it as `element`.
    const fakeElement = { textContent: 'hello element' };
    await expect(passedFunction(fakeElement, '(el) => el.textContent'))
        .resolves.toEqual({ result: 'hello element', isFunction: true });
    await expect(passedFunction(fakeElement, 'element.textContent'))
        .resolves.toEqual({ result: 'hello element', isFunction: false });
  });
});
