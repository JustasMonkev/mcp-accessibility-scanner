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
import * as javascript from '../utils/codegen.js';
import { generateLocator } from './utils.js';
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

    const locator = params.ref ? await tab.refLocator({ ref: params.ref, element: params.element! }) : undefined;
    const source = toFunctionSource(params.function, !!locator);
    const target = locator ? `page.${await generateLocator(locator)}` : 'page';
    response.addCode(`await ${target}.evaluate(${javascript.quote(source)});`);

    await tab.waitForCompletion(async () => {
      const func = functionSerializingAs(source);
      const result = locator ? await locator.evaluate(func) : await tab.page.evaluate(func);
      response.addResult(formatEvaluationResult(result));
    });
  },
});

function formatEvaluationResult(result: unknown): string {
  if (isJSONValue(result))
    return JSON.stringify(result, null, 2);
  return inspect(result, {
    depth: null,
    maxArrayLength: null,
    maxStringLength: null,
    compact: false,
    colors: false,
    customInspect: false,
  });
}

function isJSONValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number')
    return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== 'object' || ancestors.has(value))
    return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
    return false;
  ancestors.add(value);
  try {
    return Object.values(value).every(item => isJSONValue(item, ancestors));
  } finally {
    ancestors.delete(value);
  }
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
