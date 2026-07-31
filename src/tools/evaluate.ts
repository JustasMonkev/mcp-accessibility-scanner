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
    // Half a pair used to fall back to page scope, so `element.textContent`
    // with only a `ref` failed with a bare `element is not defined`.
    if (!!params.ref !== !!params.element)
      throw new Error('Provide both "element" and "ref" to evaluate against an element, or neither to evaluate against the page.');

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
 *
 * The decision is made from the source form and never from the runtime type of
 * the result: `window.open` is an expression that happens to evaluate to a
 * function, and it must be returned rather than called.
 */
export function toFunctionSource(source: string, onElement: boolean): string {
  if (isFunctionSource(source))
    return source;
  // A trailing `;` would turn the expression into a statement.
  const expression = source.replace(/\s*;+\s*$/, '');
  if (!expression.trim())
    throw new Error('The "function" argument is empty. Pass a function such as `() => document.title`, or an expression such as `document.title`.');
  // The parentheses keep an object literal such as `{ a: 1 }` from parsing as a
  // block and a comma expression from splitting into two arguments; the
  // newlines keep a trailing `// comment` from swallowing the closing paren.
  return onElement ? `(element) => (\n${expression}\n)` : `() => (\n${expression}\n)`;
}

function isFunctionSource(source: string): boolean {
  let body = source.slice(skipTrivia(source, 0));
  for (;;) {
    if (/^function\b/.test(body.slice(skipAsyncKeyword(body))))
      return true;
    if (hasArrowHead(body))
      return true;
    // `(() => 1)` and `(function () {})` are function literals inside grouping
    // parentheses. Look inside before concluding this is an expression.
    const inner = stripEnclosingParens(body);
    if (inner === null)
      return false;
    body = inner.slice(skipTrivia(inner, 0));
  }
}

function skipAsyncKeyword(source: string): number {
  const keyword = /^async\b/.exec(source)?.[0];
  return keyword ? skipTrivia(source, keyword.length) : 0;
}

/**
 * Matches the head of an arrow function -- `x =>`, `(a, b) =>`, `async () =>` --
 * without matching a parenthesised expression such as `(a + b)`.
 */
function hasArrowHead(source: string): boolean {
  let offset = skipAsyncKeyword(source);
  if (source[offset] === '(') {
    const end = matchingParen(source, offset);
    // The scanner does not model every parameter-list construct (regex literals
    // and nested template substitutions among them). When the match cannot be
    // found, treat the source as a function: passing a function through is the
    // behaviour that predates expression support, and a wrongly wrapped
    // function silently returns `undefined`, while a wrongly passed-through
    // expression fails loudly.
    if (end === -1)
      return true;
    offset = end + 1;
  } else {
    const identifier = /^[\p{ID_Start}$_][\p{ID_Continue}$]*/u.exec(source.slice(offset))?.[0];
    if (!identifier)
      return false;
    offset += identifier.length;
  }
  return source.startsWith('=>', skipTrivia(source, offset));
}

function stripEnclosingParens(source: string): string | null {
  if (source[0] !== '(')
    return null;
  const end = matchingParen(source, 0);
  // Only a group that wraps the whole source: `(a) => a` closes early and its
  // parentheses are a parameter list, not a group.
  if (end === -1 || skipTrivia(source, end + 1) !== source.length)
    return null;
  return source.slice(1, end);
}

function matchingParen(source: string, start: number): number {
  return matchingDelimiter(source, start, '(', ')');
}

/**
 * Finds the delimiter closing the one at `start`, stepping over comments,
 * strings, template substitutions and regular expression literals so that a
 * bracket inside any of them is not counted.
 */
function matchingDelimiter(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let offset = start; offset < source.length; offset++) {
    const char = source[offset];
    if (char === '/' && (source[offset + 1] === '/' || source[offset + 1] === '*')) {
      const end = skipTrivia(source, offset);
      if (end === offset)
        return -1;
      offset = end - 1;
    } else if (char === '"' || char === '\'' || char === '`') {
      const end = endOfString(source, offset);
      if (end === -1)
        return -1;
      offset = end;
    } else if (char === '/' && startsRegex(source, offset)) {
      const end = endOfRegex(source, offset);
      if (end === -1)
        return -1;
      offset = end;
    } else if (char === open) {
      depth++;
    } else if (char === close) {
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
    const char = source[offset];
    if (char === '\\') {
      offset++;
    } else if (quote === '`' && char === '$' && source[offset + 1] === '{') {
      // A substitution can hold anything, including another template.
      const end = matchingDelimiter(source, offset + 1, '{', '}');
      if (end === -1)
        return -1;
      offset = end;
    } else if (char === quote) {
      return offset;
    }
  }
  return -1;
}

// A slash directly after a value is division; anywhere else it opens a regular
// expression. Parameter defaults are the case that matters here: `(a = /)/)`.
function startsRegex(source: string, offset: number): boolean {
  let index = offset - 1;
  while (index >= 0 && /\s/.test(source[index]))
    index--;
  return index < 0 || !/[\w$)\]]/.test(source[index]);
}

function endOfRegex(source: string, start: number): number {
  let inCharacterClass = false;
  for (let offset = start + 1; offset < source.length; offset++) {
    const char = source[offset];
    if (char === '\\')
      offset++;
    else if (char === '\n')
      return -1;
    else if (inCharacterClass)
      inCharacterClass = char !== ']';
    else if (char === '[')
      inCharacterClass = true;
    else if (char === '/')
      return offset;
  }
  return -1;
}

function skipTrivia(source: string, offset: number): number {
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
