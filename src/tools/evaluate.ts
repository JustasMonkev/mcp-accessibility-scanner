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

import { inspect } from 'util';

import { z } from 'zod';

import { defineTabTool } from './tool.js';
import { generateLocator } from './utils.js';
import { quote } from '../utils/codegen.js';
import { isFunctionSource } from '../utils/jsSource.js';

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

    const locator = params.ref && params.element ? await tab.refLocator({ ref: params.ref, element: params.element }) : undefined;
    const source = toFunctionSource(params.function, !!locator);
    const target = locator ? `page.${await generateLocator(locator)}` : 'page';
    const expression = asBrowserExpression(source);
    // Replay hands Playwright the same function the tool does: one whose
    // toString() is the source, so the browser evaluates and calls it exactly
    // as in the live call. A Node function literal would run parts of the
    // source, such as `.bind(document)`, outside the browser, and an in-page
    // eval wrapper would add an eval call the page can observe.
    response.addCode(`await ${target}.evaluate(Object.assign(() => {}, { toString: () => ${quote(expression)} }));`);

    await tab.waitForCompletion(async () => {
      const func = functionSerializingAs(expression);
      const result = locator ? await locator.evaluate(func) : await tab.page.evaluate(func);
      response.addResult(formatEvaluationResult(result));
    });
  },
});

function formatEvaluationResult(result: unknown): string {
  return canFormatAsJSON(result)
    ? JSON.stringify(result, null, 2)
    : inspect(result, {
      depth: null,
      maxArrayLength: null,
      maxStringLength: null,
      compact: false,
      colors: false,
      customInspect: false,
    });
}

function canFormatAsJSON(value: unknown, parents: readonly object[] = []): boolean {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value) && !Object.is(value, -0);
    case 'object':
      return value === null || hasJSONContents(value, parents);
    default:
      return false;
  }
}

function hasJSONContents(value: object, parents: readonly object[]): boolean {
  const isPlainContainer = Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype;
  const isCircular = parents.includes(value);
  const childParents = [...parents, value];

  return isPlainContainer && !isCircular
    && Object.values(value).every(child => canFormatAsJSON(child, childParents));
}

// Playwright parses a function's source as `(source)` before evaluating it, so a
// trailing line comment would swallow that `)`. Close the group on its own line.
function asBrowserExpression(source: string): string {
  return `(${source}\n)`;
}

function functionSerializingAs(source: string): () => void {
  const func = () => {};
  func.toString = () => source;
  return func;
}

/** @public */
export function toFunctionSource(source: string, onElement: boolean): string {
  if (isFunctionSource(source))
    return source;
  const expression = withoutTrailingSemicolons(source);
  if (!expression.trim())
    throw new Error('The "function" argument is empty. Pass a function such as `() => document.title`, or an expression such as `document.title`.');
  const parameters = onElement ? '(element)' : '()';
  return `${parameters} => (\n${expression}\n)`;
}

function withoutTrailingSemicolons(source: string): string {
  return source.replace(/[\s;]+$/, '');
}

export default [
  evaluate,
];
