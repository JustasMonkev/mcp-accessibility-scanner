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
import RE2 from 're2';
import { z } from 'zod';
import { defineTabTool, defineTool } from './tool.js';
import * as javascript from '../utils/codegen.js';
import { generateLocator } from './utils.js';
import { axeRuleSchemaShape, axeScopeSchemaShape, axeTagValues, dedupeAxeNodes, defaultAxeTags, prepareAxeResults, runAxeScan, unscannedFrameLines } from './axe.js';
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
    const results = await runAxeScan(tab.page, {
      tags: params.violationsTag,
      rules: params.withRules,
      disableRules: params.disableRules,
      include: params.includeSelectors,
      exclude: params.excludeSelectors,
    });

    const annotationLines = params.annotateScreenshot
      ? await annotateAndScreenshot(tab, results.violations, response)
      : [];

    // Omit the incomplete count entirely when it was not requested, matching
    // audit_site: a bare "Incomplete: 3" with no rule blocks below reads as
    // findings that were dropped from the report.
    const incompleteCount = params.includeIncomplete ? `Incomplete: ${results.incomplete.length}, ` : '';
    response.addResult([
      `URL: ${results.url}`,
      '',
      `Violations: ${results.violations.length}, ${incompleteCount}Passes: ${results.passes.length}, Inapplicable: ${results.inapplicable.length}`,
      ...unscannedFrameLines(results.unscannedFrames),
      ...annotationLines,
    ].join('\n'));


    // Trimmed nodes drop axe's any/all/none check arrays, which are the bulk of
    // a raw result — a content-heavy page otherwise serializes to ~1MB here.
    const { deduped, trimmed: violations } = prepareAxeResults(results.violations, params.maxNodesPerViolation);
    violations.forEach((violation, index) => {
      response.addResult([
        '',
        `Violation rule: ${violation.id} (${violation.impact ?? 'unknown'}) — ${violation.help}`,
        `Help: ${violation.helpUrl}`,
        `Tags : ${violation.tags}`,
        `Violations${nodeCountSuffix(violation.nodes.length, deduped[index].nodes.length)}: ${JSON.stringify(violation.nodes, null, 2)}`,
      ].join('\n'));
    });

    if (params.includeIncomplete && results.incomplete.length) {
      const incomplete = prepareAxeResults(results.incomplete, params.maxNodesPerViolation);
      response.addResult([
        '',
        `Incomplete (needs review — Axe could not decide, verify these on the page): ${incomplete.trimmed.length} rule(s)`,
      ].join('\n'));
      incomplete.trimmed.forEach((item, index) => {
        response.addResult([
          '',
          `Incomplete rule: ${item.id} (${item.impact ?? 'unknown'}) — ${item.help}`,
          `Help: ${item.helpUrl}`,
          `Nodes${nodeCountSuffix(item.nodes.length, incomplete.deduped[index].nodes.length)}: ${JSON.stringify(item.nodes, null, 2)}`,
        ].join('\n'));
      });
    }
  },
});

// Node lists are capped by maxNodesPerViolation; say so rather than letting a
// rule with 40 occurrences look identical to one with 10.
function nodeCountSuffix(shown: number, total: number): string {
  return shown < total ? ` (showing ${shown} of ${total} nodes, raise maxNodesPerViolation for the rest)` : '';
}


/**
 * Draws a labelled outline over every violating element, screenshots the page,
 * then removes the markers. Returns the lines to append to the tool result.
 */
async function annotateAndScreenshot(tab: Tab, violations: AxeViolation[], response: Response): Promise<string[]> {
  const marks = new Map<string, AnnotationMark>();
  let totalNodes = 0;
  let unreachableNodes = 0;
  let queuedNodes = 0;
  for (const violation of violations) {
    for (const node of dedupeAxeNodes(violation.nodes)) {
      totalNodes++;
      const target = node.target ?? [];
      // A target with more than one step is nested inside an iframe, which
      // page.evaluate cannot reach from the top document. A single step may
      // still be an array — that is a path through open shadow roots, which we
      // can walk, so flatten it rather than rejecting it as cross-frame.
      const path = (target.length === 1 ? [target[0]].flat(Infinity) : []) as unknown[];
      if (!path.length || path.some(step => typeof step !== 'string')) {
        unreachableNodes++;
        continue;
      }
      const key = JSON.stringify(path);
      const existing = marks.get(key);
      // One element commonly fails several rules. Keep a single box listing
      // every rule id instead of stacking boxes whose labels hide each other.
      if (existing)
        existing.labels.push(violation.id);
      else if (marks.size < maxAnnotatedElements)
        marks.set(key, { path: path as string[], labels: [violation.id] });
      else
        continue;
      queuedNodes++;
    }
  }

  const fileName = await tab.context.outputFile(`scan-page-annotated-${safeIsoTimestampForFileName()}.png`);
  // Unique per scan: cleanup resolves the id document-order first, so a fixed
  // id would delete the audited page's own element if it already used it.
  const layerId = `mcp-a11y-annotation-layer-${crypto.randomUUID()}`;
  let markedNodes = 0;
  try {
    markedNodes = await drawAnnotations(tab.page, layerId, [...marks.values()]);
    await tab.page.screenshot({ path: fileName, fullPage: true });
  } finally {
    await tab.page.evaluate(id => {
      const layer = document.getElementById(id) as (HTMLElement & { mcpPausedAnimations?: Animation[] }) | null;
      // Restart only what drawing paused, so a page that paused its own
      // animations still has them paused afterwards.
      layer?.mcpPausedAnimations?.forEach(animation => animation.play());
      layer?.remove();
    }, layerId);
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
    `Annotated screenshot: ${fileName}`,
    `Marked ${markedNodes} of ${totalNodes} violating nodes.`,
    ...(markedNodes < totalNodes ? [
      `Not marked: ${truncatedNodes} over the ${maxAnnotatedElements}-element annotation limit, ${invisibleNodes} hidden, zero-size or off-canvas, ${unreachableNodes} inside an iframe.`,
    ] : []),
  ];
}

type AnnotationMark = { path: string[], labels: string[] };

async function drawAnnotations(page: playwright.Page, layerId: string, marks: AnnotationMark[]): Promise<number> {
  return await page.evaluate(({ marks, layerId }) => {
    // Playwright leaves animations running, so a target that is moving would
    // drift between the measurement below and the screenshot and leave its
    // marker behind. The cleanup evaluate resumes exactly these.
    const paused = document.getAnimations().filter(animation => animation.playState === 'running');
    for (const animation of paused)
      animation.pause();

    const layer = document.createElement('div') as HTMLDivElement & { mcpPausedAnimations?: Animation[] };
    layer.id = layerId;
    layer.mcpPausedAnimations = paused;
    // Absolutely positioned and out of flow, so the layer can never reflow the
    // page we are about to photograph. It starts 100px square as a probe: the
    // rendered size of a known length reveals the scale a CSS zoom or an
    // ancestor transform applies to every length we write inside the layer.
    // The overrides after `display` neutralise the UA popover stylesheet.
    // Every declaration is !important: an important inline declaration outranks
    // any author rule, so page CSS such as `div { display: none !important }`
    // or `[popover] { opacity: 0 }` cannot hide the layer we are counting on.
    layer.style.cssText = 'display:block;position:absolute;left:0;top:0;right:auto;bottom:auto;margin:0;border:0;padding:0;background:none;overflow:visible;width:100px;height:100px;z-index:2147483647;pointer-events:none;visibility:visible;opacity:1;transform:none;filter:none;clip-path:none;animation:none;transition:none;'
        .replace(/;/g, '!important;');
    // The markers live in a shadow root so page selectors cannot reach them at
    // all; only inherited properties cross the boundary, and the host resets
    // those it cares about above.
    const root = layer.attachShadow({ mode: 'open' });
    document.body.appendChild(layer);
    // A manual popover joins the top layer, which paints above any open dialog,
    // popover or fullscreen element — those sit above every z-index otherwise.
    try {
      layer.popover = 'manual';
      layer.showPopover();
    } catch {
      // Engine without popover support: markers stay below top-layer content.
      layer.removeAttribute('popover');
    }
    // The layer's own rect tells us where its (0,0) landed, which is not the
    // document origin when an ancestor is itself positioned.
    const origin = layer.getBoundingClientRect();
    // ponytail: uniform scale only — a rotated or skewed ancestor still
    // misplaces markers. Fixing that needs the full transform matrix.
    const scaleX = origin.width / 100 || 1;
    const scaleY = origin.height / 100 || 1;
    layer.style.setProperty('width', '0px', 'important');
    layer.style.setProperty('height', '0px', 'important');
    // A full-page screenshot is clipped to the document box, so anything drawn
    // outside it is absent from the PNG however large its rectangle is.
    const pageWidth = document.documentElement.scrollWidth * scaleX;
    const pageHeight = document.documentElement.scrollHeight * scaleY;

    let marked = 0;
    for (const mark of marks) {
      let rect: DOMRect | undefined;
      try {
        // Each step after the first descends into an open shadow root.
        let root: Document | ShadowRoot | Element = document;
        let element: Element | null = null;
        for (const step of mark.path) {
          element = root.querySelector(step);
          if (!element)
            break;
          root = element.shadowRoot ?? element;
        }
        rect = element?.getBoundingClientRect();
      } catch {
        // Axe can report a selector this browser refuses to parse; skip it.
        continue;
      }
      if (!rect || rect.width === 0 || rect.height === 0)
        continue;
      // Off-canvas elements (the `left:-9999px` visually-hidden idiom) have a
      // real rectangle but never reach the PNG, so they are not marked.
      if (rect.right + window.scrollX <= 0 || rect.bottom + window.scrollY <= 0
        || rect.left + window.scrollX >= pageWidth || rect.top + window.scrollY >= pageHeight)
        continue;
      const left = (rect.left - origin.left) / scaleX;
      const top = (rect.top - origin.top) / scaleY;
      const box = document.createElement('div');
      // The ring is clipped to the element's own box (inset ring, overflow
      // hidden) so it cannot extend the scrollable area or add scrollbars.
      box.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${rect.width / scaleX}px;height:${rect.height / scaleY}px;overflow:hidden;box-shadow:inset 0 0 0 3px #e11d48;`;
      // The label is a sibling of the ring, not a child: inside it the box's
      // overflow:hidden clipped the rule ids away on any element smaller than
      // its own label, while the node still counted as labelled.
      const label = document.createElement('span');
      label.style.cssText = `position:absolute;left:${left}px;top:${top}px;background:#e11d48;color:#fff;padding:0 4px;font:11px/1.4 sans-serif;white-space:nowrap;`;
      label.textContent = mark.labels.join(', ');
      root.append(box, label);
      // Every rule that named this element is now visible on its one box.
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

    const parents = parentIndices(lines, indents);
    const path = new Set<number>();
    for (const match of matchedLines)
      addPath(path, parents, match);

    const snippets = windows.map(window => {
      const indices = ancestorIndices(parents, window.start);
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

    // The schema guarantees at least one of them is non-empty.
    const payload: { files?: string[], data?: Record<string, string> } = {};
    if (params.paths?.length)
      payload.files = params.paths;
    if (Object.keys(params.data ?? {}).length)
      payload.data = params.data;

    const locator = await tab.refLocator(params);
    response.addCode(`await page.${await generateLocator(locator)}.drop(${JSON.stringify(payload)});`);

    await tab.waitForCompletion(async () => {
      // `drop` rejects when the target's dragover listener never calls
      // preventDefault(), which is Playwright's way of saying the element does
      // not accept the payload.
      await locator.drop(payload);
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
