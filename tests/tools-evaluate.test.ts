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
import evaluateTools, { toFunctionSource } from '../src/tools/evaluate.js';
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

  it('wraps a bare page expression into a function', async () => {
    await evaluateTool.handle(mockContext, { function: 'document.title' }, response);

    expect(pageEvaluate.mock.calls[0][0].toString()).toBe(toFunctionSource('document.title', false));
    expect(response.code()).toContain('document.title');
  });

  it('wraps a bare element expression so it can reference element', async () => {
    const locatorEvaluate = vi.fn().mockResolvedValue('hello');
    mockTab.refLocator.mockResolvedValue({
      evaluate: locatorEvaluate,
      _resolveSelector: async () => ({ resolvedSelector: 'internal:role=button' }),
    });

    await evaluateTool.handle(
        mockContext,
        { function: 'element.textContent', element: 'the button', ref: 'e1' },
        response
    );

    // The element case also proves the onElement plumbing picks the (element) form.
    expect(locatorEvaluate.mock.calls[0][0].toString()).toBe(toFunctionSource('element.textContent', true));
  });

  it('wraps an object literal expression without it parsing as a block', async () => {
    await evaluateTool.handle(mockContext, { function: '{ title: document.title }' }, response);

    expect(pageEvaluate.mock.calls[0][0].toString()).toBe(toFunctionSource('{ title: document.title }', false));
  });
});

describe('toFunctionSource', () => {
  const functionSources = [
    '() => 2 + 2',
    '() => { return 2 + 2; }',
    '(element) => element.textContent',
    '(a, b) => a + b',
    'element => element.textContent',
    '_ => 1',
    '$el => $el.id',
    'async () => await fetch("/x")',
    'async (element) => element.id',
    'async(element) => element.id',
    'function () { return 1; }',
    'function named() { return 1; }',
    'async function () { return 1; }',
    '  \n () => 1',
    '// pick the title\n() => document.title',
    '/* pick the title */ () => document.title',
    '({ a = (1, 2) }) => a',
    '(a = ") => x") => a',
    // Function literals inside grouping parentheses: wrapping these would make
    // the tool return a function value, which serializes to `undefined`.
    '(() => document.title)',
    '( () => document.title )',
    '((element) => element.textContent)',
    '(function () { return document.title; })',
    '(async () => document.title)',
    '((() => 1))',
    '(\n  () => document.title\n)',
    '(() => document.title) // trailing',
    // Comments the scanner has to step over rather than count as parentheses.
    'async /*c*/ () => document.title',
    'async\n// why\n() => 1',
    '(a /* ) */) => document.title',
    "(a /* don't */) => document.title",
    '(\n  a, // one )\n  b\n) => document.title',
    'async /*c*/ function () { return 1; }',
    // Parameter lists whose brackets hide inside a regex or a nested template.
    '(a = /[)]/) => document.title',
    '(a = `${`)`}`) => document.title',
    // Non-ASCII parameter names are still parameter names.
    'é => document.title',
    'ünnamed => document.title',
  ];

  for (const source of functionSources) {
    it(`leaves the function form ${JSON.stringify(source)} untouched`, () => {
      expect(toFunctionSource(source, false)).toBe(source);
      expect(toFunctionSource(source, true)).toBe(source);
    });
  }

  const expressionSources = [
    'document.title',
    '2 + 2',
    'window.location.href',
    '(a + b)',
    '(1, 2)',
    '{ a: 1 }',
    'functionally.named.thing',
    'asyncThing.value',
    'async',
    'document.querySelectorAll("a").length',
  ];

  for (const source of expressionSources) {
    it(`wraps the expression ${JSON.stringify(source)}`, () => {
      expect(toFunctionSource(source, false)).toBe(`() => (\n${source}\n)`);
      expect(toFunctionSource(source, true)).toBe(`(element) => (\n${source}\n)`);
    });
  }

  it('drops a trailing semicolon so the expression stays an expression', () => {
    expect(toFunctionSource('document.title;', false)).toBe('() => (\ndocument.title\n)');
    expect(toFunctionSource('document.title ; ', false)).toBe('() => (\ndocument.title\n)');
  });

  it('keeps a trailing line comment from swallowing the closing paren', () => {
    const wrapped = toFunctionSource('document.title // the title', false);

    expect(wrapped).toBe('() => (\ndocument.title // the title\n)');
    expect(() => new Function(`return ${wrapped}`)).not.toThrow();
  });

  it('rejects an empty expression instead of emitting broken source', () => {
    for (const empty of ['', '   ', '\n', ';', ' ;; '])
      expect(() => toFunctionSource(empty, false)).toThrow(/empty/);
  });

  it('produces parseable source for every wrapped expression', () => {
    for (const source of expressionSources) {
      for (const onElement of [false, true])
        expect(() => new Function(`return ${toFunctionSource(source, onElement)}`)).not.toThrow();
    }
  });
});

describe('browser_evaluate element pairing', () => {
  const schema = evaluateTool.schema.inputSchema;

  it('requires element and ref together, so a lone ref cannot fall back to page scope', () => {
    expect(schema.safeParse({ function: 'document.title' }).success).toBe(true);
    expect(schema.safeParse({ function: 'element.id', element: 'the button', ref: 'e1' }).success).toBe(true);
    expect(schema.safeParse({ function: 'element.textContent', ref: 'e1' }).success).toBe(false);
    expect(schema.safeParse({ function: 'element.id', element: 'the button' }).success).toBe(false);
  });
});
