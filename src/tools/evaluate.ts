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

import { z } from 'zod';

import { defineTabTool } from './tool.js';
import { generateLocator } from './utils.js';

import type * as playwright from 'playwright';

const evaluateSchema = z.object({
  function: z.string().describe('() => { /* code */ } or (element) => { /* code */ } when element is provided'),
  element: z.string().optional().describe('Human-readable element description used to obtain permission to interact with the element'),
  ref: z.string().optional().describe('Exact target element reference from the page snapshot'),
});

const evaluate = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_evaluate',
    title: 'Evaluate JavaScript',
    description: 'Evaluate JavaScript expression on page or element',
    inputSchema: evaluateSchema,
    type: 'destructive',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();

    let locator: playwright.Locator | undefined;
    if (params.ref && params.element)
      locator = await tab.refLocator({ ref: params.ref, element: params.element });

    // Trailing semicolons would make the parenthesized wrapper below
    // syntactically invalid (`(document.title;)`), so accept expression
    // statements by stripping them.
    const source = params.function.replace(/[\s;]+$/, '');

    await tab.waitForCompletion(async () => {
      // playwright-core 1.59 removed the private `_evaluateFunction` helper
      // (microsoft/playwright#39646), which auto-detected whether the source
      // was a function or a bare expression. Recreate that behavior in the
      // page: wrap the source in an arrow so nothing runs while parsing, use
      // indirect eval so the source sees only page globals (never this
      // callback's locals), then call the value when it is a function or use
      // it as the result. Bare expressions in element evaluations can
      // reference `element` through the wrapper parameter.
      let evalResult: { result: unknown, isFunction: boolean };
      if (locator) {
        evalResult = await locator.evaluate(async (element, expression) => {
          const globalEval = eval;
          const value = globalEval(`(element) => (${expression})`)(element);
          const isFunction = typeof value === 'function';
          const result = await (isFunction ? value(element) : value);
          return { result, isFunction };
        }, source);
      } else {
        evalResult = await tab.page.evaluate(async expression => {
          const globalEval = eval;
          const value = globalEval(`() => (${expression})`)();
          const isFunction = typeof value === 'function';
          const result = await (isFunction ? value() : value);
          return { result, isFunction };
        }, source);
      }

      // Emit the callback source directly: page.evaluate() only auto-invokes
      // real functions, not function-source strings, so a quoted form would
      // evaluate to the function itself instead of running it.
      const codeExpression = evalResult.isFunction
        ? source
        : locator ? `(element) => (${source})` : `() => (${source})`;
      if (locator)
        response.addCode(`await page.${await generateLocator(locator)}.evaluate(${codeExpression});`);
      else
        response.addCode(`await page.evaluate(${codeExpression});`);

      response.addResult(JSON.stringify(evalResult.result, null, 2) || 'undefined');
    });
  },
});

export default [
  evaluate,
];
