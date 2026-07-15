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

    try {
      await tab.waitForCompletion(async () => {
        let evalResult: { result: unknown, isFunction: boolean };
        if (locator) {
          evalResult = await locator.evaluate(async (element, source) => {
            const value = eval(`(${source})`);
            const isFunction = typeof value === 'function';
            const result = await (isFunction ? value(element) : value);
            return { result, isFunction };
          }, params.function);
        } else {
          evalResult = await tab.page.evaluate(async source => {
            const value = eval(`(${source})`);
            const isFunction = typeof value === 'function';
            const result = await (isFunction ? value() : value);
            return { result, isFunction };
          }, params.function);
        }

        const codeExpression = evalResult.isFunction
          ? params.function
          : locator ? `(element) => (${params.function})` : `() => (${params.function})`;
        if (locator)
          response.addCode(`await page.${await generateLocator(locator)}.evaluate(${codeExpression});`);
        else
          response.addCode(`await page.evaluate(${codeExpression});`);

        response.addResult(stringifyResult(evalResult.result));
      });
    } catch (error) {
      response.addError(error instanceof Error ? error.message : String(error));
    }
  },
});

function stringifyResult(result: unknown): string {
  try {
    return JSON.stringify(result, null, 2) ?? 'undefined';
  } catch {
    try {
      return String(result);
    } catch {
      return 'undefined';
    }
  }
}

export default [
  evaluate,
];
