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
import { isFunctionSource } from '../utils/jsSource.js';

import type * as playwright from 'playwright';

const evaluateSchema = z.object({
  function: z.string().describe('() => { /* code */ } or (element) => { /* code */ } when element is provided. A bare expression such as document.title, or element.textContent when element is provided, is also accepted.'),
  element: z.string().optional().describe('Human-readable element description used to obtain permission to interact with the element'),
  ref: z.string().optional().describe('Exact target element reference from the page snapshot'),
}).refine(data => {
  return !!data.element === !!data.ref;
}, {
  message: 'Both element and ref must be provided or neither.',
  path: ['ref', 'element'],
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

    // The schema pairs them, so one implies the other.
    const onElement = !!params.ref;
    const source = toFunctionSource(params.function, onElement);

    let locator: playwright.Locator | undefined;
    if (onElement) {
      locator = await tab.refLocator({ ref: params.ref!, element: params.element! });
      response.addCode(`await page.${await generateLocator(locator)}.evaluate(${javascript.quote(source)});`);
    } else {
      response.addCode(`await page.evaluate(${javascript.quote(source)});`);
    }

    await tab.waitForCompletion(async () => {
      // playwright-core 1.59 removed the private `_evaluateFunction` helper
      // (microsoft/playwright#39646). The public `evaluate()` serializes its
      // argument via `Function.prototype.toString`, so hand it an empty function
      // whose `toString()` returns the user-supplied source instead.
      const func = new Function() as any;
      func.toString = () => source;
      const result = locator ? await locator.evaluate(func) : await tab.page.evaluate(func);
      response.addResult(JSON.stringify(result, null, 2) || 'undefined');
    });
  },
});

/**
 * `evaluate()` needs a function, but callers routinely pass a bare expression
 * such as `document.title`. Wrap anything that is not already a function form.
 *
 * The decision is made from the source form and never from the runtime type of
 * the result: `window.open` is an expression that happens to evaluate to a
 * function, and it must be returned rather than called.
 *
 * @public
 */
export function toFunctionSource(source: string, onElement: boolean): string {
  if (isFunctionSource(source))
    return source;
  // A trailing `;` would turn the expression into a statement.
  const expression = source.replace(/[\s;]+$/, '');
  if (!expression.trim())
    throw new Error('The "function" argument is empty. Pass a function such as `() => document.title`, or an expression such as `document.title`.');
  // The parentheses keep an object literal such as `{ a: 1 }` from parsing as a
  // block and a comma expression from splitting into two arguments; the
  // newlines keep a trailing `// comment` from swallowing the closing paren.
  return onElement ? `(element) => (\n${expression}\n)` : `() => (\n${expression}\n)`;
}

export default [
  evaluate,
];
