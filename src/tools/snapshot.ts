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

import RE2 from 're2';
import { z } from 'zod';
import { defineTabTool, defineTool } from './tool.js';
import * as javascript from '../utils/codegen.js';
import { generateLocator } from './utils.js';
import { axeTagValues, dedupeAxeNodes, runAxeScan } from './axe.js';
import { truncateDataUrls } from '../utils/dataUrl.js';

const scanPageSchema = z.object({
  violationsTag: z
      .array(z.enum(axeTagValues))
      .min(1)
      .default([...axeTagValues])
      .describe('Array of tags to filter violations by. If not specified, all violations are returned.')
});

const snapshotSchema = z.object({
  compress: z.boolean().optional().describe('Collapse repeated non-interactive ARIA nodes in large snapshots when a repeated structural pattern appears more than 100 times. Keeps the first 10 examples of each collapsed pattern. Use browser_evaluate() to retrieve the full list if needed.'),
});

const findSchema = z.object({
  text: z.string().optional().describe('Plain text to search for in the page snapshot (case-insensitive substring match). Provide either text or regex, not both.'),
  regex: z.string().optional().refine(value => !value || isValidRegex(value), { message: 'Invalid regular expression' }).describe('Regular expression to search for in the page snapshot. Matching is case-sensitive by default; wrap the pattern in slashes to add flags, e.g. "/error/i" for case-insensitive. Provide either text or regex, not both.'),
}).superRefine((params, context) => {
  if (!params.text && !params.regex)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide either "text" or "regex" to search for.' });
  if (params.text && params.regex)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide only one of "text" or "regex", not both.' });
});

const scanPage = defineTool({
  capability: 'core',
  schema: {
    name: 'scan_page',
    title: 'Scan page for accessibility violations',
    description: 'Scan the current page for accessibility violations using Axe',
    inputSchema: scanPageSchema,
    type: 'destructive',
  },

  handle: async (context, params, response) => {
    const tab = context.currentTabOrDie();
    const results = await runAxeScan(tab.page, params.violationsTag);

    response.addResult([
      `URL: ${results.url}`,
      '',
      `Violations: ${results.violations.length}, Incomplete: ${results.incomplete.length}, Passes: ${results.passes.length}, Inapplicable: ${results.inapplicable.length}`,
    ].join('\n'));


    results.violations.forEach(violation => {
      const uniqueNodes = dedupeAxeNodes(violation.nodes);

      response.addResult([
        '',
        `Tags : ${violation.tags}`,
        `Violations: ${JSON.stringify(uniqueNodes, null, 2)}`,
      ].join('\n'));
    });
  },
});

const snapshot = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_snapshot',
    title: 'Page snapshot',
    description: 'Capture accessibility snapshot of the current page, this is better than screenshot',
    inputSchema: snapshotSchema,
    type: 'readOnly',
  },

  handle: async (context, params, response) => {
    await context.ensureTab();
    response.setIncludeSnapshot(params.compress);
  },
});

const find = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_find',
    title: 'Find in page snapshot',
    description: 'Search the accessibility snapshot of the current page for text or a regular expression. Returns matching snapshot nodes with a few lines of surrounding context, each shown under its path from the root of the tree.',
    inputSchema: findSchema,
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    if (!params.text && !params.regex) {
      response.addError('Provide either "text" or "regex" to search for.');
      return;
    }
    if (params.text && params.regex) {
      response.addError('Provide only one of "text" or "regex", not both.');
      return;
    }

    let query: string;
    let matches: (line: string) => boolean;
    if (params.regex) {
      const { regex, display } = compileRegex(params.regex);
      query = display;
      matches = line => regex.test(line);
    } else {
      query = `"${params.text}"`;
      const needle = params.text!.toLowerCase();
      matches = line => line.toLowerCase().includes(needle);
    }

    const lines = (await tab.page.ariaSnapshot({ mode: 'ai' })).split('\n');
    const indents = lines.map(indentOf);
    const matchedLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (matches(lines[i]))
        matchedLines.push(i);
    }

    if (!matchedLines.length) {
      response.addResult(`No matches found for ${query}.`);
      return;
    }

    const windows: { start: number, end: number }[] = [];
    for (const line of matchedLines) {
      const start = Math.max(0, line - 3);
      const end = Math.min(lines.length - 1, line + 3);
      const last = windows[windows.length - 1];
      if (last && start <= last.end + 1)
        last.end = Math.max(last.end, end);
      else
        windows.push({ start, end });
    }

    const path = new Set<number>();
    for (const match of matchedLines) {
      path.add(match);
      for (const ancestor of ancestorIndices(lines, indents, match))
        path.add(ancestor);
    }

    const snippets = windows.map(window => {
      const indices = ancestorIndices(lines, indents, window.start);
      for (let i = window.start; i <= window.end; i++)
        indices.push(i);

      const out: string[] = [];
      for (let i = 0; i < indices.length; i++) {
        const index = indices[i];
        if (i > 0 && index > indices[i - 1] + 1 && !path.has(index) && !path.has(indices[i - 1]))
          out.push(' '.repeat(indents[index]) + '...');
        out.push(lines[index]);
      }
      return truncateDataUrls(out.join('\n'));
    });
    const matchWord = matchedLines.length === 1 ? 'match' : 'matches';
    response.addResult(`Found ${matchedLines.length} ${matchWord} for ${query}:\n\n${snippets.join('\n\n----\n\n')}`);
  },
});

function compileRegex(source: string): { regex: RE2, display: string } {
  const literal = /^\/(.*)\/([a-z]*)$/.exec(source);
  const pattern = literal ? literal[1] : source;
  const flags = literal ? literal[2].replace(/g/g, '') : '';
  return {
    regex: new RE2(pattern, flags),
    display: literal ? `/${pattern}/${flags}` : `/${pattern}/`,
  };
}

function isValidRegex(source: string): boolean {
  try {
    compileRegex(source);
    return true;
  } catch {
    return false;
  }
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function ancestorIndices(lines: string[], indents: number[], index: number): number[] {
  const result: number[] = [];
  let indent = indents[index];
  for (let i = index - 1; i >= 0 && indent > 0; i--) {
    if (!lines[i].trim())
      continue;
    if (indents[i] < indent) {
      result.push(i);
      indent = indents[i];
    }
  }
  return result.reverse();
}

export const elementSchema = z.object({
  element: z.string().describe('Human-readable element description used to obtain permission to interact with the element'),
  ref: z.string().describe('Exact target element reference from the page snapshot'),
});

const clickSchema = elementSchema.extend({
  doubleClick: z.boolean().optional().describe('Whether to perform a double click instead of a single click'),
  button: z.enum(['left', 'right', 'middle']).optional().describe('Button to click, defaults to left'),
});

const click = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_click',
    title: 'Click',
    description: 'Perform click on a web page',
    inputSchema: clickSchema,
    type: 'destructive',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();

    const locator = await tab.refLocator(params);
    const button = params.button;
    const buttonAttr = button ? `{ button: '${button}' }` : '';

    if (params.doubleClick)
      response.addCode(`await page.${await generateLocator(locator)}.dblclick(${buttonAttr});`);
    else
      response.addCode(`await page.${await generateLocator(locator)}.click(${buttonAttr});`);


    await tab.waitForCompletion(async () => {
      if (params.doubleClick)
        await locator.dblclick({ button });
      else
        await locator.click({ button });
    });
  },
});

const drag = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_drag',
    title: 'Drag mouse',
    description: 'Perform drag and drop between two elements',
    inputSchema: z.object({
      startElement: z.string().describe('Human-readable source element description used to obtain the permission to interact with the element'),
      startRef: z.string().describe('Exact source element reference from the page snapshot'),
      endElement: z.string().describe('Human-readable target element description used to obtain the permission to interact with the element'),
      endRef: z.string().describe('Exact target element reference from the page snapshot'),
    }),
    type: 'destructive',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();

    const [startLocator, endLocator] = await tab.refLocators([
      { ref: params.startRef, element: params.startElement },
      { ref: params.endRef, element: params.endElement },
    ]);

    await tab.waitForCompletion(async () => {
      await startLocator.dragTo(endLocator);
    });

    response.addCode(`await page.${await generateLocator(startLocator)}.dragTo(page.${await generateLocator(endLocator)});`);
  },
});

const hover = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_hover',
    title: 'Hover mouse',
    description: 'Hover over element on page',
    inputSchema: elementSchema,
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();

    const locator = await tab.refLocator(params);
    response.addCode(`await page.${await generateLocator(locator)}.hover();`);

    await tab.waitForCompletion(async () => {
      await locator.hover();
    });
  },
});

const selectOptionSchema = elementSchema.extend({
  values: z.array(z.string()).describe('Array of values to select in the dropdown. This can be a single value or multiple values.'),
});

const selectOption = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_select_option',
    title: 'Select option',
    description: 'Select an option in a dropdown',
    inputSchema: selectOptionSchema,
    type: 'destructive',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();

    const locator = await tab.refLocator(params);
    response.addCode(`await page.${await generateLocator(locator)}.selectOption(${javascript.formatObject(params.values)});`);

    await tab.waitForCompletion(async () => {
      await locator.selectOption(params.values);
    });
  },
});

export default [
  snapshot,
  find,
  click,
  drag,
  hover,
  selectOption,
  scanPage
];
