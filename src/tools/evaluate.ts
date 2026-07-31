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
  function: z.string().describe('() => { /* code */ } or (element) => { /* code */ } when element is provided. A bare expression such as document.title, or element.textContent when element is provided, is also accepted.'),
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

    const onElement = !!(params.ref && params.element);
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
 */
export function toFunctionSource(source: string, onElement: boolean): string {
  if (isFunctionSource(source))
    return source;
  // The parentheses keep an object literal such as `{ a: 1 }` from parsing as a
  // block, and keep a comma expression from splitting into two arguments.
  return onElement ? `(element) => (${source})` : `() => (${source})`;
}

function isFunctionSource(source: string): boolean {
  const body = source.slice(skipLeadingTrivia(source));
  if (/^(async\b\s*)?function\b/.test(body))
    return true;
  return hasArrowHead(body);
}

/**
 * Matches the head of an arrow function -- `x =>`, `(a, b) =>`, `async () =>` --
 * without matching a parenthesised expression such as `(a + b)`.
 */
function hasArrowHead(source: string): boolean {
  let offset = /^async\b\s*/.exec(source)?.[0].length ?? 0;
  if (source[offset] === '(') {
    const end = matchingParen(source, offset);
    if (end === -1)
      return false;
    offset = end + 1;
  } else {
    const identifier = /^[A-Za-z_$][\w$]*/.exec(source.slice(offset))?.[0];
    if (!identifier)
      return false;
    offset += identifier.length;
  }
  offset += skipLeadingTrivia(source.slice(offset));
  return source.startsWith('=>', offset);
}

function matchingParen(source: string, start: number): number {
  let depth = 0;
  for (let offset = start; offset < source.length; offset++) {
    const char = source[offset];
    if (char === '"' || char === '\'' || char === '`') {
      const end = endOfString(source, offset);
      if (end === -1)
        return -1;
      offset = end;
    } else if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (!depth)
        return offset;
    }
  }
  return -1;
}

function endOfString(source: string, start: number): number {
  const quote = source[start];
  for (let offset = start + 1; offset < source.length; offset++) {
    if (source[offset] === '\\')
      offset++;
    else if (source[offset] === quote)
      return offset;
  }
  return -1;
}

function skipLeadingTrivia(source: string): number {
  let offset = 0;
  for (;;) {
    while (offset < source.length && /\s/.test(source[offset]))
      offset++;
    if (source.startsWith('//', offset)) {
      const lineEnd = source.indexOf('\n', offset);
      if (lineEnd === -1)
        return source.length;
      offset = lineEnd + 1;
    } else if (source.startsWith('/*', offset)) {
      const commentEnd = source.indexOf('*/', offset + 2);
      if (commentEnd === -1)
        return source.length;
      offset = commentEnd + 2;
    } else {
      return offset;
    }
  }
}

export default [
  evaluate,
];
