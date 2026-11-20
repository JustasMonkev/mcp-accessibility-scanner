import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import axeCore from 'axe-core/axe.min.js';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { assertRuleOptionsValid, axeRuleSchemaShape, axeTagValues, defaultAxeTags, dedupeAxeNodes, prepareAxeResults, runAxeScan, summarizeAxeViolations, trimAxeResults } from '../src/tools/axe.js';

import type { AddressInfo } from 'node:net';
import type { Page } from 'playwright';

// The scan drives each frame itself: it installs axe-core, asks it which child
// frames to visit (axe.utils.getFrameContexts, with their elements captured in
// the same call) and for that frame's partial result (axe.runPartial), then
// merges everything with axe.finishRun in Node. The fake frames below answer
// those calls; finishRun is the real one.
type ScanCall = { url: string; context: any; options: any };
type Behavior = 'ok' | 'throws' | 'hangs';
type FakeFrame = ReturnType<typeof makeFrame>;
// element: 'missing' models a selector that no longer resolved at capture.
type FakeChild = { selector: string | string[]; frame: FakeFrame | null; context?: unknown; lookup?: Behavior; element?: 'missing' };
// closedShadow: the in-page verdict for a frame axe did not visit, given the
// caller's scope; frameElement: whether its element can be read at all.
type FakeFrameOptions = {
  name?: string,
  injection?: Behavior,
  liveness?: Behavior,
  run?: Behavior,
  children?: FakeChild[],
  unvisited?: FakeFrame[],
  closedShadow?: (scope: { include: string[], exclude: string[] }) => boolean,
  frameElement?: Behavior,
};

let scanCalls: ScanCall[] = [];
let runFailure: Error | undefined;

const environmentData = (url: string) => ({
  testEngine: { name: 'axe-core', version: axeCore.version },
  testRunner: { name: 'axe' },
  testEnvironment: { userAgent: 'fake', windowWidth: 1280, windowHeight: 720 },
  timestamp: '2026-01-01T00:00:00.000Z',
  url,
});

function behave<T>(behavior: Behavior, value: T, error = new Error('Execution context was destroyed')): Promise<T> {
  if (behavior === 'throws')
    return Promise.reject(error);
  if (behavior === 'hangs')
    return new Promise(() => {});
  return Promise.resolve(value);
}

function makeFrame(url = 'https://example.com/', options: FakeFrameOptions = {}) {
  const children = options.children ?? [];
  // Every element handle the frame hands out, to check disposal.
  const handles: { dispose: ReturnType<typeof vi.fn> }[] = [];
  const evaluateHandle = vi.fn(async (_script: unknown, arg: any) => {
    scanCalls.push({ url, context: arg.context, options: arg.options });
    // The page hands back [json, ...iframe elements] as one array handle.
    const json = JSON.stringify({
      // Only the initiating (top) frame carries environment data; the marker
      // lets tests read back which frame each partial came from.
      partial: { results: [], frames: [], environmentData: arg.context.initiator === false ? undefined : environmentData(url), marker: url },
      childFrames: children.map(child => ({
        frameSelector: child.selector,
        frameContext: child.context ?? { include: [], exclude: [], initiator: false },
      })),
    });
    const properties = new Map<string, unknown>([['0', { jsonValue: async () => json, asElement: () => null }]]);
    children.forEach((child, index) => {
      const element = child.element === 'missing' ? null : {
        contentFrame: () => behave(child.lookup ?? 'ok', child.frame),
        dispose: vi.fn(async () => undefined),
      };
      if (element)
        handles.push(element);
      properties.set(String(index + 1), { asElement: () => element });
    });
    return behave(options.run ?? 'ok', { getProperties: async () => properties, dispose: async () => undefined }, runFailure);
  });
  const frame = {
    url: () => url,
    name: () => options.name ?? '',
    children,
    handles,
    evaluateHandle,
    childFrames: () => [...children.flatMap(child => child.frame ? [child.frame] : []), ...(options.unvisited ?? [])],
    // The iframe element in the parent document, read for frames axe skipped.
    frameElement: () => behave(options.frameElement ?? 'ok', {
      evaluate: async (_script: unknown, scope: { include: string[], exclude: string[] }) => options.closedShadow?.(scope) ?? false,
      dispose: async () => undefined,
    }),
    evaluate: async (script: unknown, arg?: any) => {
      // Installing axe: the axe-core source wrapped in a plain string.
      if (typeof script === 'string')
        return behave(options.injection ?? 'ok', undefined);
      // The liveness probe: does a zero-delay timer fire in this frame?
      if (arg === undefined)
        return behave(options.liveness ?? 'ok', true);
      // A frame-free document is scanned with one plain axe.run; with frames
      // to visit, the page declines (null) and the runPartial walk takes over.
      if (children.length)
        return null;
      scanCalls.push({ url, context: arg.context, options: arg.options });
      return behave(options.run ?? 'ok', JSON.stringify({ url, violations: [], incomplete: [], passes: [], inapplicable: [] }), runFailure);
    },
  };
  return frame;
}

// No frames() here on purpose: which frames get scanned is axe's call, made
// from getFrameContexts, never a walk over Playwright's frame list.
function fakePage(countBySelector: Record<string, number> = {}, main = makeFrame()) {
  return {
    mainFrame: () => main,
    evaluate: async (_script: unknown, selectors: string[]) => selectors.map(selector => countBySelector[selector] ?? 0),
  } as unknown as Page;
}

function child(selector: string, frame: FakeFrame | null, extra: Partial<FakeChild> = {}): FakeChild {
  return { selector, frame, ...extra };
}

function resetScan() {
  scanCalls = [];
  runFailure = undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function node(target: string, html: string) {
  return { target: [target], html, failureSummary: `${target} failed` } as any;
}

function violation(id: string, nodes: any[]) {
  return {
    id,
    impact: 'serious' as const,
    tags: ['wcag2aa'],
    help: `${id} help`,
    helpUrl: `https://example.com/${id}`,
    description: `${id} description`,
    nodes,
  } as any;
}

describe('axe helpers', () => {
  it('keeps best-practice and experimental opt-in without removing them from the tag list', () => {
    expect(axeTagValues).toContain('best-practice');
    expect(axeTagValues).toContain('experimental');
    expect(defaultAxeTags).not.toContain('best-practice');
    expect(defaultAxeTags).not.toContain('experimental');
  });

  // Axe matches `runOnly` tags with OR, so omitting the `best-practice` tag is
  // not enough on its own: `region` (cat.keyboard + best-practice) and
  // `landmark-one-main` (cat.semantics + best-practice) come back in via their
  // category tag. Assert against axe's own rule metadata rather than the tag
  // list, so this fails the moment a cat.* tag creeps back into the default.
  it('selects no best-practice rule with the default tag set', async () => {
    const axeCore = (await import('axe-core')).default;
    const defaults = new Set<string>(defaultAxeTags);
    const selected = axeCore.getRules().filter(rule => rule.tags.some(tag => defaults.has(tag)));

    expect(selected.length).toBeGreaterThan(0);
    expect(selected.filter(rule => rule.tags.includes('best-practice')).map(rule => rule.ruleId)).toEqual([]);
    // Sanity check that the metadata really does carry those rules.
    const allRuleIds = axeCore.getRules().map(rule => rule.ruleId);
    expect(allRuleIds).toContain('region');
    expect(allRuleIds).toContain('landmark-one-main');
  });

  // Pins a deliberate decision rather than a bug: `experimental` marks how
  // settled a heuristic is, not whether the criterion is real, so the few
  // experimental rules carrying a `wcag*` tag stay in the conformance default.
  // Fails if that set changes, so README and comment can be updated with it.
  it('keeps experimental rules that map to a WCAG criterion in the default set', async () => {
    const axeCore = (await import('axe-core')).default;
    const defaults = new Set<string>(defaultAxeTags);
    const experimental = axeCore.getRules()
        .filter(rule => rule.tags.includes('experimental') && rule.tags.some(tag => defaults.has(tag)))
        .map(rule => rule.ruleId)
        .sort();

    expect(experimental).toEqual([
      'css-orientation-lock',
      'p-as-heading',
      'table-fake-caption',
      'td-has-header',
    ]);
  });

  it('keeps label-content-name-mismatch in the default conformance rule set', async () => {
    const axeCore = (await import('axe-core')).default;
    const selected = axeCore.getRules([...defaultAxeTags]).map(rule => rule.ruleId);

    expect(selected).toContain('label-content-name-mismatch');
  });

  it('dedupes nodes by target and html', () => {
    const nodes = [node('#a', '<a>'), node('#a', '<a>'), node('#a', '<b>'), node('#b', '<a>')];
    expect(dedupeAxeNodes(nodes)).toHaveLength(3);
  });

  it('trims node lists per violation and normalizes missing fields', () => {
    const trimmed = trimAxeResults([violation('rule', [node('#a', '<a>'), node('#b', '<b>'), node('#c', '<c>')])], {
      maxNodesPerViolation: 2,
    });
    expect(trimmed[0].nodes).toHaveLength(2);
    expect(trimmed[0].nodes[0]).toEqual({ target: ['#a'], html: '<a>', failureSummary: '#a failed' });
  });

  it('prepareAxeResults dedupes once and trims from the deduped list', () => {
    const { deduped, trimmed } = prepareAxeResults(
        [violation('rule', [node('#a', '<a>'), node('#a', '<a>'), node('#b', '<b>')])],
        10
    );
    expect(deduped[0].nodes).toHaveLength(2);
    expect(trimmed[0].nodes).toHaveLength(2);
  });

  it('scans the whole page with the default tag set when given no options', async () => {
    resetScan();
    await runAxeScan(fakePage());
    expect(scanCalls).toEqual([{
      url: 'https://example.com/',
      context: { exclude: [] },
      options: { runOnly: { type: 'tag', values: [...defaultAxeTags] }, resultTypes: ['violations', 'incomplete'] },
    }]);
  });

  it('runs explicit rule ids instead of tags, because axe runOnly holds only one of them', async () => {
    resetScan();
    await runAxeScan(fakePage(), { tags: ['wcag2aa'], rules: ['image-alt', 'label'] });
    // A tag list would overwrite the rule list in axe's single runOnly slot.
    expect(scanCalls[0].options).toEqual({ runOnly: { type: 'rule', values: ['image-alt', 'label'] }, resultTypes: ['violations', 'incomplete'] });
  });

  it('rejects an explicitly empty rule list instead of silently scanning the full tag set', async () => {
    resetScan();
    // "Run only these rules: none" is a contradiction; falling back to tags
    // would scan far more than the caller asked for.
    await expect(runAxeScan(fakePage(), { tags: ['wcag2aa'], rules: [] }))
        .rejects.toThrow(/withRules is an empty list/);
    expect(scanCalls).toEqual([]);
  });

  it('rejects an empty withRules list at the schema layer too', () => {
    const schema = z.object(axeRuleSchemaShape);
    expect(schema.safeParse({ withRules: [] }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ withRules: ['image-alt'] }).success).toBe(true);
    // An empty disableRules means "disable nothing", which is harmless.
    expect(schema.safeParse({ disableRules: [] }).success).toBe(true);
  });

  it('composes disableRules with tags', async () => {
    resetScan();
    await runAxeScan(fakePage(), { tags: ['wcag2aa'], disableRules: ['color-contrast'] });
    expect(scanCalls[0].options).toEqual({
      runOnly: { type: 'tag', values: ['wcag2aa'] },
      rules: { 'color-contrast': { enabled: false } },
      resultTypes: ['violations', 'incomplete'],
    });
  });

  it('subtracts disableRules from an explicit rule list rather than relying on axe', async () => {
    resetScan();
    // axe ignores the per-rule enabled flag once runOnly holds a rule list, so
    // passing both through would still have run `label`.
    await runAxeScan(fakePage(), { rules: ['image-alt', 'label'], disableRules: ['label'] });
    expect(scanCalls[0].options).toEqual({ runOnly: { type: 'rule', values: ['image-alt'] }, resultTypes: ['violations', 'incomplete'] });
  });

  it('refuses a rule list that disableRules empties, instead of silently scanning everything', async () => {
    resetScan();
    await expect(runAxeScan(fakePage(), { rules: ['image-alt'], disableRules: ['image-alt'] }))
        .rejects.toThrow(/disableRules disabled every rule in withRules \(image-alt\)/);
    expect(scanCalls).toEqual([]);
  });

  it('rejects an unknown rule id in withRules instead of scanning nothing', async () => {
    resetScan();
    await expect(runAxeScan(fakePage(), { rules: ['image-alt', 'image-altt'] }))
        .rejects.toThrow(/Unknown Axe rule id\(s\) in withRules: image-altt/);
    expect(scanCalls).toEqual([]);
  });

  it('rejects an unknown rule id in disableRules instead of disabling nothing', async () => {
    resetScan();
    await expect(runAxeScan(fakePage(), { disableRules: ['colour-contrast'] }))
        .rejects.toThrow(/Unknown Axe rule id\(s\) in disableRules: colour-contrast/);
    expect(scanCalls).toEqual([]);
  });

  it('validates rule ids before touching the page, so a bad id cannot cost a scan', async () => {
    resetScan();
    const page = { evaluate: () => { throw new Error('page should not be touched'); } } as any;
    await expect(runAxeScan(page, { rules: ['nope'], include: ['#content'] }))
        .rejects.toThrow(/Unknown Axe rule id/);
  });

  it('accepts every rule id axe-core actually ships', async () => {
    resetScan();
    // Guards against the catalogue check drifting from the injected axe build.
    await runAxeScan(fakePage(), { rules: ['color-contrast', 'region', 'frame-tested', 'aria-allowed-attr'] });
    expect(scanCalls[0].options.runOnly.values).toHaveLength(4);
  });

  it('validates rule options without a page, so crawlers can check them before navigating', () => {
    expect(assertRuleOptionsValid({})).toEqual([]);
    expect(() => assertRuleOptionsValid({ rules: [] })).toThrow(/withRules is an empty list/);
    expect(assertRuleOptionsValid({ disableRules: ['color-contrast'] })).toEqual([]);
    expect(assertRuleOptionsValid({ rules: ['image-alt', 'label'], disableRules: ['label'] })).toEqual(['image-alt']);
    expect(() => assertRuleOptionsValid({ rules: ['image-altt'] }))
        .toThrow(/Unknown Axe rule id\(s\) in withRules: image-altt/);
    expect(() => assertRuleOptionsValid({ disableRules: ['colour-contrast'] }))
        .toThrow(/Unknown Axe rule id\(s\) in disableRules: colour-contrast/);
    expect(() => assertRuleOptionsValid({ rules: ['image-alt'], disableRules: ['image-alt'] }))
        .toThrow(/disableRules disabled every rule in withRules \(image-alt\)/);
  });

  it('validates rule ids against the exact axe-core build it injects', async () => {
    // The rule catalogue, the injected source and the Node-side finishRun are
    // the same module, and the exact pin keeps a lockfile-less install from
    // resolving a different one.
    const [ownPackage, installedAxeCore] = await Promise.all([
      import('../package.json', { with: { type: 'json' } }),
      import('axe-core/package.json', { with: { type: 'json' } }),
    ]);
    expect(ownPackage.default.dependencies['axe-core']).toBe(installedAxeCore.default.version);
  });

  it('documents the codegen command with the pinned Playwright version', async () => {
    // The recorded storage state should come from the same Playwright the
    // server replays it with, and an unpinned npx command resolves whatever is
    // newest. Fails when the dependency pin moves without the docs.
    const ownPackage = await import('../package.json', { with: { type: 'json' } });
    const playwrightPin = ownPackage.default.dependencies.playwright;
    for (const file of ['../README.md', '../SKILL.md']) {
      const text = fs.readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf-8');
      const codegenCommands = text.match(/npx playwright\S* codegen/g) ?? [];
      expect(codegenCommands.length).toBeGreaterThan(0);
      for (const command of codegenCommands)
        expect(command).toBe(`npx playwright@${playwrightPin} codegen`);
    }
  });

  it('applies include and exclude selectors as the scan context', async () => {
    resetScan();
    await runAxeScan(fakePage({ '#checkout': 1, '#summary': 2, '#cookie-banner': 1 }), {
      tags: ['wcag2aa'],
      include: ['#checkout', '#summary'],
      exclude: ['#cookie-banner'],
    });
    expect(scanCalls[0].options).toEqual({ runOnly: { type: 'tag', values: ['wcag2aa'] }, resultTypes: ['violations', 'incomplete'] });
    expect(scanCalls[0].context).toEqual({ include: ['#checkout', '#summary'], exclude: ['#cookie-banner'] });
  });

  it('fails instead of silently narrowing when one of several include selectors matches nothing', async () => {
    resetScan();
    // Axe itself only errors when the whole include set is empty, so this is
    // the case that would otherwise produce a clean but half-scoped report.
    await expect(runAxeScan(fakePage({ '#checkout': 1, '#billing-summry': 0 }), {
      include: ['#checkout', '#billing-summry'],
    })).rejects.toThrow(/No elements matched includeSelectors: #billing-summry/);
    expect(scanCalls).toEqual([]);
  });

  it('rejects CSS the browser cannot parse, for includes and excludes alike', async () => {
    resetScan();
    await expect(runAxeScan(fakePage({ '#ok': 1, ':::bad': -1 }), {
      include: ['#ok'],
      exclude: [':::bad'],
    })).rejects.toThrow(/Invalid CSS in excludeSelectors: :::bad/);
  });

  it('allows an exclude selector that matches nothing on this page', async () => {
    resetScan();
    // A crawl legitimately hits pages without the excluded widget.
    await runAxeScan(fakePage({ '#cookie-banner': 0 }), { exclude: ['#cookie-banner'] });
    expect(scanCalls[0].context).toEqual({ include: [], exclude: ['#cookie-banner'] });
  });

  it('runs each child frame with the context axe chose for it, not the top-level one', async () => {
    resetScan();
    const widgetContext = { include: [['main']], exclude: [['.ad']], initiator: false, focusable: true, size: { width: 300, height: 150 } };
    const widget = makeFrame('https://widget.example/');
    const main = makeFrame('https://example.com/', { children: [child('iframe#widget', widget, { context: widgetContext })] });
    await runAxeScan(fakePage({ '#main': 1 }, main), { include: ['#main'] });

    expect(scanCalls.map(call => [call.url, call.context])).toEqual([
      ['https://example.com/', { include: ['#main'], exclude: [] }],
      ['https://widget.example/', widgetContext],
    ]);
  });

  it('hands finishRun every frame depth-first, children before the next sibling', async () => {
    resetScan();
    const finishRun = vi.spyOn(axeCore, 'finishRun');
    const nested = makeFrame('https://example.com/a1');
    const first = makeFrame('https://example.com/a', { children: [child('iframe', nested)] });
    const second = makeFrame('https://example.com/b');
    const main = makeFrame('https://example.com/', { children: [child('#a', first), child('#b', second)] });
    await runAxeScan(fakePage({}, main));

    // finishRun pairs results with frames purely by position, so the order is
    // the contract: top, a, a1, b (not top, a, b, a1).
    const partials = finishRun.mock.calls[0][0] as unknown as ({ marker: string } | null)[];
    expect(partials.map(partial => partial?.marker)).toEqual(['https://example.com/', 'https://example.com/a', 'https://example.com/a1', 'https://example.com/b']);
  });

  it.each([
    ['injection fails', { injection: 'throws' }],
    ['the frame run fails', { run: 'throws' }],
  ] as const)('reports a child frame whose %s, and passes finishRun a null in its place', async (_label, behavior) => {
    resetScan();
    const finishRun = vi.spyOn(axeCore, 'finishRun');
    // A frame that navigates mid-scan contributes no violations, and a report
    // that stays silent about it reads as a clean scan of the whole page.
    const broken = makeFrame('https://example.com/widget', behavior);
    const main = makeFrame('https://example.com/', { children: [child('iframe', broken)] });
    const result = await runAxeScan(fakePage({}, main));

    expect(result.unscannedFrames).toEqual(['https://example.com/widget']);
    expect(finishRun.mock.calls[0][0]).toEqual([expect.objectContaining({ environmentData: expect.anything() }), null]);
  });

  it.each([
    ['injection', { injection: 'hangs' }, 1000],
    ['timers', { liveness: 'hangs' }, 500],
    ['run', { run: 'hangs' }, 60_000],
  ] as const)('bounds a child frame whose %s never settles, leaving no timer behind', async (_label, behavior, budgetMs) => {
    resetScan();
    vi.useFakeTimers();
    const stuck = makeFrame('https://example.com/stuck', behavior);
    const main = makeFrame('https://example.com/', { children: [child('iframe', stuck)] });
    let settled = false;
    const scan = runAxeScan(fakePage({}, main)).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(budgetMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await scan).unscannedFrames).toEqual(['https://example.com/stuck']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a hung nested frame alone, keeping its parent and sibling findings', async () => {
    resetScan();
    vi.useFakeTimers();
    const finishRun = vi.spyOn(axeCore, 'finishRun');
    const nested = makeFrame('https://example.com/nested', { run: 'hangs' });
    const outer = makeFrame('https://example.com/outer', { children: [child('iframe', nested)] });
    const sibling = makeFrame('https://example.com/sibling');
    const main = makeFrame('https://example.com/', { children: [child('#outer', outer), child('#sibling', sibling)] });
    const scan = runAxeScan(fakePage({}, main));
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await scan;

    // The run budget covers one frame's own runPartial, so the outer frame,
    // which finished, keeps its results; only the nested frame is a gap.
    expect(result.unscannedFrames).toEqual(['https://example.com/nested']);
    const partials = finishRun.mock.calls[0][0] as unknown as ({ marker: string } | null)[];
    expect(partials.map(partial => partial?.marker ?? null)).toEqual(['https://example.com/', 'https://example.com/outer', null, 'https://example.com/sibling']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves each child through the element captured with its slot, never by re-querying a selector', async () => {
    resetScan();
    const finishRun = vi.spyOn(axeCore, 'finishRun');
    // Positional selectors like iframe:nth-child(2) can point at another frame
    // once an earlier sibling is removed. The element captured during
    // selection cannot, so the only page call per frame is its own scan.
    const first = makeFrame('https://example.com/first');
    const second = makeFrame('https://example.com/second');
    const main = makeFrame('https://example.com/', { children: [child('iframe:nth-child(1)', first), child('iframe:nth-child(2)', second)] });
    await runAxeScan(fakePage({}, main));

    expect(main.evaluateHandle).toHaveBeenCalledTimes(1);
    const partials = finishRun.mock.calls[0][0] as unknown as ({ marker: string } | null)[];
    expect(partials.map(partial => partial?.marker)).toEqual(['https://example.com/', 'https://example.com/first', 'https://example.com/second']);
  });

  it('omits the descendants of a frame that failed, as finishRun requires', async () => {
    resetScan();
    const finishRun = vi.spyOn(axeCore, 'finishRun');
    // The outer frame never ran, so axe never named its children: the scan
    // cannot reach them and must not invent results for them either.
    const nested = makeFrame('https://example.com/nested');
    const outer = makeFrame('https://example.com/outer', { run: 'throws', children: [child('iframe', nested)] });
    const sibling = makeFrame('https://example.com/sibling');
    const main = makeFrame('https://example.com/', { children: [child('#outer', outer), child('#sibling', sibling)] });
    const result = await runAxeScan(fakePage({}, main));

    expect(result.unscannedFrames).toEqual(['https://example.com/outer']);
    expect(finishRun.mock.calls[0][0]).toHaveLength(3);
    expect(finishRun.mock.calls[0][0][1]).toBeNull();
    expect(scanCalls.map(call => call.url)).not.toContain('https://example.com/nested');
  });

  it('reports a selected frame whose element resolves to no browsing context', async () => {
    resetScan();
    const main = makeFrame('https://example.com/', { name: 'top', children: [child('html > body > iframe:nth-child(2)', null)] });
    const result = await runAxeScan(fakePage({}, main));

    expect(result.unscannedFrames).toEqual(['https://example.com/ (name="top") > html > body > iframe:nth-child(2)']);
  });

  it('reports a selected frame whose element was already gone when it was captured', async () => {
    resetScan();
    const finishRun = vi.spyOn(axeCore, 'finishRun');
    const main = makeFrame('https://example.com/', { children: [child('#gone', null, { element: 'missing' })] });
    const result = await runAxeScan(fakePage({}, main));

    expect(result.unscannedFrames).toEqual(['https://example.com/ > #gone']);
    expect(finishRun.mock.calls[0][0][1]).toBeNull();
  });

  it('joins a shadow-piercing frame selector when describing an unresolved frame', async () => {
    resetScan();
    const main = makeFrame('https://example.com/', { children: [{ selector: ['#host', 'iframe'], frame: null }] });
    const result = await runAxeScan(fakePage({}, main));

    expect(result.unscannedFrames).toEqual(['https://example.com/ > #host >>> iframe']);
  });

  it.each(['ok', 'throws', 'hangs'] as const)('disposes the frame element handle after a lookup that %s', async lookup => {
    resetScan();
    vi.useFakeTimers();
    const widget = makeFrame('https://example.com/widget');
    const main = makeFrame('https://example.com/', { children: [child('iframe', widget, { lookup })] });
    const scan = runAxeScan(fakePage({}, main));
    await vi.runAllTimersAsync();
    const result = await scan;

    expect(result.unscannedFrames).toEqual(lookup === 'ok' ? [] : ['https://example.com/ > iframe']);
    expect(main.handles).toHaveLength(1);
    for (const handle of main.handles)
      expect(handle.dispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('limits how many sibling frames run at once', async () => {
    resetScan();
    let active = 0;
    let maxActive = 0;
    const frames = Array.from({ length: 10 }, (_, index) => {
      const frame = makeFrame(`https://example.com/${index}`);
      const scan = frame.evaluateHandle.getMockImplementation()!;
      frame.evaluateHandle.mockImplementation(async (script: unknown, arg: any) => {
        maxActive = Math.max(maxActive, ++active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
        return scan(script, arg);
      });
      return frame;
    });
    const main = makeFrame('https://example.com/', { children: frames.map((frame, index) => child(`#f${index}`, frame)) });
    expect((await runAxeScan(fakePage({}, main))).unscannedFrames).toEqual([]);
    expect(maxActive).toBe(4);
  });

  it('reports a frame axe never saw because it sits in a closed shadow root', async () => {
    resetScan();
    const hiddenFromAxe = makeFrame('https://widget.example/closed', { closedShadow: () => true });
    const skippedOnPurpose = makeFrame('https://example.com/hidden', { closedShadow: () => false });
    const visited = makeFrame('https://example.com/visited');
    const main = makeFrame('https://example.com/', { children: [child('iframe', visited)], unvisited: [hiddenFromAxe, skippedOnPurpose] });

    expect((await runAxeScan(fakePage({}, main))).unscannedFrames).toEqual(['https://widget.example/closed']);
  });

  it('checks for closed-shadow frames on a page scanned without the frame walk too', async () => {
    resetScan();
    // getFrameContexts names no frame here, so the page takes the plain
    // axe.run path, yet the frame in the closed shadow root is still a gap.
    const hiddenFromAxe = makeFrame('https://widget.example/closed', { closedShadow: () => true });
    const main = makeFrame('https://example.com/', { unvisited: [hiddenFromAxe] });

    expect((await runAxeScan(fakePage({}, main))).unscannedFrames).toEqual(['https://widget.example/closed']);
  });

  it('applies the caller scope to top-level closed-shadow frames only', async () => {
    resetScan();
    const scopes: { url: string, scope: unknown }[] = [];
    const record = (url: string) => (scope: unknown) => {
      scopes.push({ url, scope });
      return false;
    };
    const nestedClosed = makeFrame('https://example.com/nested-closed', { closedShadow: record('nested') });
    const outer = makeFrame('https://example.com/outer', { unvisited: [nestedClosed] });
    const topClosed = makeFrame('https://example.com/top-closed', { closedShadow: record('top') });
    const main = makeFrame('https://example.com/', { children: [child('#outer', outer)], unvisited: [topClosed] });
    await runAxeScan(fakePage({ '#main': 1, '.ad': 1 }, main), { include: ['#main'], exclude: ['.ad'] });

    // The caller's selectors name elements in the top document; inside a frame
    // axe already scanned, everything is in scope.
    expect(scopes).toEqual(expect.arrayContaining([
      { url: 'top', scope: { include: ['#main'], exclude: ['.ad'] } },
      { url: 'nested', scope: { include: [], exclude: [] } },
    ]));
  });

  it.each(['throws', 'hangs'] as const)('does not list an unvisited frame whose element read %s', async frameElement => {
    resetScan();
    vi.useFakeTimers();
    // Usually a frame that detached mid-scan; most unvisited frames are ones
    // axe skipped on purpose, so an unreadable one is not called a gap.
    const unreadable = makeFrame('https://example.com/gone', { frameElement, closedShadow: () => true });
    const main = makeFrame('https://example.com/', { unvisited: [unreadable] });
    const scan = runAxeScan(fakePage({}, main));
    await vi.runAllTimersAsync();

    expect((await scan).unscannedFrames).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps and truncates an author-controlled frame name', async () => {
    resetScan();
    // The name attribute is author-controlled and unbounded, and can carry a
    // data URL of its own.
    const noisy = makeFrame('https://example.com/widget', { injection: 'throws', name: `promo data:text/html;base64,${'A'.repeat(4000)}` });
    const result = await runAxeScan(fakePage({}, makeFrame('https://example.com/', { children: [child('iframe', noisy)] })));

    expect(result.unscannedFrames).toEqual(['https://example.com/widget (name="promo data:text/html;base64,...")']);
  });

  it('counts every failed frame, even when they describe identically', async () => {
    resetScan();
    // Two unnamed about:blank frames are two documents that went unscanned;
    // collapsing them would under-count the coverage gap.
    const first = makeFrame('about:blank', { injection: 'throws' });
    const second = makeFrame('', { injection: 'throws' });
    const result = await runAxeScan(fakePage({}, makeFrame('https://example.com/', { children: [child('#a', first), child('#b', second)] })));

    expect(result.unscannedFrames).toEqual(['about:blank', 'about:blank']);
  });

  it.each([
    [`data:text/html;base64,${'A'.repeat(5000)}`, 'data:text/html;base64,...'],
    [`https://example.com/frame?src=data:text/html;base64,${'A'.repeat(5000)}`, 'https://example.com/frame?src=data:text/html;base64,...'],
  ])('truncates a data URL in a failed frame URL rather than echoing the whole document', async (url, expected) => {
    resetScan();
    // A data: frame's URL is its document, and this string reaches tool text,
    // structured content and the JSON reports.
    const dataFrame = makeFrame(url, { injection: 'throws' });
    const result = await runAxeScan(fakePage({}, makeFrame('https://example.com/', { children: [child('iframe', dataFrame)] })));

    expect(result.unscannedFrames).toEqual([expected]);
  });

  it('caps an ordinary failed frame URL', async () => {
    resetScan();
    const frame = makeFrame(`https://example.com/frame?value=${'A'.repeat(5000)}`, { injection: 'throws' });
    const [url] = (await runAxeScan(fakePage({}, makeFrame('https://example.com/', { children: [child('iframe', frame)] })))).unscannedFrames;

    expect(url).toHaveLength(2048);
    expect(url).toMatch(/^https:\/\/example\.com\/frame\?value=A+\.\.\.$/);
  });

  it('rethrows a top-frame scan failure untouched', async () => {
    resetScan();
    const failure = new Error('axe run failed');
    runFailure = failure;
    await expect(runAxeScan(fakePage({}, makeFrame('https://example.com/', { run: 'throws' })))).rejects.toBe(failure);
  });

  it('summarizes counts by impact and rule id', () => {
    const trimmed = trimAxeResults([violation('rule-a', [node('#a', '<a>')]), violation('rule-b', [node('#b', '<b>'), node('#c', '<c>')])], {
      maxNodesPerViolation: 10,
    });
    expect(summarizeAxeViolations(trimmed)).toEqual({
      totalRules: 2,
      totalNodes: 3,
      byImpact: { serious: 3 },
      byRuleId: { 'rule-a': 1, 'rule-b': 2 },
    });
  });
});

describe.skipIf(!fs.existsSync(chromium.executablePath()))('axe frame coverage in a real browser', () => {
  async function withPage<T>(run: (page: Page) => Promise<T>): Promise<T> {
    const browser = await chromium.launch({ headless: true, chromiumSandbox: false });
    try {
      return await run(await browser.newPage());
    } finally {
      await browser.close();
    }
  }

  async function setContentWithFrames(page: Page, html: string, frameCount: number) {
    await page.setContent(html);
    await expect.poll(() => page.frames().length).toBe(frameCount + 1);
    await Promise.all(page.frames().map(frame => frame.waitForLoadState()));
  }

  const targetsOf = (rules: { id: string, nodes: { target: unknown }[] }[], id: string) =>
    rules.find(rule => rule.id === id)?.nodes.map(node => node.target) ?? [];

  it('preserves incomplete findings and their nodes from the browser scan', async () => {
    await withPage(async page => {
      await page.setContent('<html lang="en"><title>Contrast fixture</title><p id="gradient" style="background:linear-gradient(white,black);color:gray">Gradient background text</p></html>');

      const result = await runAxeScan(page, { rules: ['color-contrast'] });

      expect(result.violations).toEqual([]);
      expect(result.incomplete).toEqual([expect.objectContaining({
        id: 'color-contrast',
        nodes: [expect.objectContaining({
          target: ['#gradient'],
          failureSummary: expect.stringContaining('background gradient'),
        })],
      })]);
      expect(result.incomplete[0].nodes[0]).not.toHaveProperty('any');
    });
  });

  it('matches axe.run with frame messaging on a nested same-origin frame tree', async () => {
    await withPage(async page => {
      const inner = `<h3>Skipped level</h3><img src='inner.png'><iframe srcdoc='<img src=deep.png>'></iframe>`;
      await setContentWithFrames(page, `<main><h1>Top</h1><img src="top.png"><iframe id="a" srcdoc="${inner}"></iframe><iframe hidden srcdoc="<img src=hidden.png>"></iframe><iframe id="b" srcdoc="<button></button>"></iframe></main>`, 4);
      const options = { tags: ['wcag2a', 'wcag2aa', 'best-practice'] as const };

      const scan = await runAxeScan(page, options);

      // The reference: the integration this replaced, with axe.run in the top
      // frame relaying to every other frame over postMessage.
      const source = `${axeCore.source};axe.configure({ allowedOrigins: ['<unsafe_all_origins>'], branding: { application: 'playwright' } });`;
      await Promise.all(page.frames().map(frame => frame.evaluate(source)));
      const reference = await page.evaluate(async tags => {
        const results = await (window as any).axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations', 'incomplete'] });
        const findings = (rules: any[]) => rules.map(rule => ({ id: rule.id, impact: rule.impact, tags: rule.tags, help: rule.help, helpUrl: rule.helpUrl, description: rule.description, nodes: rule.nodes.map((node: any) => ({ target: node.target, html: node.html, failureSummary: node.failureSummary ?? null })) }));
        return { violations: findings(results.violations), incomplete: findings(results.incomplete) };
      }, [...options.tags]);

      expect(scan.violations).toEqual(reference.violations);
      expect(scan.incomplete).toEqual(reference.incomplete);
      expect(scan.unscannedFrames).toEqual([]);
      // Spot-check the cross-frame parts: nested targets, and heading-order's
      // after-check, which only works once every frame's results are merged.
      expect(targetsOf(scan.violations, 'image-alt')).toEqual([['img'], ['#a', 'img'], ['#a', 'iframe', 'img']]);
      expect(targetsOf(scan.violations, 'heading-order')).toEqual([['#a', 'h3']]);
    });
  });

  it('reports a frame-free page the same way whichever path scans it', async () => {
    await withPage(async page => {
      const body = '<main><h1>Title</h1><h4>Skipped</h4><img src="a.png"><a href="#"></a><input></main>';
      await page.setContent(`<html><title>Paths</title>${body}</html>`);
      const plainRun = await runAxeScan(page);
      // An empty, titled frame adds no findings, but sends the scan down the
      // runPartial walk and through finishRun in Node.
      await setContentWithFrames(page, `<html><title>Paths</title>${body}<iframe title="Empty" srcdoc="<html lang=en><title>Empty</title></html>"></iframe></html>`, 1);
      const partialRun = await runAxeScan(page);

      // The root element's snippet differs only by the added iframe markup.
      const withoutRootHtml = (rules: typeof plainRun.violations) => rules.map(rule => ({
        ...rule,
        nodes: rule.nodes.map(node => JSON.stringify(node.target) === '["html"]' ? { ...node, html: '<html>' } : node),
      }));
      expect(withoutRootHtml(partialRun.violations)).toEqual(withoutRootHtml(plainRun.violations));
      expect(partialRun.incomplete).toEqual(plainRun.incomplete);
      expect(plainRun.violations.map(rule => rule.id).sort()).toEqual(['html-has-lang', 'image-alt', 'label', 'link-name']);
      expect(plainRun.violations[0].helpUrl).toContain('application=playwright');
    });
  });

  it('scans a cross-origin frame without opening frame messaging to every origin', async () => {
    const server = http.createServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      const { port } = server.address() as AddressInfo;
      response.end(request.url === '/frame'
        ? '<html lang="en"><title>Widget</title><img id="cross-origin-image" src="x.png"></html>'
        : `<html lang="en"><title>Host</title><iframe title="Widget" src="http://localhost:${port}/frame"></iframe></html>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await withPage(async page => {
        const { port } = server.address() as AddressInfo;
        await page.goto(`http://127.0.0.1:${port}/`);
        await expect.poll(() => page.frames()[1]?.url()).toBe(`http://localhost:${port}/frame`);
        await page.frames()[1].waitForLoadState();

        const result = await runAxeScan(page, { rules: ['image-alt'] });

        expect(targetsOf(result.violations, 'image-alt')).toEqual([['iframe', '#cross-origin-image']]);
        expect(result.unscannedFrames).toEqual([]);
        // Nothing in either document was told to accept axe messages from
        // arbitrary origins, and the page's own `axe` global stays untouched.
        expect(await page.evaluate(() => 'axe' in window)).toBe(false);
      });
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('keeps a page-owned axe and survives a page that hijacks postMessage', async () => {
    await withPage(async page => {
      await setContentWithFrames(page, `<html lang="en"><title>Hostile</title><iframe title="Child" srcdoc="<img src=x.png>"></iframe></html>`, 1);
      await page.evaluate(() => {
        (window as any).axe = { version: 'page-owned' };
        window.postMessage = () => {
          throw new Error('postMessage is not for you');
        };
      });

      const result = await runAxeScan(page, { rules: ['image-alt'] });

      expect(targetsOf(result.violations, 'image-alt')).toEqual([['iframe', 'img']]);
      expect(await page.evaluate(() => (window as any).axe.version)).toBe('page-owned');
    });
  });

  it('reports a frame axe selected but cannot run script in', async () => {
    await withPage(async page => {
      // A sandbox without allow-scripts accepts injected code but never fires
      // its timers, so axe.runPartial would never settle there. axe.run would
      // have skipped it silently once its ping timed out.
      await setContentWithFrames(page, '<iframe id="locked" sandbox srcdoc="<img src=x.png>"></iframe><iframe id="open" srcdoc="<img src=y.png>"></iframe>', 2);

      const started = Date.now();
      const result = await runAxeScan(page, { rules: ['image-alt'] });

      expect(Date.now() - started).toBeLessThan(5000);
      expect(result.unscannedFrames).toEqual(['about:srcdoc (name="locked")']);
      expect(targetsOf(result.violations, 'image-alt')).toEqual([['#open', 'img']]);
    });
  });

  it('neither scans nor reports frames axe leaves out of the context', async () => {
    await withPage(async page => {
      await setContentWithFrames(page, [
        '<main id="main"><iframe id="kept" srcdoc="<img src=kept.png><iframe srcdoc=\'<img src=nested.png>\'></iframe>"></iframe></main>',
        '<iframe class="chat-widget" sandbox srcdoc="<img src=chat.png>"></iframe>',
        '<iframe hidden sandbox srcdoc="<img src=hidden.png>"></iframe>',
        '<div aria-hidden="true"><iframe sandbox srcdoc="<img src=aria-hidden.png>"></iframe></div>',
      ].join(''), 5);

      const result = await runAxeScan(page, { rules: ['image-alt'], exclude: ['iframe.chat-widget'] });

      // Excluded, hidden and aria-hidden frames cannot run script either, yet
      // none of them is a coverage gap: axe would not have scanned them.
      expect(result.unscannedFrames).toEqual([]);
      expect(targetsOf(result.violations, 'image-alt')).toEqual([['#kept', 'img'], ['#kept', 'iframe', 'img']]);
    });
  });

  it('descends into a nested frame when the include names its ancestor frame', async () => {
    await withPage(async page => {
      await setContentWithFrames(page, '<img src="outside.png"><section id="widgets"><iframe srcdoc="<iframe srcdoc=\'<img src=deep.png>\'></iframe>"></iframe></section>', 2);

      const result = await runAxeScan(page, { rules: ['image-alt'], include: ['#widgets'] });

      expect(targetsOf(result.violations, 'image-alt')).toEqual([['iframe', 'iframe', 'img']]);
    });
  });

  it('reports in-scope frames in closed shadow roots, which axe cannot see into', async () => {
    await withPage(async page => {
      await page.setContent([
        '<div id="visible" class="host"></div>',
        '<div id="css-hidden" class="host" style="display:none"></div>',
        '<div id="aria-hidden" class="host" aria-hidden="TRUE"></div>',
        '<div id="chat" class="host"></div>',
        '<div id="details-host"></div>',
        '<iframe id="outer" title="Outer" srcdoc="<div id=inner-host></div>"></iframe>',
      ].join(''));
      await expect.poll(() => page.frames().length).toBe(2);
      await page.frames()[1].waitForLoadState();
      const attach = (frame: typeof page | Awaited<ReturnType<typeof page.frames>>[number], hostSelector: string, name: string) => frame.evaluate(({ hostSelector, name }) => {
        const iframe = document.createElement('iframe');
        iframe.name = name;
        iframe.srcdoc = '<img src=x.png>';
        document.querySelector(hostSelector)!.attachShadow({ mode: 'closed' }).append(iframe);
      }, { hostSelector, name });
      for (const id of ['visible', 'css-hidden', 'aria-hidden', 'chat'])
        await attach(page, `#${id}`, id);
      await attach(page.frames()[1], '#inner-host', 'inner');
      // A <summary> slotted into a closed <details> through a <slot> is not
      // the details' own summary (its first child is the slot), so it stays
      // collapsed and unrendered: checkVisibility() is false and the frame is
      // out of scope, however the light DOM reads.
      await page.evaluate(() => {
        const host = document.querySelector('#details-host')!;
        host.attachShadow({ mode: 'closed' }).innerHTML = '<details><slot></slot></details>';
        const summary = document.createElement('summary');
        const innerHost = document.createElement('span');
        const iframe = document.createElement('iframe');
        iframe.name = 'summary';
        iframe.srcdoc = '<img src=x.png>';
        innerHost.attachShadow({ mode: 'closed' }).append(iframe);
        summary.append(innerHost);
        host.append(summary);
      });
      await expect.poll(() => page.frames().length).toBe(8);

      const result = await runAxeScan(page, { rules: ['image-alt'], exclude: ['#chat'] });

      // Hidden, aria-hidden, collapsed and excluded hosts take their frames out
      // of scope; the rest are gaps axe would never have mentioned on its own.
      expect(result.unscannedFrames.sort()).toEqual(['about:srcdoc (name="inner")', 'about:srcdoc (name="visible")']);
      expect(result.violations).toEqual([]);
    });
  });

});
