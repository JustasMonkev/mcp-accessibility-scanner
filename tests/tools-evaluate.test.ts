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
    pageEvaluate = vi.fn(async (func: any) => {
      // Mirror Playwright: it serializes the argument via toString(). Returning
      // the serialized source lets the test assert the user code was forwarded.
      return func.toString();
    });

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
    pageEvaluate.mockResolvedValueOnce(4);

    await evaluateTool.handle(mockContext, { function: '() => 2 + 2' }, response);

    expect(pageEvaluate).toHaveBeenCalledTimes(1);
    expect(response.result()).toContain('4');
    expect(response.isError()).toBeFalsy();
  });

  it('forwards the user source to evaluate via Function.toString (no _evaluateFunction)', async () => {
    // Regression guard for #84: playwright-core 1.59 removed _evaluateFunction,
    // so the tool must call the public evaluate() with a toString-overridden
    // function instead of the (now missing) private receiver method.
    mockTab.page._evaluateFunction = vi.fn();

    await evaluateTool.handle(mockContext, { function: '() => window.location.href' }, response);

    expect(mockTab.page._evaluateFunction).not.toHaveBeenCalled();
    const passedFunction = pageEvaluate.mock.calls[0][0];
    expect(typeof passedFunction).toBe('function');
    expect(passedFunction.toString()).toBe('() => window.location.href');
  });

  it('evaluates against an element locator when ref and element are provided', async () => {
    const locatorEvaluate = vi.fn().mockResolvedValue('hello');
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
    expect(locatorEvaluate.mock.calls[0][0].toString()).toBe('(el) => el.textContent');
    expect(response.result()).toContain('hello');
  });
});
