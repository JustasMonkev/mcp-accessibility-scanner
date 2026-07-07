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
    pageEvaluate = vi.fn();

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
    // The user source is forwarded as the argument to page.evaluate.
    expect(pageEvaluate.mock.calls[0][1]).toBe('() => 2 + 2');
    expect(response.result()).toContain('4');
    expect(response.code()).toContain(`await page.evaluate('() => 2 + 2');`);
    expect(response.isError()).toBeFalsy();
  });

  it('accepts a plain expression and wraps it in the generated code', async () => {
    pageEvaluate.mockResolvedValueOnce({ result: 'Example Domain', isFunction: false });

    await evaluateTool.handle(mockContext, { function: 'document.title' }, response);

    expect(pageEvaluate).toHaveBeenCalledTimes(1);
    expect(pageEvaluate.mock.calls[0][1]).toBe('document.title');
    expect(response.result()).toContain('Example Domain');
    // A bare expression is wrapped so the emitted code stays runnable.
    expect(response.code()).toContain(`await page.evaluate('() => (document.title)');`);
    expect(response.isError()).toBeFalsy();
  });

  it('forwards the user source without the removed _evaluateFunction helper', async () => {
    // Regression guard for #84: playwright-core 1.59 removed _evaluateFunction,
    // so the tool must evaluate the user source in-page via the public
    // evaluate() rather than the (now missing) private receiver method.
    mockTab.page._evaluateFunction = vi.fn();
    pageEvaluate.mockResolvedValueOnce({ result: 'https://example.com/', isFunction: true });

    await evaluateTool.handle(mockContext, { function: '() => window.location.href' }, response);

    expect(mockTab.page._evaluateFunction).not.toHaveBeenCalled();
    // A real function is passed as the receiver, with the user source as its argument.
    expect(typeof pageEvaluate.mock.calls[0][0]).toBe('function');
    expect(pageEvaluate.mock.calls[0][1]).toBe('() => window.location.href');
  });

  it('evaluates against an element locator when ref and element are provided', async () => {
    const locatorEvaluate = vi.fn().mockResolvedValue({ result: 'hello', isFunction: true });
    mockTab.refLocator.mockResolvedValue({
      evaluate: locatorEvaluate,
      normalize: async () => ({ toString: () => `locator('#el')` }),
    });

    await evaluateTool.handle(
        mockContext,
        { function: '(el) => el.textContent', element: 'the button', ref: 'e1' },
        response
    );

    expect(mockTab.refLocator).toHaveBeenCalledWith({ ref: 'e1', element: 'the button' });
    expect(locatorEvaluate).toHaveBeenCalledTimes(1);
    expect(locatorEvaluate.mock.calls[0][1]).toBe('(el) => el.textContent');
    expect(pageEvaluate).not.toHaveBeenCalled();
    expect(response.result()).toContain('hello');
  });
});
