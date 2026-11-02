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

import crypto from 'node:crypto';
import fs from 'node:fs';
import RE2 from 're2';
import { z } from 'zod';
import { defineTabTool, defineTool } from './tool.js';
import * as javascript from '../utils/codegen.js';
import { generateLocator } from './utils.js';
import { prepareUploadFiles } from './files.js';
import { axeRuleSchemaShape, axeScanOptions, axeScopeSchemaShape, axeTagValues, dedupeAxeNodes, defaultAxeTags, prepareAxeResults, runAxeScan, unscannedFrameLines } from './axe.js';
import { truncateDataUrls } from '../utils/dataUrl.js';
import { safeIsoTimestampForFileName } from '../utils/fileUtils.js';

import type { AxeViolation } from './axe.js';
import type { Response } from '../response.js';
import type { Tab } from '../tab.js';
import type * as playwright from 'playwright';

const maxAnnotatedElements = 50;

const scanPageSchema = z.object({
  violationsTag: z
      .array(z.enum(axeTagValues))
      .min(1)
      .default([...defaultAxeTags])
      .describe('Axe tags to scan for. Defaults to the WCAG and Section 508 conformance tags, so a default report means "this fails a conformance criterion". The category tags ("cat.*") and "best-practice" also select rules that are not conformance failures, so they must be requested explicitly.'),
  includeIncomplete: z
      .boolean()
      .default(true)
      .describe('Include Axe "incomplete" results — checks Axe could not decide automatically (e.g. contrast over an image). Inspect the page yourself to resolve them.'),
  maxNodesPerViolation: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Maximum nodes reported per rule. Raise it when you need every occurrence of a rule rather than a sample.'),
  annotateScreenshot: z
      .boolean()
      .default(false)
      .describe(`Capture a full-page PNG with every violating element outlined and labelled with its rule ids, then remove the markers. Off by default because screenshots are expensive. At most ${maxAnnotatedElements} elements are marked; nodes that are hidden, zero-size, off-canvas, or inside an iframe cannot be marked and are reported as skipped.`),
  ...axeScopeSchemaShape,
  ...axeRuleSchemaShape,
});

const snapshotSchema = z.object({
  compress: z.boolean().optional().describe('Collapse repeated non-interactive ARIA nodes in large snapshots when a repeated structural pattern appears more than 100 times. Keeps the first 10 examples of each collapsed pattern. Use browser_evaluate() to retrieve the full list if needed.'),
  boxes: z.boolean().optional().describe('Include each element\'s bounding box as [box=x,y,width,height]. Coordinates are viewport-relative, in CSS pixels (Element.getBoundingClientRect). Overrides snapshot.boxes for this call.'),
});

const findSchema = z.object({
  text: z.string().optional().describe('Plain text to search for in the page snapshot (case-insensitive substring match). Provide either text or regex, not both.'),
  regex: z.string().optional().refine(value => !value || isValidRegex(value), { message: 'Invalid regular expression' }).describe('Regular expression to search for in the page snapshot. Matching is case-sensitive by default; wrap the pattern in slashes to add flags, e.g. "/error/i" for case-insensitive. Provide either text or regex, not both.'),
  maxResults: z.number().int().min(1).optional().describe('Maximum number of matching lines to return inline or save to a file. Must be a positive integer. Defaults to returning all matches.'),
  filename: z.string().optional().describe('Save results to this filename in the configured output directory instead of returning them inline. Existing files are never overwritten. The same maxResults limit applies.'),
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
    const results = await runAxeScan(tab.page, axeScanOptions(params));

    const annotationLines = params.annotateScreenshot
      ? await annotateAndScreenshot(tab, results.violations, response)
      : [];

    const incompleteCount = params.includeIncomplete ? `Incomplete: ${results.incomplete.length}, ` : '';
    response.addResult([
      `URL: ${results.url}`,
      '',
      `Violations: ${results.violations.length}, ${incompleteCount}Passes: ${results.passes.length}, Inapplicable: ${results.inapplicable.length}`,
      ...unscannedFrameLines(results.unscannedFrames),
      ...annotationLines,
    ].join('\n'));

    for (const line of renderAxeRules(prepareAxeResults(results.violations, params.maxNodesPerViolation), violationRuleStyle))
      response.addResult(line);

    if (params.includeIncomplete && results.incomplete.length) {
      const incomplete = prepareAxeResults(results.incomplete, params.maxNodesPerViolation);
      response.addResult(`\nIncomplete (needs review — Axe could not decide, verify these on the page): ${incomplete.trimmed.length} rule(s)`);
      for (const line of renderAxeRules(incomplete, incompleteRuleStyle))
        response.addResult(line);
    }
  },
});

type AxeRuleStyle = { kind: string, nodesLabel: string, showTags: boolean };
const violationRuleStyle: AxeRuleStyle = { kind: 'Violation', nodesLabel: 'Violations', showTags: true };
const incompleteRuleStyle: AxeRuleStyle = { kind: 'Incomplete', nodesLabel: 'Nodes', showTags: false };

function renderAxeRules(rules: ReturnType<typeof prepareAxeResults>, { kind, nodesLabel, showTags }: AxeRuleStyle): string[] {
  return rules.trimmed.map((rule, index) => [
    '',
    `${kind} rule: ${rule.id} (${rule.impact ?? 'unknown'}) — ${rule.help}`,
    `Help: ${rule.helpUrl}`,
    ...(showTags ? [`Tags : ${rule.tags}`] : []),
    `${nodesLabel}${nodeCountSuffix(rule.nodes.length, rules.deduped[index].nodes.length)}: ${JSON.stringify(rule.nodes, null, 2)}`,
  ].join('\n'));
}

function nodeCountSuffix(shown: number, total: number): string {
  return shown < total ? ` (showing ${shown} of ${total} nodes, raise maxNodesPerViolation for the rest)` : '';
}

type AnnotationMark = { path: string[], labels: string[] };

function shadowPathOf(target: unknown[]): string[] | undefined {
  const isInsideIframe = target.length !== 1;
  if (isInsideIframe)
    return undefined;
  const path: unknown[] = [target[0]].flat(Infinity);
  if (!path.length || !path.every(step => typeof step === 'string'))
    return undefined;
  return path as string[];
}

function buildAnnotationPlan(violations: AxeViolation[]) {
  const marksByElement = new Map<string, AnnotationMark>();
  let totalNodes = 0;
  let unreachableNodes = 0;
  let queuedNodes = 0;
  for (const violation of violations) {
    for (const node of dedupeAxeNodes(violation.nodes)) {
      totalNodes++;
      const path = shadowPathOf(node.target ?? []);
      if (!path) {
        unreachableNodes++;
        continue;
      }
      const key = JSON.stringify(path);
      const existing = marksByElement.get(key);
      if (existing)
        existing.labels.push(violation.id);
      else if (marksByElement.size < maxAnnotatedElements)
        marksByElement.set(key, { path, labels: [violation.id] });
      else
        continue;
      queuedNodes++;
    }
  }
  return { marks: [...marksByElement.values()], totalNodes, unreachableNodes, queuedNodes };
}

async function annotateAndScreenshot(tab: Tab, violations: AxeViolation[], response: Response): Promise<string[]> {
  const { marks, totalNodes, unreachableNodes, queuedNodes } = buildAnnotationPlan(violations);
  const fileName = await tab.context.outputFile(`scan-page-annotated-${safeIsoTimestampForFileName()}.png`);
  const layerId = `mcp-a11y-annotation-layer-${crypto.randomUUID()}`;
  let markedNodes = 0;
  try {
    markedNodes = await drawAnnotations(tab.page, layerId, marks);
    await tab.page.screenshot({ path: fileName, fullPage: true });
  } finally {
    await removeAnnotations(tab.page, layerId);
  }

  response.addFileResourceLink(fileName, {
    name: 'scan-page-annotated-screenshot',
    title: 'Annotated violation screenshot',
    description: 'Full-page screenshot with violating elements outlined and labelled with their rule id.',
    mimeType: 'image/png',
  });

  const truncatedNodes = totalNodes - unreachableNodes - queuedNodes;
  const invisibleNodes = queuedNodes - markedNodes;
  return [
    '',
    `Annotated screenshot: ${response.formatFilePath(fileName)}`,
    `Marked ${markedNodes} of ${totalNodes} violating nodes.`,
    ...(markedNodes < totalNodes ? [
      `Not marked: ${truncatedNodes} over the ${maxAnnotatedElements}-element annotation limit, ${invisibleNodes} hidden, zero-size or off-canvas, ${unreachableNodes} inside an iframe.`,
    ] : []),
  ];
}

async function removeAnnotations(page: playwright.Page, layerId: string): Promise<void> {
  await page.evaluate(id => {
    const layer = document.getElementById(id) as (HTMLElement & { mcpPausedAnimations?: Animation[] }) | null;
    layer?.mcpPausedAnimations?.forEach(animation => animation.play());
    layer?.remove();
  }, layerId);
}

async function drawAnnotations(page: playwright.Page, layerId: string, marks: AnnotationMark[]): Promise<number> {
  return await page.evaluate(({ marks, layerId }) => {
    const probeSizePx = 100;
    const markerColor = '#e11d48';

    function freezeRunningAnimations(): Animation[] {
      const running = document.getAnimations().filter(animation => animation.playState === 'running');
      for (const animation of running) {
        animation.pause();
        const completePendingPauseSynchronously = animation.currentTime;
        animation.currentTime = completePendingPauseSynchronously;
      }
      return running;
    }

    function importantDeclarations(css: string): string {
      return css.replace(/;/g, '!important;');
    }

    function promoteToTopLayer(element: HTMLElement) {
      try {
        element.popover = 'manual';
        element.showPopover();
      } catch {
        element.removeAttribute('popover');
      }
    }

    function resolveThroughShadowRoots(path: string[]): Element | null {
      let scope: Document | ShadowRoot | Element = document;
      let element: Element | null = null;
      for (const selector of path) {
        element = scope.querySelector(selector);
        if (!element)
          return null;
        scope = element.shadowRoot ?? element;
      }
      return element;
    }

    function measure(path: string[]): DOMRect | undefined {
      try {
        return resolveThroughShadowRoots(path)?.getBoundingClientRect();
      } catch {
        return undefined;
      }
    }

    function isInsideDocument(rect: DOMRect, pageWidth: number, pageHeight: number): boolean {
      return rect.right + window.scrollX > 0 && rect.bottom + window.scrollY > 0
        && rect.left + window.scrollX < pageWidth && rect.top + window.scrollY < pageHeight;
    }

    const layer = Object.assign(document.createElement('div'), { mcpPausedAnimations: freezeRunningAnimations() });
    layer.id = layerId;
    layer.style.cssText = importantDeclarations(`display:block;position:absolute;left:0;top:0;right:auto;bottom:auto;margin:0;border:0;padding:0;background:none;overflow:visible;width:${probeSizePx}px;height:${probeSizePx}px;z-index:2147483647;pointer-events:none;visibility:visible;opacity:1;transform:none;filter:none;clip-path:none;animation:none;transition:none;`);
    const markerRoot = layer.attachShadow({ mode: 'open' });
    document.body.appendChild(layer);
    promoteToTopLayer(layer);

    const origin = layer.getBoundingClientRect();
    const scaleX = origin.width / probeSizePx || 1;
    const scaleY = origin.height / probeSizePx || 1;
    layer.style.setProperty('width', '0px', 'important');
    layer.style.setProperty('height', '0px', 'important');
    const pageWidth = document.documentElement.scrollWidth * scaleX;
    const pageHeight = document.documentElement.scrollHeight * scaleY;

    let marked = 0;
    for (const mark of marks) {
      const rect = measure(mark.path);
      if (!rect || rect.width === 0 || rect.height === 0 || !isInsideDocument(rect, pageWidth, pageHeight))
        continue;
      const left = (rect.left - origin.left) / scaleX;
      const top = (rect.top - origin.top) / scaleY;
      const ring = document.createElement('div');
      ring.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${rect.width / scaleX}px;height:${rect.height / scaleY}px;overflow:hidden;box-shadow:inset 0 0 0 3px ${markerColor};`;
      const label = document.createElement('span');
      label.style.cssText = `position:absolute;left:${left}px;top:${top}px;background:${markerColor};color:#fff;padding:0 4px;font:11px/1.4 sans-serif;white-space:nowrap;`;
      label.textContent = mark.labels.join(', ');
      markerRoot.append(ring, label);
      marked += mark.labels.length;
    }
    return marked;
  }, { marks, layerId });
}

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
    response.setIncludeSnapshot(params.compress, params.boxes);
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
    const { query, matches } = findMatcher(params);
    const lines = (await tab.page.ariaSnapshot({ mode: 'ai' })).split('\n');
    const matchedLines = lines.flatMap((line, index) => matches(line) ? [index] : []);
    if (!matchedLines.length) {
      await writeFindResult(tab, params.filename, response, `No matches found for ${query}.`);
      return;
    }

    const shownMatches = matchedLines.slice(0, params.maxResults ?? matchedLines.length);
    const snippets = renderFindSnippets(lines, shownMatches);
    const matchWord = matchedLines.length === 1 ? 'match' : 'matches';
    const header = shownMatches.length < matchedLines.length
      ? `Found ${matchedLines.length} ${matchWord} for ${query} (showing first ${shownMatches.length}):`
      : `Found ${matchedLines.length} ${matchWord} for ${query}:`;
    await writeFindResult(tab, params.filename, response, `${header}\n\n${snippets.join('\n\n----\n\n')}`);
  },
});

const findContextLines = 3;

function findMatcher(params: { text?: string, regex?: string }): { query: string, matches: (line: string) => boolean } {
  if (params.regex) {
    const { regex, display } = compileRegex(params.regex);
    return { query: display, matches: line => regex.test(line) };
  }
  const needle = params.text!.toLowerCase();
  return { query: `"${params.text}"`, matches: line => line.toLowerCase().includes(needle) };
}

function renderFindSnippets(lines: string[], shownMatches: number[]): string[] {
  const indents = lines.map(indentOf);
  const parents = parentIndices(lines, indents);
  const pathToMatches = new Set<number>();
  for (const match of shownMatches)
    addPath(pathToMatches, parents, match);

  return mergedContextWindows(shownMatches, lines.length).map(window => {
    const indices = [...ancestorIndices(parents, window.start), ...range(window.start, window.end)];
    const out: string[] = [];
    indices.forEach((index, position) => {
      const previous = indices[position - 1];
      const skippedLines = position > 0 && index > previous + 1;
      if (skippedLines && !pathToMatches.has(index) && !pathToMatches.has(previous))
        out.push(' '.repeat(indents[index]) + '...');
      out.push(lines[index]);
    });
    return truncateDataUrls(out.join('\n'));
  });
}

function mergedContextWindows(matches: number[], lineCount: number): { start: number, end: number }[] {
  const windows: { start: number, end: number }[] = [];
  for (const line of matches) {
    const start = Math.max(0, line - findContextLines);
    const end = Math.min(lineCount - 1, line + findContextLines);
    const last = windows[windows.length - 1];
    if (last && start <= last.end + 1)
      last.end = Math.max(last.end, end);
    else
      windows.push({ start, end });
  }
  return windows;
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}

async function writeFindResult(tab: Tab, filename: string | undefined, response: Response, result: string) {
  if (filename === undefined) {
    response.addResult(result);
    return;
  }
  const file = await tab.context.outputFile(filename, true);
  response.deleteFileOnError(file);
  await fs.promises.writeFile(file, result, 'utf-8');
  response.addFileResourceLink(file, { title: 'Find results', mimeType: 'text/plain' });
  response.addResult(`Saved find results as ${response.formatFilePath(file)}`);
}

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

function parentIndices(lines: string[], indents: number[]): number[] {
  const parents = new Array<number>(lines.length).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    while (stack.length && indents[stack[stack.length - 1]] >= indents[i])
      stack.pop();
    parents[i] = stack[stack.length - 1] ?? -1;
    if (lines[i].trim())
      stack.push(i);
  }
  return parents;
}

function addPath(path: Set<number>, parents: number[], index: number) {
  for (let current = index; current !== -1 && !path.has(current); current = parents[current])
    path.add(current);
}

function ancestorIndices(parents: number[], index: number): number[] {
  const result: number[] = [];
  for (let current = parents[index]; current !== -1; current = parents[current])
    result.push(current);
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
    const method = params.doubleClick ? 'dblclick' : 'click';
    response.addCode(`await page.${await generateLocator(locator)}.${method}(${buttonAttr});`);

    await tab.waitForCompletion(async () => {
      await locator[method]({ button });
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

const dropSchema = elementSchema.extend({
  paths: z.array(z.string()).optional().describe('The absolute paths of the files to drop onto the element. Can be a single file or multiple files.'),
  data: z.record(z.string(), z.string()).optional().describe('Clipboard-like payload to drop onto the element, as a map of mime type to value, for example { "text/plain": "hello", "text/uri-list": "https://example.com" }'),
}).superRefine((params, context) => {
  if (!params.paths?.length && !Object.keys(params.data ?? {}).length)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide "paths", "data" or both to describe what to drop onto the element.' });
});

const drop = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_drop',
    title: 'Drop onto element',
    description: 'Simulate an external drag and drop of files or clipboard-like data onto an element',
    inputSchema: dropSchema,
    type: 'destructive',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();

    const payload: { files?: string[], data?: Record<string, string> } = {};
    if (params.paths?.length)
      payload.files = params.paths;
    if (Object.keys(params.data ?? {}).length)
      payload.data = params.data;

    const files = payload.files ? await prepareUploadFiles(tab.context.config, payload.files) : undefined;
    const locator = await tab.refLocator(params);
    response.addCode(`await page.${await generateLocator(locator)}.drop(${JSON.stringify(payload)});`);

    await tab.waitForCompletion(async () => {
      await locator.drop(files ? { ...payload, files } : payload);
    });
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
  drop,
  hover,
  selectOption,
  scanPage
];
