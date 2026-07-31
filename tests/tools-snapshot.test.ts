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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import type { JSONSchema7 } from 'json-schema';
import snapshotTools from '../src/tools/snapshot.js';
import { toMcpTool } from '../src/mcp/tool.js';
import * as axe from '../src/tools/axe.js';

describe('Snapshot Tools', () => {
  const snapshotTool = snapshotTools.find(tool => tool.schema.name === 'browser_snapshot')!;
  const findTool = snapshotTools.find(tool => tool.schema.name === 'browser_find')!;

  it('should expose browser_snapshot with optional compression', () => {
    const mcpTool = toMcpTool(snapshotTool.schema);
    const jsonSchema = mcpTool.inputSchema as JSONSchema7;
    const compressSchema = jsonSchema.properties?.compress as JSONSchema7;

    expect(snapshotTool).toBeDefined();
    expect(snapshotTool.schema.type).toBe('readOnly');
    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.required ?? []).toEqual([]);
    expect(compressSchema.type).toBe('boolean');
    expect(compressSchema.description).toContain('more than 100 times');
    expect(snapshotTool.schema.inputSchema.parse({})).toEqual({});
    expect(snapshotTool.schema.inputSchema.parse({ compress: true })).toEqual({ compress: true });
    expect(snapshotTool.schema.inputSchema.parse({ compress: false })).toEqual({ compress: false });
  });

  it('should request the current snapshot flow with compression disabled by default', async () => {
    const context = {
      ensureTab: vi.fn().mockResolvedValue(undefined),
    };
    const response = {
      setIncludeSnapshot: vi.fn(),
    };

    await snapshotTool.handle(context as any, {}, response as any);

    expect(context.ensureTab).toHaveBeenCalled();
    expect(response.setIncludeSnapshot).toHaveBeenCalledWith(undefined);
  });

  it('should pass the compression option to the snapshot response', async () => {
    const context = {
      ensureTab: vi.fn().mockResolvedValue(undefined),
    };
    const response = {
      setIncludeSnapshot: vi.fn(),
    };

    await snapshotTool.handle(context as any, { compress: true }, response as any);

    expect(context.ensureTab).toHaveBeenCalled();
    expect(response.setIncludeSnapshot).toHaveBeenCalledWith(true);
  });

  it('should pass explicit compression opt-out to the snapshot response', async () => {
    const context = {
      ensureTab: vi.fn().mockResolvedValue(undefined),
    };
    const response = {
      setIncludeSnapshot: vi.fn(),
    };

    await snapshotTool.handle(context as any, { compress: false }, response as any);

    expect(context.ensureTab).toHaveBeenCalled();
    expect(response.setIncludeSnapshot).toHaveBeenCalledWith(false);
  });

  it('should expose browser_find with text and regex search options', () => {
    const mcpTool = toMcpTool(findTool.schema);
    const jsonSchema = mcpTool.inputSchema as JSONSchema7;

    expect(findTool).toBeDefined();
    expect(findTool.schema.type).toBe('readOnly');
    expect(jsonSchema.properties?.text).toBeDefined();
    expect(jsonSchema.properties?.regex).toBeDefined();
    expect(() => findTool.schema.inputSchema.parse({})).toThrow();
    expect(() => findTool.schema.inputSchema.parse({ text: 'Submit', regex: 'Submit' })).toThrow();
    expect(() => findTool.schema.inputSchema.parse({ regex: '(' })).toThrow();
    expect(() => findTool.schema.inputSchema.parse({ regex: '(?=a)a' })).toThrow();
  });

  it('should find snapshot lines by case-insensitive text', async () => {
    const context = findContext(`- heading "Groceries"\n- list:\n  - listitem: Apples\n  - listitem: Bananas\n  - listitem: Cherries`);
    const response = findResponse();

    await findTool.handle(context as any, { text: 'bananas' }, response as any);

    expect(response.addResult).toHaveBeenCalledWith(expect.stringContaining('Found 1 match for "bananas":'));
    expect(response.addResult).toHaveBeenCalledWith(expect.stringContaining('Apples'));
    expect(response.addResult).toHaveBeenCalledWith(expect.stringContaining('Cherries'));
  });

  it('should find snapshot lines by regex with flags', async () => {
    const context = findContext(`- heading "Groceries"\n- listitem: Apples\n- listitem: Bananas`);
    const response = findResponse();

    await findTool.handle(context as any, { regex: '/apples/i' }, response as any);

    expect(response.addResult).toHaveBeenCalledWith(expect.stringContaining('Found 1 match for /apples/i:'));
  });

  it('should merge overlapping browser_find context windows', async () => {
    const context = findContext(['- text "Alpha"', '- text "One"', '- text "Two"', '- text "Beta"'].join('\n'));
    const response = findResponse();

    await findTool.handle(context as any, { regex: '/Alpha|Beta/' }, response as any);

    expect(response.addResult).toHaveBeenCalledWith(expect.stringContaining('Found 2 matches for /Alpha|Beta/:'));
    expect(response.addResult).not.toHaveBeenCalledWith(expect.stringContaining('----'));
  });

  it('should show browser_find matches under their path from the root', async () => {
    const context = findContext([
      '- main [ref=e1]:',
      '  - region "Sidebar" [ref=e2]:',
      '    - navigation "Primary" [ref=e3]:',
      '      - list [ref=e4]:',
      '        - listitem [ref=e5]:',
      '          - link "Home" [ref=e6]',
      '        - listitem [ref=e7]:',
      '          - link "Products" [ref=e8]',
      '        - listitem [ref=e9]:',
      '          - link "About" [ref=e10]',
      '        - listitem [ref=e11]:',
      '          - link "Contact" [ref=e12]',
      '        - listitem [ref=e13]:',
      '          - link "Careers" [ref=e14]',
      '        - listitem [ref=e15]:',
      '          - link "Deep Target Link" [ref=e16]',
    ].join('\n'));
    const response = findResponse();

    await findTool.handle(context as any, { text: 'Deep Target Link' }, response as any);

    expect(response.addResult).toHaveBeenCalledWith(expect.stringContaining([
      'Found 1 match for "Deep Target Link":',
      '',
      '- main [ref=e1]:',
      '  - region "Sidebar" [ref=e2]:',
      '    - navigation "Primary" [ref=e3]:',
      '      - list [ref=e4]:',
      '        - listitem [ref=e13]:',
      '          - link "Careers" [ref=e14]',
      '        - listitem [ref=e15]:',
      '          - link "Deep Target Link" [ref=e16]',
    ].join('\n')));
  });

  it('should mark gaps inside off-path browser_find context', async () => {
    const context = findContext([
      '- main [ref=e1]:',
      '  - group "Toolbar" [ref=e2]:',
      '    - button "One" [ref=e3]',
      '    - button "Two" [ref=e4]',
      '    - button "Three" [ref=e5]',
      '    - button "Four" [ref=e6]',
      '  - group "Content" [ref=e7]:',
      '    - button "Target Button" [ref=e8]',
    ].join('\n'));
    const response = findResponse();

    await findTool.handle(context as any, { text: 'Target Button' }, response as any);

    expect(response.addResult).toHaveBeenCalledWith(expect.stringContaining([
      '- main [ref=e1]:',
      '  - group "Toolbar" [ref=e2]:',
      '    ...',
      '    - button "Three" [ref=e5]',
      '    - button "Four" [ref=e6]',
      '  - group "Content" [ref=e7]:',
      '    - button "Target Button" [ref=e8]',
    ].join('\n')));
  });

  it('should keep broad deep browser_find queries near-linear', async () => {
    const lines = [];
    for (let i = 0; i < 3000; i++)
      lines.push(`${'  '.repeat(i)}- group "Target ${i}":`);
    const context = findContext(lines.join('\n'));
    const response = findResponse();

    const start = performance.now();
    await findTool.handle(context as any, { text: 'Target' }, response as any);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(1500);
    expect(response.addResult).toHaveBeenCalledWith(expect.stringContaining('Found 3000 matches for "Target":'));
  });

  it('should report when browser_find has no matches', async () => {
    const context = findContext('- button "Submit"');
    const response = findResponse();

    await findTool.handle(context as any, { text: 'Cancel' }, response as any);

    expect(response.addResult).toHaveBeenCalledWith('No matches found for "Cancel".');
  });

  it('should truncate data URLs in browser_find snippets', async () => {
    const payload = '<svg viewBox="0 0 10 10"><text>Hello</text></svg>';
    const context = findContext(`- link "Logo" [ref=e1]:\n  - /url: data:image/svg+xml,${payload}\n- button "Next" [ref=e2]`);
    const response = findResponse();

    await findTool.handle(context as any, { text: 'Logo' }, response as any);

    expect(response.addResult).toHaveBeenCalledWith(expect.stringContaining('data:image/svg+xml,...'));
    expect(response.addResult).not.toHaveBeenCalledWith(expect.stringContaining(payload));
  });

  it('should report browser_find argument errors', async () => {
    const context = findContext('- button "Submit"');
    const response = findResponse();

    await findTool.handle(context as any, {}, response as any);
    await findTool.handle(context as any, { text: 'Submit', regex: 'Submit' }, response as any);

    expect(response.addError).toHaveBeenCalledWith('Provide either "text" or "regex" to search for.');
    expect(response.addError).toHaveBeenCalledWith('Provide only one of "text" or "regex", not both.');
  });

  describe('scan_page', () => {
    const scanPageTool = snapshotTools.find(tool => tool.schema.name === 'scan_page')!;

    function scanResult(violations: any[], incomplete: any[] = []) {
      return { url: 'https://example.com/', violations, incomplete, passes: [], inapplicable: [] } as any;
    }

    function scanRule(id: string, nodeCount: number) {
      return {
        id,
        impact: 'serious',
        tags: ['wcag2aa'],
        help: `${id} help`,
        helpUrl: `https://example.com/${id}`,
        description: `${id} description`,
        nodes: Array.from({ length: nodeCount }, (_, index) => ({
          target: [`#n${index}`],
          html: `<img data-i="${index}">`,
          failureSummary: `${id} failure`,
        })),
      };
    }

    function scanHarness() {
      const context = { currentTabOrDie: vi.fn().mockReturnValue({ modalStates: vi.fn(() => []), page: {} }) };
      const response = { addResult: vi.fn() };
      const text = () => response.addResult.mock.calls.map(call => call[0]).join('\n');
      return { context, response, text };
    }

    it('passes tags, rule filters and scope selectors through to the axe scan', async () => {
      const runAxeScanSpy = vi.spyOn(axe, 'runAxeScan').mockResolvedValue(scanResult([]));
      const { context, response } = scanHarness();

      await scanPageTool.handle(context as any, {
        violationsTag: ['wcag2aa'],
        includeIncomplete: true,
        maxNodesPerViolation: 10,
        includeSelectors: ['#checkout'],
        excludeSelectors: ['#cookie-banner'],
        withRules: ['image-alt'],
        disableRules: ['color-contrast'],
      } as any, response as any);

      expect(runAxeScanSpy.mock.calls[0][1]).toEqual({
        tags: ['wcag2aa'],
        rules: ['image-alt'],
        disableRules: ['color-contrast'],
        include: ['#checkout'],
        exclude: ['#cookie-banner'],
      });
    });

    it('reports the rule id and flags truncated node lists', async () => {
      vi.spyOn(axe, 'runAxeScan').mockResolvedValue(scanResult([scanRule('image-alt', 3), scanRule('label', 1)]));
      const { context, response, text } = scanHarness();

      await scanPageTool.handle(context as any, {
        violationsTag: ['wcag2aa'],
        includeIncomplete: true,
        maxNodesPerViolation: 2,
      } as any, response as any);

      expect(text()).toContain('Violation rule: image-alt (serious) — image-alt help');
      expect(text()).toContain('Violations (showing 2 of 3 nodes');
      // An untruncated rule must not carry the notice.
      expect(text()).toContain('Violation rule: label');
      expect(text()).not.toContain('showing 1 of 1');
    });

    it('separates incomplete results from violations and honours includeIncomplete', async () => {
      vi.spyOn(axe, 'runAxeScan').mockResolvedValue(
          scanResult([scanRule('image-alt', 1)], [scanRule('color-contrast', 1)])
      );
      const included = scanHarness();
      const params = { violationsTag: ['wcag2aa'], maxNodesPerViolation: 10 };

      await scanPageTool.handle(included.context as any, { ...params, includeIncomplete: true } as any, included.response as any);
      expect(included.text()).toContain('Incomplete rule: color-contrast');
      expect(included.text()).toContain('Violation rule: image-alt');
      expect(included.text()).not.toContain('Violation rule: color-contrast');

      const excluded = scanHarness();
      await scanPageTool.handle(excluded.context as any, { ...params, includeIncomplete: false } as any, excluded.response as any);
      expect(excluded.text()).not.toContain('Incomplete rule:');
      expect(excluded.text()).toContain('Violation rule: image-alt');
      // A count with no entries below it reads as findings dropped from the
      // report, so the summary line must drop the count too.
      expect(included.text()).toContain('Incomplete: 1');
      expect(excluded.text()).not.toContain('Incomplete:');
      expect(excluded.text()).toContain('Violations: 1, Passes: 0');
    });
  });
});

describe('scan_page annotated screenshots', () => {
  const scanPageTool = snapshotTools.find(tool => tool.schema.name === 'scan_page')!;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should default annotateScreenshot to off', async () => {
    const parsed = scanPageTool.schema.inputSchema.parse({ violationsTag: ['wcag2a'] });
    const harness = scanHarness();

    await scanPageTool.handle(harness.context as any, parsed, harness.response as any);

    expect(parsed.annotateScreenshot).toBe(false);
    expect(harness.screenshot).not.toHaveBeenCalled();
    expect(harness.evaluate).not.toHaveBeenCalled();
    expect(harness.response.addFileResourceLink).not.toHaveBeenCalled();
  });

  it('should annotate, screenshot, then remove the markers', async () => {
    const harness = scanHarness({ markedNodes: 2 });

    await scanPageTool.handle(harness.context as any, scanParams(), harness.response as any);

    expect(harness.order).toEqual(['draw', 'screenshot', 'cleanup']);
    expect(harness.screenshot).toHaveBeenCalledWith({ path: '/out/annotated.png', fullPage: true });
    expect(harness.response.addFileResourceLink).toHaveBeenCalledWith('/out/annotated.png', expect.objectContaining({ mimeType: 'image/png' }));
    expect(harness.results()).toContain('Annotated screenshot: /out/annotated.png');
    expect(harness.results()).toContain('Marked 2 of 2 violating nodes.');
    expect(harness.results()).not.toContain('Not marked:');
  });

  it('should remove the markers even when the screenshot throws', async () => {
    const harness = scanHarness({ markedNodes: 2, screenshotError: new Error('screenshot boom') });

    await expect(scanPageTool.handle(harness.context as any, scanParams(), harness.response as any)).rejects.toThrow('screenshot boom');

    expect(harness.order).toEqual(['draw', 'screenshot', 'cleanup']);
    expect(harness.response.addFileResourceLink).not.toHaveBeenCalled();
  });

  it('should report nodes that were truncated, hidden, or inside an iframe', async () => {
    const nodes = Array.from({ length: 60 }, (_, index) => ({ target: [`#n${index}`], html: `<img id="n${index}">` }));
    nodes.push({ target: ['iframe', '#inner'], html: '<img id="inner">' } as any);
    const harness = scanHarness({
      violations: [{ id: 'image-alt', tags: ['wcag2a'], nodes }],
      markedNodes: 48,
    });

    await scanPageTool.handle(harness.context as any, scanParams(), harness.response as any);

    expect(harness.results()).toContain('Marked 48 of 61 violating nodes.');
    expect(harness.results()).toContain('Not marked: 10 over the 50-element annotation limit, 2 hidden, zero-size or off-canvas, 1 inside an iframe.');
  });

  it('should give each scan its own layer id so cleanup never removes a page element', async () => {
    const first = scanHarness({ markedNodes: 2 });
    await scanPageTool.handle(first.context as any, scanParams(), first.response as any);
    const second = scanHarness({ markedNodes: 2 });
    await scanPageTool.handle(second.context as any, scanParams(), second.response as any);

    const layerId = first.evaluate.mock.calls[0][1].layerId;
    expect(layerId).toMatch(/^mcp-a11y-annotation-layer-[0-9a-f-]{36}$/);
    // Cleanup must target exactly the layer that was drawn, nothing else.
    expect(first.evaluate.mock.calls[1][1]).toBe(layerId);
    expect(second.evaluate.mock.calls[0][1].layerId).not.toBe(layerId);
  });

  it('should mark shadow DOM targets instead of counting them as iframe nodes', async () => {
    const harness = scanHarness({
      violations: [{ id: 'image-alt', tags: ['wcag2a'], nodes: [{ target: [['my-card', '#shadow-img']], html: '<img>' }] }],
      markedNodes: 1,
    });

    await scanPageTool.handle(harness.context as any, scanParams(), harness.response as any);

    expect(harness.evaluate.mock.calls[0][1].marks).toEqual([{ path: ['my-card', '#shadow-img'], labels: ['image-alt'] }]);
    expect(harness.results()).toContain('Marked 1 of 1 violating nodes.');
    expect(harness.results()).not.toContain('Not marked:');
  });

  it('should draw one box per element listing every rule that element failed', async () => {
    const harness = scanHarness({
      violations: [
        { id: 'image-alt', tags: ['wcag2a'], nodes: [{ target: ['#one'], html: '<img id="one">' }] },
        { id: 'color-contrast', tags: ['wcag2a'], nodes: [{ target: ['#one'], html: '<img id="one">' }] },
      ],
      markedNodes: 2,
    });

    await scanPageTool.handle(harness.context as any, scanParams(), harness.response as any);

    expect(harness.evaluate.mock.calls[0][1].marks).toEqual([{ path: ['#one'], labels: ['image-alt', 'color-contrast'] }]);
    // Both nodes are represented by that single box, so both count as marked.
    expect(harness.results()).toContain('Marked 2 of 2 violating nodes.');
  });

  it('should not count a hidden shared element as marked for any of its rules', async () => {
    const harness = scanHarness({
      violations: [
        { id: 'image-alt', tags: ['wcag2a'], nodes: [{ target: ['#hidden'], html: '<img id="hidden">' }] },
        { id: 'color-contrast', tags: ['wcag2a'], nodes: [{ target: ['#hidden'], html: '<img id="hidden">' }] },
      ],
      markedNodes: 0,
    });

    await scanPageTool.handle(harness.context as any, scanParams(), harness.response as any);

    expect(harness.results()).toContain('Marked 0 of 2 violating nodes.');
    expect(harness.results()).toContain('Not marked: 0 over the 50-element annotation limit, 2 hidden, zero-size or off-canvas, 0 inside an iframe.');
  });
});

describe.skipIf(!fs.existsSync(chromium.executablePath()))('scan_page annotated screenshots in a real browser', () => {
  const scanPageTool = snapshotTools.find(tool => tool.schema.name === 'scan_page')!;
  let browser: Browser;
  let outputDir: string;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, chromiumSandbox: false });
    outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-a11y-annotate-'));
  });

  afterAll(async () => {
    await browser?.close();
    await fs.promises.rm(outputDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Runs the real tool against a real page: only the Axe scan is faked, so the
  // in-page drawing, geometry and cleanup all execute for real. The markers only
  // exist between drawing and cleanup, so probe them from the screenshot call.
  async function annotate(html: string, violations: any[], viewport = { width: 800, height: 400 }) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.setContent(html);
    vi.spyOn(axe, 'runAxeScan').mockResolvedValue({
      url: 'https://example.com/', violations, incomplete: [], passes: [], inapplicable: [],
    } as any);
    const screenshot = page.screenshot.bind(page);
    let drawn: any;
    vi.spyOn(page, 'screenshot').mockImplementation(async (options: any) => {
      drawn = await page.evaluate(() => {
        const layer = document.querySelector('[id^="mcp-a11y-annotation-layer-"]')!;
        const rect = (element: Element) => {
          const box = element.getBoundingClientRect();
          return [box.x, box.y, box.width, box.height];
        };
        // Markers live in the layer's shadow root, each a clipped ring followed
        // by its own unclipped label.
        const children = [...layer.shadowRoot!.children];
        const style = getComputedStyle(layer);
        return {
          inTopLayer: layer.matches(':popover-open'),
          visible: style.display !== 'none' && style.visibility === 'visible' && style.opacity === '1',
          animations: document.getAnimations().map(animation => animation.playState),
          target: document.querySelector('#one') && rect(document.querySelector('#one')!),
          boxes: children.filter((_, index) => index % 2 === 0).map((box, index) => ({
            label: children[index * 2 + 1].textContent,
            rect: rect(box),
            labelRect: rect(children[index * 2 + 1]),
          })),
        };
      });
      return screenshot(options);
    });
    const response = { addResult: vi.fn(), addError: vi.fn(), addFileResourceLink: vi.fn() };
    const tab = { page, context: { outputFile: async (name: string) => path.join(outputDir, name) } };
    const bodyBefore = await page.evaluate(() => document.body.innerHTML);
    await scanPageTool.handle({ currentTabOrDie: () => tab } as any, scanParams() as any, response as any);
    const bodyAfter = await page.evaluate(() => document.body.innerHTML);
    const targetRect = await page.evaluate(() => {
      const box = document.querySelector('#one')?.getBoundingClientRect();
      return box && [box.x, box.y, box.width, box.height];
    });
    const animationsAfter = await page.evaluate(() => document.getAnimations().map(animation => animation.playState));
    await context.close();
    return { results: response.addResult.mock.calls.map(call => call[0]).join('\n'), bodyBefore, bodyAfter, drawn, targetRect, animationsAfter };
  }

  it('should leave the page byte-identical, even one already using the layer id', async () => {
    const { bodyBefore, bodyAfter, results } = await annotate(
        '<div id="mcp-a11y-annotation-layer">page owned</div><img id="one" style="width:50px;height:50px">',
        [{ id: 'image-alt', tags: ['wcag2a'], nodes: [{ target: ['#one'], html: '<img id="one">' }] }],
    );

    expect(bodyAfter).toBe(bodyBefore);
    expect(bodyAfter).toContain('page owned');
    expect(results).toContain('Marked 1 of 1 violating nodes.');
  });

  it('should place the marker on the target under CSS zoom', async () => {
    const { drawn, targetRect } = await annotate(
        '<style>:root{zoom:200%}body{margin:0}#one{position:absolute;left:20px;top:30px;width:100px;height:40px}</style><div id="one"></div>',
        [{ id: 'image-alt', tags: ['wcag2a'], nodes: [{ target: ['#one'], html: '<div id="one">' }] }],
        { width: 800, height: 600 },
    );

    // Without the scale correction the box came out at twice the size and offset.
    expect(drawn.boxes[0].rect).toEqual(targetRect);
  });

  it('should draw above an open modal dialog', async () => {
    const { drawn, results } = await annotate(
        '<dialog id="d"><img id="one" style="width:80px;height:80px"></dialog><script>document.getElementById("d").showModal()</script>',
        [{ id: 'image-alt', tags: ['wcag2a'], nodes: [{ target: ['#one'], html: '<img id="one">' }] }],
    );

    // Only the top layer paints above a modal dialog; z-index alone does not.
    expect(drawn.inTopLayer).toBe(true);
    expect(results).toContain('Marked 1 of 1 violating nodes.');
  });

  it('should mark an element inside an open shadow root with all of its rules', async () => {
    const target = [['my-card', '#shadow-img']];
    const { drawn, results } = await annotate(
        `<my-card></my-card><script>
        class MyCard extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<img id="shadow-img" style="width:60px;height:60px">'; } }
        customElements.define('my-card', MyCard);
      </script>`,
        [
          { id: 'image-alt', tags: ['wcag2a'], nodes: [{ target, html: '<img>' }] },
          { id: 'color-contrast', tags: ['wcag2a'], nodes: [{ target, html: '<img>' }] },
        ],
    );

    // One box, both rule ids on it, sitting exactly on the shadow image.
    expect(drawn.boxes.length).toBe(1);
    expect(drawn.boxes[0]).toMatchObject({ label: 'image-alt, color-contrast', rect: [8, 8, 60, 60] });
    expect(results).toContain('Marked 2 of 2 violating nodes.');
  });

  it('should freeze animations so a moving target keeps its marker', async () => {
    const { drawn, animationsAfter, results } = await annotate(
        '<style>body{margin:0}@keyframes slide{from{left:0}to{left:700px}}#one{position:absolute;top:100px;width:80px;height:80px;animation:slide 1s linear infinite}</style><div id="one"></div>',
        [{ id: 'image-alt', tags: ['wcag2a'], nodes: [{ target: ['#one'], html: '<div id="one">' }] }],
    );

    // Paused for the capture, so the target cannot slide out from under the
    // marker between measuring and screenshotting...
    expect(drawn.animations).toEqual(['paused']);
    expect(drawn.boxes[0].rect).toEqual(drawn.target);
    // ...and running again once the scan is over.
    expect(animationsAfter).toEqual(['running']);
    expect(results).toContain('Marked 1 of 1 violating nodes.');
  });

  it('should stay visible against page CSS that would hide the overlay', async () => {
    const { drawn, results } = await annotate(
        `<style>body{margin:0}div{display:none!important}[popover]{opacity:0}*{visibility:hidden!important;font-size:40px!important}
         #one{display:block!important;visibility:visible!important;width:80px;height:80px}</style><div id="one"></div>`,
        [{ id: 'image-alt', tags: ['wcag2a'], nodes: [{ target: ['#one'], html: '<div id="one">' }] }],
    );

    // Important inline declarations outrank the page's, and the markers sit in
    // a shadow root the page's selectors cannot reach at all.
    expect(drawn.visible).toBe(true);
    expect(drawn.boxes[0].rect).toEqual(drawn.target);
    expect(drawn.boxes[0].labelRect[3]).toBeLessThan(20);
    expect(results).toContain('Marked 1 of 1 violating nodes.');
  });

  it('should not count an element parked outside the captured page', async () => {
    const { drawn, results } = await annotate(
        '<style>#one{position:absolute;left:-9999px;top:0;width:80px;height:80px}</style><div id="one"></div>',
        [{ id: 'image-alt', tags: ['wcag2a'], nodes: [{ target: ['#one'], html: '<div id="one">' }] }],
    );

    // A full-page screenshot is clipped to the document box, so this marker
    // could never appear in the PNG.
    expect(drawn.boxes).toEqual([]);
    expect(results).toContain('Marked 0 of 1 violating nodes.');
    expect(results).toContain('1 hidden, zero-size or off-canvas');
  });

  it('should keep the whole rule label readable on a tiny element', async () => {
    const { drawn } = await annotate(
        '<style>#one{width:12px;height:12px}</style><div id="one"></div>',
        [{ id: 'image-alt', tags: ['wcag2a'], nodes: [{ target: ['#one'], html: '<div id="one">' }] }],
    );

    // The label is a sibling of the clipped ring, so the 12px box does not cut
    // the rule id down to a couple of pixels of text.
    expect(drawn.boxes[0].rect[2]).toBe(12);
    expect(drawn.boxes[0].labelRect[2]).toBeGreaterThan(40);
  });

  it('should report an unresolvable selector as hidden rather than as marked', async () => {
    const { results } = await annotate('<div id="one"></div>', [
      { id: 'image-alt', tags: ['wcag2a'], nodes: [{ target: [['my-card', '#gone']], html: '<img>' }] },
    ]);

    expect(results).toContain('Marked 0 of 1 violating nodes.');
    expect(results).toContain('1 hidden, zero-size or off-canvas');
  });
});

function scanParams() {
  return { violationsTag: ['wcag2a' as const], annotateScreenshot: true };
}

function scanHarness(options: { violations?: any[], markedNodes?: number, screenshotError?: Error } = {}) {
  const violations = options.violations ?? [{
    id: 'image-alt',
    tags: ['wcag2a'],
    nodes: [
      { target: ['#one'], html: '<img id="one">' },
      { target: ['#two'], html: '<img id="two">' },
    ],
  }];
  const order: string[] = [];

  vi.spyOn(axe, 'runAxeScan').mockResolvedValue({
    url: 'https://example.com/',
    violations,
    incomplete: [],
    passes: [],
    inapplicable: [],
  } as any);

  const evaluate = vi.fn(async () => {
    const isDraw = !order.includes('draw');
    order.push(isDraw ? 'draw' : 'cleanup');
    return isDraw ? options.markedNodes ?? 0 : undefined;
  });
  const screenshot = vi.fn(async () => {
    order.push('screenshot');
    if (options.screenshotError)
      throw options.screenshotError;
  });
  const response = {
    addResult: vi.fn(),
    addError: vi.fn(),
    addFileResourceLink: vi.fn(),
  };
  const tab = {
    page: { evaluate, screenshot },
    context: { outputFile: vi.fn(async () => '/out/annotated.png') },
  };

  return {
    context: { currentTabOrDie: vi.fn().mockReturnValue(tab) },
    response,
    evaluate,
    screenshot,
    order,
    results: () => response.addResult.mock.calls.map(call => call[0]).join('\n'),
  };
}

function findContext(snapshot: string) {
  const tab = {
    modalStates: vi.fn().mockReturnValue([]),
    page: {
      ariaSnapshot: vi.fn().mockResolvedValue(snapshot),
    },
  };
  return {
    currentTabOrDie: vi.fn().mockReturnValue(tab),
  };
}

function findResponse() {
  return {
    addResult: vi.fn(),
    addError: vi.fn(),
  };
}

describe('browser_drop', () => {
  const dropTool = snapshotTools.find(tool => tool.schema.name === 'browser_drop')!;

  function dropHarness() {
    const drop = vi.fn().mockResolvedValue(undefined);
    const locator = { drop, normalize: async () => ({ toString: () => `getByTestId('zone')` }) };
    const tab = {
      modalStates: vi.fn().mockReturnValue([]),
      refLocator: vi.fn().mockResolvedValue(locator),
      waitForCompletion: vi.fn(async (callback: () => Promise<void>) => await callback()),
    };
    const response = { setIncludeSnapshot: vi.fn(), addCode: vi.fn(), addResult: vi.fn(), addError: vi.fn() };
    return { drop, tab, response, context: { currentTabOrDie: () => tab } };
  }

  it('should expose a destructive tool with optional paths and data', () => {
    const jsonSchema = toMcpTool(dropTool.schema).inputSchema as JSONSchema7;

    expect(dropTool.schema.type).toBe('destructive');
    expect(dropTool.capability).toBe('core');
    expect((jsonSchema.required ?? []).sort()).toEqual(['element', 'ref']);
    expect((jsonSchema.properties?.paths as JSONSchema7).type).toBe('array');
    expect((jsonSchema.properties?.data as JSONSchema7).type).toBe('object');
  });

  it('should drop files onto the element', async () => {
    const harness = dropHarness();

    await dropTool.handle(harness.context as any, { element: 'Dropzone', ref: 'e1', paths: ['/tmp/a.txt'] }, harness.response as any);

    expect(harness.tab.refLocator).toHaveBeenCalledWith(expect.objectContaining({ ref: 'e1', element: 'Dropzone' }));
    expect(harness.drop).toHaveBeenCalledWith({ files: ['/tmp/a.txt'] });
    expect(harness.response.setIncludeSnapshot).toHaveBeenCalled();
    expect(harness.response.addCode).toHaveBeenCalledWith(`await page.getByTestId('zone').drop({"files":["/tmp/a.txt"]});`);
  });

  it('should drop clipboard-like data onto the element', async () => {
    const harness = dropHarness();

    await dropTool.handle(harness.context as any, { element: 'Dropzone', ref: 'e1', data: { 'text/plain': 'hello' } }, harness.response as any);

    expect(harness.drop).toHaveBeenCalledWith({ data: { 'text/plain': 'hello' } });
  });

  it('should drop files and data together', async () => {
    const harness = dropHarness();

    await dropTool.handle(harness.context as any, { element: 'Dropzone', ref: 'e1', paths: ['/tmp/a.txt'], data: { 'text/plain': 'hello' } }, harness.response as any);

    expect(harness.drop).toHaveBeenCalledWith({ files: ['/tmp/a.txt'], data: { 'text/plain': 'hello' } });
  });

  it('should reject a drop with no payload', async () => {
    for (const params of [{}, { paths: [] }, { data: {} }, { paths: [], data: {} }]) {
      const harness = dropHarness();

      await expect(dropTool.handle(harness.context as any, { element: 'Dropzone', ref: 'e1', ...params }, harness.response as any))
          .rejects.toThrow('Provide "paths", "data" or both');

      expect(harness.drop).not.toHaveBeenCalled();
    }
  });

  it('should refuse to drop while a modal state is pending', async () => {
    const harness = dropHarness();
    harness.tab.modalStates = vi.fn().mockReturnValue([{ type: 'dialog', description: 'alert' }]);
    harness.tab.modalStatesMarkdown = vi.fn().mockReturnValue(['- alert']);

    await dropTool.handle(harness.context as any, { element: 'Dropzone', ref: 'e1', data: { 'text/plain': 'hi' } }, harness.response as any);

    expect(harness.drop).not.toHaveBeenCalled();
    expect(harness.response.addError).toHaveBeenCalledWith(expect.stringContaining('does not handle the modal state'));
  });

  it('should settle the page through waitForCompletion', async () => {
    const harness = dropHarness();

    await dropTool.handle(harness.context as any, { element: 'Dropzone', ref: 'e1', data: { 'text/plain': 'hi' } }, harness.response as any);

    expect(harness.tab.waitForCompletion).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!fs.existsSync(chromium.executablePath()))('browser_drop in a real browser', () => {
  const dropTool = snapshotTools.find(tool => tool.schema.name === 'browser_drop')!;
  let browser: Browser;
  let scratchDir: string;

  const dropzone = `
    <div id="zone" style="width:200px;height:100px">drop here</div>
    <script>
      window.dropped = null;
      const zone = document.getElementById('zone');
      zone.addEventListener('dragover', event => event.preventDefault());
      zone.addEventListener('drop', event => {
        event.preventDefault();
        window.dropped = {
          text: event.dataTransfer.getData('text/plain'),
          uri: event.dataTransfer.getData('text/uri-list'),
          files: [...event.dataTransfer.files].map(file => ({ name: file.name, type: file.type })),
        };
      });
    </script>`;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, chromiumSandbox: false });
    scratchDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-a11y-drop-'));
  });

  afterAll(async () => {
    await browser?.close();
    await fs.promises.rm(scratchDir, { recursive: true, force: true });
  });

  async function runDrop(html: string, params: Record<string, unknown>) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(html);
    const tab = {
      modalStates: () => [],
      refLocator: async () => page.locator('#zone'),
      waitForCompletion: async (callback: () => Promise<void>) => await callback(),
    };
    const response = { setIncludeSnapshot: vi.fn(), addCode: vi.fn(), addResult: vi.fn(), addError: vi.fn() };
    try {
      await dropTool.handle({ currentTabOrDie: () => tab } as any, { element: 'Dropzone', ref: 'e1', ...params } as any, response as any);
      return { dropped: await page.evaluate(() => (window as any).dropped), code: response.addCode.mock.calls.map(call => call[0]).join('\n') };
    } finally {
      await context.close();
    }
  }

  it('drops clipboard-like data onto a real drop zone', async () => {
    const { dropped, code } = await runDrop(dropzone, { data: { 'text/plain': 'hello world', 'text/uri-list': 'https://example.com' } });

    expect(dropped).toMatchObject({ text: 'hello world', uri: 'https://example.com' });
    expect(code).toContain('.drop(');
  });

  it('drops a real file onto a real drop zone', async () => {
    const filePath = path.join(scratchDir, 'note.txt');
    await fs.promises.writeFile(filePath, 'hello');

    const { dropped } = await runDrop(dropzone, { paths: [filePath] });

    expect(dropped.files).toEqual([{ name: 'note.txt', type: 'text/plain' }]);
  });

  it('fails when the target rejects the payload', async () => {
    const rejecting = `<div id="zone" style="width:200px;height:100px">no drops</div>`;

    // Assert the specific rejection, so a setup failure inside runDrop cannot
    // masquerade as the behaviour under test.
    await expect(runDrop(rejecting, { data: { 'text/plain': 'hello' } }))
        .rejects.toThrow(/did not call preventDefault/);
  });
});
