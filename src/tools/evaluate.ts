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
import * as javascript from '../utils/codegen.js';
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

    await tab.waitForCompletion(async () => {
      // playwright-core 1.59 removed the private `_evaluateFunction` helper
      // (microsoft/playwright#39646), which auto-detected whether the source
      // was a function or a bare expression. Recreate that behavior by
      // eval-ing the source in the page: if it yields a function, call it
      // (passing the element for element evaluations), otherwise treat it as
      // an expression whose value is the result. Bare expressions in element
      // evaluations can still reference `element` because eval runs in the
      // callback scope.
      let evalResult: { result: unknown, isFunction: boolean };
      if (locator) {
        evalResult = await locator.evaluate(async (element, expression) => {
          const value = eval(`(${expression})`);
          const isFunction = typeof value === 'function';
          const result = await (isFunction ? value(element) : value);
          return { result, isFunction };
        }, params.function);
      } else {
        evalResult = await tab.page.evaluate(async expression => {
          const value = eval(`(${expression})`);
          const isFunction = typeof value === 'function';
          const result = await (isFunction ? value() : value);
          return { result, isFunction };
        }, params.function);
      }

      const codeExpression = evalResult.isFunction
        ? params.function
        : locator ? `(element) => (${params.function})` : `() => (${params.function})`;
      if (locator)
        response.addCode(`await page.${await generateLocator(locator)}.evaluate(${javascript.quote(codeExpression)});`);
      else
        response.addCode(`await page.evaluate(${javascript.quote(codeExpression)});`);

      response.addResult(JSON.stringify(evalResult.result, null, 2) || 'undefined');
    });
  },
});

export default [
  evaluate,
];
