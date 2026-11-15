/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import auditTextSpacingTools, { buildTextSpacingFindings } from '../src/tools/auditTextSpacing.js';
import { Response } from '../src/response.js';
import {
  applyTextSpacing,
  measureTextSpacing,
  removeTextSpacing,
  textSpacingLayerPrefix,
  textSpacingOverrides,
  type TextSpacingFrameMeasurement,
} from '../src/tools/textSpacingMeasurement.js';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { resolveConfig } from '../src/config.js';

const emptyMeasurement: TextSpacingFrameMeasurement = { candidates: 1, measured: 1, truncated: 0, stale: 0, overlapLinesTruncated: 0, clipped: [], overlaps: [], blocked: [] };

describe('buildTextSpacingFindings', () => {
  it('names the clipping box and tailors the fix to how it clips', () => {
    const findings = buildTextSpacingFindings([{
      frameUrl: null,
      measurement: {
        ...emptyMeasurement,
        clipped: [{
          selector: '#cta',
          text: 'Subscribe',
          fontSizePx: 16,
          hiddenPercentBefore: 0,
          hiddenPercentAfter: 24.5,
          textBoxBefore: { x: 0, y: 0, width: 80, height: 18 },
          textBoxAfter: { x: 0, y: 0, width: 106, height: 18 },
          clippedBy: { selector: '#cta', overflowX: 'hidden', overflowY: 'hidden', width: '90px', height: '24px', maxWidth: 'none', maxHeight: 'none', whiteSpace: 'nowrap', textOverflow: 'ellipsis', lineClamp: 'none' },
        }],
      },
    }]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'text-clipped', wcag: '1.4.12', selector: '#cta', frameUrl: null });
    expect(findings[0].problem).toBe('"Subscribe" (#cta) is 24.5% hidden with text spacing applied (0% before), cut off by its own box (overflow: hidden, height: 24px, white-space: nowrap, text-overflow: ellipsis).');
    expect(findings[0].fix).toBe('On #cta: allow the text to wrap instead of truncating it on one line; replace the fixed height/max-height with min-height so the box grows with its text; or stop hiding the overflow (overflow: visible, or auto if a scrollbar is acceptable).');
  });

  it('reports overlaps with both elements and keeps the frame', () => {
    const findings = buildTextSpacingFindings([
      { frameUrl: 'http://frame.local/', measurement: { ...emptyMeasurement, overlaps: [{ selector: '#a', text: 'Left', otherSelector: '#b', otherText: 'Right', overlap: { x: 1, y: 2, width: 3, height: 4 } }] } },
      { frameUrl: 'http://broken.local/', measurement: null },
    ]);
    expect(findings).toEqual([expect.objectContaining({
      check: 'text-overlap',
      frameUrl: 'http://frame.local/',
      problem: '"Left" (#a) overlaps "Right" (#b) with text spacing applied; they did not overlap before.',
      overlap: { otherSelector: '#b', otherText: 'Right', overlap: { x: 1, y: 2, width: 3, height: 4 } },
    })]);
  });
});

describe('audit_text_spacing screenshot failure handling', () => {
  const tool = auditTextSpacingTools.find(entry => entry.schema.name === 'audit_text_spacing')!;
  const measurement: TextSpacingFrameMeasurement = { ...emptyMeasurement, candidates: 2, measured: 2 };

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function harness(options: { apply: 'ok' | 'hang'; screenshot: 'ok' | 'reject' }) {
    const removals = { count: 0 };
    const frame: any = {
      parentFrame: () => null,
      url: () => 'https://example.com/',
      isDetached: () => false,
      evaluate: vi.fn(async (fn: unknown) => {
        if (fn === measureTextSpacing)
          return measurement;
        if (fn === applyTextSpacing)
          return options.apply === 'hang' ? new Promise(() => undefined) : 1;
        if (fn === removeTextSpacing) {
          removals.count++;
          return 1;
        }
        throw new Error('unexpected evaluate');
      }),
    };
    const page = {
      frames: () => [frame],
      mainFrame: () => frame,
      url: () => 'https://example.com/',
      screenshot: vi.fn(async () => {
        if (options.screenshot === 'reject')
          throw new Error('Protocol error: capture failed');
      }),
    };
    const tab: any = { page, modalStates: () => [], context: { outputFile: async (name: string) => `/tmp/${name}` } };
    const context: any = { currentTabOrDie: () => tab, config: {} };
    const written: string[] = [];
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file: any) => {
      written.push(String(file));
    });
    return { context, page, removals, written };
  }

  it('keeps the JSON report and reports the error when the screenshot capture fails', async () => {
    const { context, removals, written } = harness({ apply: 'ok', screenshot: 'reject' });
    const response = new Response(context, 'audit_text_spacing', {});
    await tool.handle(context, tool.schema.inputSchema.parse({ screenshot: true }), response);
    const text = response.result();
    expect(text).toContain('WARNING: no screenshot was saved: the screenshot could not be captured (Protocol error: capture failed).');
    expect(text).not.toContain('Screenshot (overrides applied)');
    expect(written.some(file => file.includes('audit-text-spacing-') && file.endsWith('.json'))).toBe(true);
    expect((response.structuredContent() as any).screenshot).toBeNull();
    expect(removals.count).toBe(1);
  });

  it('bounds re-applying the overrides so a stalled frame cannot block cleanup or the report', async () => {
    vi.useFakeTimers();
    const { context, page, removals, written } = harness({ apply: 'hang', screenshot: 'ok' });
    const response = new Response(context, 'audit_text_spacing', {});
    const run = tool.handle(context, tool.schema.inputSchema.parse({ screenshot: true }), response);
    await vi.advanceTimersByTimeAsync(16_000);
    await run;
    expect(response.result()).toContain('WARNING: no screenshot was saved: the overrides could not be re-applied to main frame.');
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(removals.count).toBe(1);
    expect(written.some(file => file.endsWith('.json'))).toBe(true);
  });
});

const hasBundledChromium = fs.existsSync(chromium.executablePath());

describe.skipIf(!hasBundledChromium)('measureTextSpacing in a real page', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });
  afterEach(async () => {
    await page?.close();
  });

  async function measure(html: string, maxElements = 500) {
    page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(`<!doctype html><html><body style="font: 16px/1.2 sans-serif; margin: 8px">${html}</body></html>`);
    return page.evaluate(measureTextSpacing, { layerName: `${textSpacingLayerPrefix}test`, maxElements, maxOverlapLines: 200, overrides: textSpacingOverrides });
  }

  it('reports nothing for content that reflows with the spacing', async () => {
    const result = await measure(`
      <h1>Heading</h1>
      <p>A paragraph that is free to wrap onto as many lines as it needs.</p>
      <button style="padding: 4px 8px; min-height: 24px">Flexible button</button>
      <div style="width: 160px; overflow: hidden"><span>Wraps inside a width-limited box that hides overflow</span></div>`);
    expect(result).toMatchObject({ measured: 4, truncated: 0, stale: 0, clipped: [], overlaps: [], blocked: [] });
  });

  it('flags a fixed-height box that clips text once spacing grows, naming the clipping ancestor', async () => {
    const result = await measure(`<div id="card" style="width: 200px; height: 40px; overflow: hidden"><p style="margin: 0">A card with two lines of text that fits now.</p></div>`);
    expect(result.clipped).toEqual([expect.objectContaining({
      selector: '#card > p',
      hiddenPercentBefore: 0,
      clippedBy: expect.objectContaining({ selector: '#card', overflowY: 'hidden', height: '40px' }),
    })]);
    expect(result.clipped[0].hiddenPercentAfter).toBeGreaterThan(5);
  });

  it('flags a single-line truncated label', async () => {
    const result = await measure(`<button id="cta" style="font: 16px sans-serif; width: 165px; padding: 0; border: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">Subscribe to updates</button>`);
    expect(result.clipped).toEqual([expect.objectContaining({
      selector: '#cta',
      hiddenPercentBefore: 0,
      clippedBy: expect.objectContaining({ selector: '#cta', whiteSpace: 'nowrap', textOverflow: 'ellipsis', height: 'auto', width: '165px' }),
    })]);
    // An auto-height box must not be blamed for a fixed height it never had.
    const [finding] = buildTextSpacingFindings([{ frameUrl: null, measurement: result }]);
    expect(finding.problem).not.toContain('height:');
    expect(finding.fix).toBe('On #cta: allow the text to wrap instead of truncating it on one line; or stop hiding the overflow (overflow: visible, or auto if a scrollbar is acceptable).');
  });

  it('flags text that newly overlaps other text, but not text that already overlapped', async () => {
    const result = await measure(`
      <div style="position: relative; height: 24px; width: 400px">
        <span id="left" style="position: absolute; left: 0; white-space: nowrap">Left label text</span>
        <span id="right" style="position: absolute; left: 110px">Right</span>
      </div>
      <div style="position: relative; height: 24px; width: 400px">
        <span id="under" style="position: absolute; left: 0">Already</span>
        <span id="over" style="position: absolute; left: 10px">overlapping</span>
      </div>`);
    expect(result.overlaps).toEqual([expect.objectContaining({ selector: '#left', otherSelector: '#right', text: 'Left label text', otherText: 'Right' })]);
  });

  it('flags paragraph spacing that pushes text out of a fixed-height box', async () => {
    const result = await measure(`<div id="box" style="height: 60px; overflow: hidden; width: 600px"><p style="margin: 0 0 4px">First paragraph</p><p id="second" style="margin: 0">Second paragraph</p></div>`);
    expect(result.clipped.map(entry => entry.selector)).toContain('#second');
  });

  it('ignores visually hidden text that was already clipped before the overrides', async () => {
    const result = await measure(`<span style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap">Screen reader only label</span><p>Visible</p>`);
    expect(result.clipped).toEqual([]);
    expect(result.measured).toBe(2);
  });

  it('skips hidden elements and does not let them use up maxElements', async () => {
    const result = await measure(`<p style="display: none">gone</p><p style="visibility: hidden">invisible</p><p style="opacity: 0">transparent</p><p id="one">One</p><p>Two</p>`, 1);
    expect(result).toMatchObject({ candidates: 2, measured: 1, truncated: 1 });
  });

  it('measures and restyles content inside open shadow roots', async () => {
    page = await browser.newPage();
    await page.setContent('<body style="font: 16px/1.2 sans-serif"><div id="host"></div></body>');
    await page.evaluate(() => {
      document.getElementById('host')!.attachShadow({ mode: 'open' }).innerHTML = '<div class="box" style="height: 18px; width: 300px; overflow: hidden"><span>Shadow text fits on one line</span></div>';
    });
    const result = await page.evaluate(measureTextSpacing, { layerName: `${textSpacingLayerPrefix}test`, maxElements: 50, maxOverlapLines: 200, overrides: textSpacingOverrides });
    expect(result.clipped).toEqual([expect.objectContaining({
      selector: '#host >>> div > span',
      clippedBy: expect.objectContaining({ selector: '#host >>> div' }),
    })]);
  });

  it('wins over unlayered author !important rules but reports inline !important it cannot override', async () => {
    const result = await measure(`
      <style>.tight { letter-spacing: 0 !important; line-height: 1 !important; }</style>
      <p class="tight">Author stylesheet</p>
      <p id="inline" style="letter-spacing: 0 !important; word-spacing: 0 !important">Inline important</p>`);
    expect(result.blocked).toEqual([{ selector: '#inline', text: 'Inline important', properties: ['letter-spacing', 'word-spacing'], inlineImportant: ['letter-spacing', 'word-spacing'] }]);
  });

  it('applies the overrides on a page whose CSP forbids inline styles', async () => {
    page = await browser.newPage();
    await page.route('http://csp.local/', route => route.fulfill({
      contentType: 'text/html',
      headers: { 'content-security-policy': 'default-src \'none\'; style-src \'self\'' },
      body: '<!doctype html><body><div id="card" style="height: 40px; width: 200px; overflow: hidden"><p style="margin: 0">A card with two lines of text that fits now.</p></div></body>',
    }));
    await page.goto('http://csp.local/');
    const result = await page.evaluate(measureTextSpacing, { layerName: `${textSpacingLayerPrefix}test`, maxElements: 50, maxOverlapLines: 200, overrides: textSpacingOverrides });
    expect(result.blocked).toEqual([]);
    // The inline style attribute above is itself blocked by the CSP, so the card has no height limit.
    expect(result.measured).toBe(1);
  });

  it('checks every line for clipping, even past the overlap line limit', async () => {
    const lines = Array.from({ length: 60 }, (_, index) => `Line ${index + 1}`).join('\n');
    const result = await measure(`<div style="height: 1000px; overflow: hidden"><div id="long" style="white-space: pre; font: 16px/1 sans-serif">${lines}</div></div>`);
    // With the old 40-line cap the first 40 spaced lines (960px) still fit, so this went unreported.
    expect(result.clipped).toEqual([expect.objectContaining({ selector: '#long' })]);
    expect(result.clipped[0].hiddenPercentBefore).toBeLessThan(1);
    expect(result.clipped[0].hiddenPercentAfter).toBeGreaterThan(25);
    expect(result.overlapLinesTruncated).toBe(0);
  });

  it('counts elements whose overlap check was limited to the first lines', async () => {
    const lines = Array.from({ length: 250 }, (_, index) => `Line ${index + 1}`).join('\n');
    const result = await measure(`<div style="white-space: pre; font: 8px/1 sans-serif">${lines}</div><p>Short</p>`);
    expect(result.overlapLinesTruncated).toBe(1);
  });

  it('verifies paragraph spacing on paragraphs whose text sits only in child elements', async () => {
    const result = await measure(`<p id="nested" style="margin-bottom: 0 !important"><span>First paragraph</span></p><p><span>Second</span></p>`);
    expect(result.blocked).toEqual([{ selector: '#nested', text: 'First paragraph', properties: ['margin-bottom'], inlineImportant: ['margin-bottom'] }]);
  });

  it('measures text owned by display: contents elements', async () => {
    const result = await measure(`<div id="box" style="width: 200px; height: 20px; overflow: hidden"><span id="contents" style="display: contents">A label that wraps onto a second line once spaced</span></div>`);
    expect(result.measured).toBe(1);
    expect(result.clipped).toEqual([expect.objectContaining({ selector: '#contents', clippedBy: expect.objectContaining({ selector: '#box' }) })]);
    // A hidden display: contents element still contributes nothing.
    const hidden = await measure(`<span style="display: contents; visibility: hidden">Hidden</span><p>Visible</p>`);
    expect(hidden.measured).toBe(1);
  });

  it('ignores overflow: hidden ancestors an absolutely positioned label escapes', async () => {
    const escaped = await measure(`
      <div style="position: relative; width: 600px; height: 60px">
        <div style="width: 130px; height: 20px; overflow: hidden">
          <span id="label" style="position: absolute; left: 0; top: 0; white-space: nowrap">Absolutely positioned</span>
        </div>
      </div>`);
    expect(escaped.clipped).toEqual([]);
    // Control: when the overflow: hidden box is the containing block, it does clip.
    const contained = await measure(`
      <div id="wrap" style="position: relative; width: 175px; height: 20px; overflow: hidden">
        <span id="label" style="position: absolute; left: 0; top: 0; white-space: nowrap">Absolutely positioned</span>
      </div>`);
    expect(contained.clipped).toEqual([expect.objectContaining({ selector: '#label', clippedBy: expect.objectContaining({ selector: '#wrap' }) })]);
  });

  it('does not report lines scrolled out of a scroll container as lost or overlapping', async () => {
    const result = await measure(`
      <div id="scroller" style="width: 300px; height: 60px; overflow: auto"><p style="margin: 0">First line of text<br>Second line of text<br>Third line of text</p></div>
      <span id="after" style="display: block; margin-top: -2px">Label right below the scroll box</span>`);
    expect(result.clipped).toEqual([]);
    expect(result.overlaps).toEqual([]);
    // Control: the same box with overflow: visible spills over the label.
    const spilled = await measure(`
      <div style="width: 300px; height: 60px"><p id="spill" style="margin: 0">First line of text<br>Second line of text<br>Third line of text</p></div>
      <span id="after" style="display: block; margin-top: -2px">Label right below the box</span>`);
    expect(spilled.overlaps).toEqual([expect.objectContaining({ selector: '#spill', otherSelector: '#after' })]);
  });

  it('leaves the page exactly as it was', async () => {
    await measure('<p id="p">Some text</p>');
    const state = await page.evaluate(() => ({
      adopted: document.adoptedStyleSheets.length,
      letterSpacing: getComputedStyle(document.getElementById('p')!).letterSpacing,
      lineHeight: getComputedStyle(document.getElementById('p')!).lineHeight,
      marginBottom: getComputedStyle(document.getElementById('p')!).marginBottom,
    }));
    expect(state).toEqual({ adopted: 0, letterSpacing: 'normal', lineHeight: '19.2px', marginBottom: '16px' });
  });

  it('cleanup removes only stylesheets carrying the tool layer prefix', async () => {
    page = await browser.newPage();
    await page.setContent('<p>x</p><div id="host"></div>');
    const removed = await page.evaluate(prefix => {
      const own = new CSSStyleSheet();
      own.replaceSync('p { color: red }');
      const ours = new CSSStyleSheet();
      ours.replaceSync(`@layer ${prefix}abc { * { letter-spacing: 1em } }`);
      document.adoptedStyleSheets = [own, ours];
      const shadow = document.getElementById('host')!.attachShadow({ mode: 'open' });
      shadow.adoptedStyleSheets = [ours];
      return true;
    }, textSpacingLayerPrefix);
    expect(removed).toBe(true);
    expect(await page.evaluate(removeTextSpacing, textSpacingLayerPrefix)).toBe(2);
    expect(await page.evaluate(() => [document.adoptedStyleSheets.length, document.getElementById('host')!.shadowRoot!.adoptedStyleSheets.length])).toEqual([1, 0]);
  });
});

const fixtureOrigin = 'http://fixture.local';
const pageHtml = `<!doctype html>
<html lang="en"><head><title>Spacing</title></head>
<body style="font: 16px/1.2 sans-serif">
  <h1>Pricing</h1>
  <p>Plain paragraph text wraps without trouble.</p>
  <button id="buy" style="font: 16px sans-serif; width: 100px; height: 28px; padding: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis">Buy the plan</button>
  <iframe src="http://frame.local/" style="width: 400px; height: 120px; border: 0"></iframe>
</body></html>`;
const frameHtml = `<!doctype html><body style="font: 16px/1.2 sans-serif; margin: 0">
  <div id="tile" style="width: 220px; height: 40px; overflow: hidden"><p style="margin: 0">Two lines of text in a fixed-height tile.</p></div>
</body>`;

describe.skipIf(!hasBundledChromium)('audit_text_spacing tool end-to-end', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length)
      await cleanups.pop()!();
  });

  async function startBackend() {
    const outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-text-spacing-'));
    cleanups.push(() => fs.promises.rm(outputDir, { recursive: true, force: true }));
    const config = await resolveConfig({
      outputDir,
      browser: { browserName: 'chromium', isolated: true, launchOptions: { headless: true, chromiumSandbox: false }, contextOptions: { viewport: { width: 1000, height: 700 } } },
    });
    let browser: Browser | undefined;
    let browserContext: BrowserContext | undefined;
    const backend = new BrowserServerBackend(config, {
      createContext: async () => {
        browser = await chromium.launch({ headless: true, chromiumSandbox: false });
        browserContext = await browser.newContext({ viewport: { width: 1000, height: 700 } });
        await browserContext.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin === fixtureOrigin && url.pathname === '/')
            return route.fulfill({ contentType: 'text/html', body: pageHtml });
          if (url.origin === fixtureOrigin && url.pathname === '/blank')
            return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body><img alt="" src="data:,"></body>' });
          if (url.origin === 'http://frame.local')
            return route.fulfill({ contentType: 'text/html', body: frameHtml });
          return route.fulfill({ status: 404, body: '' });
        });
        return { browserContext, close: async () => { await browserContext?.close(); await browser?.close(); } };
      },
    });
    cleanups.push(async () => {
      backend.serverClosed();
      await browserContext?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    });
    await backend.initialize({} as any, { name: 'vitest', version: 'text-spacing' });
    return { backend, outputDir };
  }

  it('reports clipped text in the page and in a cross-origin iframe, writes the report and screenshot, and restores the page', async () => {
    const { backend } = await startBackend();
    expect((await backend.listTools()).map(tool => tool.name)).toContain('audit_text_spacing');
    expect((await backend.callTool('browser_navigate', { url: `${fixtureOrigin}/` })).isError).not.toBe(true);

    const result = await backend.callTool('audit_text_spacing', { screenshot: true });
    expect(result.isError).not.toBe(true);
    const text = (result.content[0] as any).text as string;
    expect(text).toContain('Text spacing overrides (WCAG 1.4.12): line-height 1.5, letter-spacing 0.12em, word-spacing 0.16em, paragraph spacing 2em');
    expect(text).toContain('text-clipped | 2');
    expect(text).toContain('[text-clipped] WCAG 1.4.12 — "Buy the plan" (#buy)');
    expect(text).toContain('Frame: http://frame.local/');

    const structured = result.structuredContent as any;
    expect(structured).toMatchObject({
      kind: 'audit_text_spacing',
      summary: { totalFindings: 2, countByCheck: { 'text-clipped': 2, 'text-overlap': 0 }, framesUnmeasured: 0, overridesNotApplied: 0 },
    });
    expect(structured.findings.map((finding: any) => [finding.selector, finding.frameUrl, finding.clip.clippedBy.selector])).toEqual([
      ['#buy', null, '#buy'],
      ['#tile > p', 'http://frame.local/', '#tile'],
    ]);

    const report = JSON.parse(await fs.promises.readFile(structured.report.path, 'utf-8'));
    expect(report).toMatchObject({ version: 'v1', totalFindings: 2, metadata: { overrides: textSpacingOverrides }, frames: { total: 2, unmeasured: [] }, cleanupFailures: [] });
    const png = await fs.promises.readFile(structured.screenshot.path);
    expect(png.subarray(1, 4).toString()).toBe('PNG');

    const evaluate = await backend.callTool('browser_evaluate', { function: '() => [document.adoptedStyleSheets.length, getComputedStyle(document.getElementById("buy")).letterSpacing]' });
    expect((evaluate.content[0] as any).text.replace(/\s+/g, '')).toContain('[0,"normal"]');
  });

  it('fails instead of reporting a clean page when there is no text to measure', async () => {
    const { backend } = await startBackend();
    await backend.callTool('browser_navigate', { url: `${fixtureOrigin}/blank` });
    const result = await backend.callTool('audit_text_spacing', {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('No visible text was found to measure');
  });

  it('rejects non-integer and out-of-range arguments', async () => {
    const { backend } = await startBackend();
    await expect(backend.callTool('audit_text_spacing', { maxElements: 1.5 })).rejects.toThrow('expected int');
    await expect(backend.callTool('audit_text_spacing', { maxElements: 0 })).rejects.toThrow('maxElements');
  });
});
