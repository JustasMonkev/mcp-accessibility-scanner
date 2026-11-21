import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import axeCore from 'axe-core/axe.min.js';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { assertRuleOptionsValid, axeRuleSchemaShape, axeTagValues, defaultAxeTags, dedupeAxeNodes, prepareAxeResults, runAxeScan, summarizeAxeViolations, trimAxeResults } from '../src/tools/axe.js';

import type { AddressInfo } from 'node:net';
import type { Frame, Page } from 'playwright';

type ScanCall = { url: string; context: any; options: any };
type Behavior = 'ok' | 'throws' | 'hangs';
type FakeFrame = ReturnType<typeof makeFrame>;
type FakeChild = { selector: string | string[]; frame: FakeFrame | null; context?: unknown; lookup?: Behavior; element?: 'missing' };
type FakeFrameOptions = {
  name?: string,
  injection?: Behavior,
  liveness?: 'fires' | 'never' | 'hangs',
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

const frameSpec = (child: FakeChild) => {
  const selector = [child.selector].flat().join(' ');
  return { selector: [selector], ancestry: [selector], xpath: [`/${selector}`], nodeIndexes: [0], source: '<iframe>' };
};

function makeFrame(url = 'https://example.com/', options: FakeFrameOptions = {}) {
  const children = options.children ?? [];
  const handles: { dispose: ReturnType<typeof vi.fn> }[] = [];
  const propertyHandles: Map<string, { dispose: ReturnType<typeof vi.fn> }>[] = [];
  const evaluateHandle = vi.fn(async (_script: unknown, arg: any) => {
    scanCalls.push({ url, context: arg.context, options: arg.options });
    const plainRun = arg.allowPlainRun && !children.length;
    const info = {
      childFrames: children.map(child => ({
        frameSelector: child.selector,
        frameContext: child.context ?? { include: [], exclude: [], initiator: false },
      })),
      frameCount: children.length,
      plainRun,
    };
    const payload = JSON.stringify(plainRun
      ? { url, violations: [], incomplete: [], passes: [], inapplicable: [] }
      : { results: [], frames: children.map(frameSpec), environmentData: arg.context.initiator === false ? undefined : environmentData(url), marker: url });
    const valueHandle = (value: unknown) => ({ jsonValue: async () => value, asElement: () => null, dispose: vi.fn(async () => undefined) });
    const properties = new Map<string, unknown>([['0', valueHandle(info)], ['1', valueHandle(payload)]]);
    children.forEach((child, index) => {
      if (child.element === 'missing') {
        properties.set(String(index + 2), valueHandle(null));
        return;
      }
      const element = {
        contentFrame: () => behave(child.lookup ?? 'ok', child.frame),
        asElement: () => element,
        dispose: vi.fn(async () => undefined),
      };
      handles.push(element);
      properties.set(String(index + 2), element);
    });
    propertyHandles.push(properties as Map<string, { dispose: ReturnType<typeof vi.fn> }>);
    return behave(options.run ?? 'ok', { getProperties: async () => properties, dispose: async () => undefined }, runFailure);
  });
  const frame = {
    url: () => url,
    name: () => options.name ?? '',
    handles,
    propertyHandles,
    evaluateHandle,
    childFrames: () => [...children.flatMap(child => child.frame ? [child.frame] : []), ...(options.unvisited ?? [])],
    frameElement: () => behave(options.frameElement ?? 'ok', {
      evaluate: async (_script: unknown, scope: { include: string[], exclude: string[] }) => options.closedShadow?.(scope) ?? false,
      dispose: async () => undefined,
    }),
    evaluate: async (script: unknown, arg?: any) => {
      if (typeof script === 'string')
        return behave(options.injection ?? 'ok', undefined);
      if ((script as () => unknown).name === 'armLivenessProbe')
        return true;
      const liveness = options.liveness ?? 'fires';
      return liveness === 'hangs' ? new Promise(() => {}) : liveness === 'fires';
    },
  };
  return frame;
}

function fakePage(countBySelector: Record<string, number> = {}, main = makeFrame()) {
  return {
    mainFrame: () => main,
    evaluate: async (_script: unknown, selectors: string[]) => selectors.map(selector => countBySelector[selector] ?? 0),
  } as unknown as Page;
}

function child(selector: string, frame: FakeFrame | null, extra: Partial<FakeChild> = {}): FakeChild {
  return { selector, frame, ...extra };
}

const markersOf = (finishRun: { mock: { calls: unknown[][] } }) =>
  (finishRun.mock.calls[0][0] as ({ marker: string } | null)[]).map(partial => partial?.marker ?? null);

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

  it('leaves frame discovery to the page, so a frame count read beforehand cannot go stale', async () => {
    resetScan();
    const leafFrame = makeFrame('https://example.com/leaf');
    const main = makeFrame('https://example.com/', { children: [child('iframe', leafFrame)] });
    await runAxeScan(fakePage({}, main));

    expect(main.evaluateHandle.mock.calls[0][1]).toEqual({ context: { exclude: [] }, options: expect.anything(), allowPlainRun: true });
    expect(leafFrame.evaluateHandle.mock.calls[0][1]).toEqual({ context: expect.anything(), options: expect.anything(), allowPlainRun: false });
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

  it.each([
    ['injection fails', { injection: 'throws' }],
    ['the frame run fails', { run: 'throws' }],
  ] as const)('reports a child frame whose %s, and passes finishRun a null in its place', async (_label, behavior) => {
    resetScan();
    const finishRun = vi.spyOn(axeCore, 'finishRun');
    const broken = makeFrame('https://example.com/widget', behavior);
    const main = makeFrame('https://example.com/', { children: [child('iframe', broken)] });
    const result = await runAxeScan(fakePage({}, main));

    expect(result.unscannedFrames).toEqual(['https://example.com/widget']);
    expect(finishRun.mock.calls[0][0]).toEqual([expect.objectContaining({ environmentData: expect.anything() }), null]);
  });

  it.each([
    ['injection', { injection: 'hangs' }, 1000],
    ['timers', { liveness: 'never' }, 500],
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

    expect(result.unscannedFrames).toEqual(['https://example.com/nested']);
    expect(markersOf(finishRun)).toEqual(['https://example.com/', 'https://example.com/outer', null, 'https://example.com/sibling']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves each child through the element captured with its slot, never by re-querying a selector', async () => {
    resetScan();
    const finishRun = vi.spyOn(axeCore, 'finishRun');
    const first = makeFrame('https://example.com/first');
    const second = makeFrame('https://example.com/second');
    const main = makeFrame('https://example.com/', { children: [child('iframe:nth-child(1)', first), child('iframe:nth-child(2)', second)] });
    await runAxeScan(fakePage({}, main));

    expect(main.evaluateHandle).toHaveBeenCalledTimes(1);
    expect(markersOf(finishRun)).toEqual(['https://example.com/', 'https://example.com/first', 'https://example.com/second']);
  });

  it('omits the descendants of a frame that failed, as finishRun requires', async () => {
    resetScan();
    const finishRun = vi.spyOn(axeCore, 'finishRun');
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

  it('disposes every scan-result handle except the captured iframe elements, which go once resolved', async () => {
    resetScan();
    const widget = makeFrame('https://example.com/widget');
    const main = makeFrame('https://example.com/', { children: [child('#widget', widget), child('#gone', null, { element: 'missing' })] });
    await runAxeScan(fakePage({}, main));

    const [slots] = main.propertyHandles;
    for (const key of ['0', '1', '3'])
      expect(slots.get(key)!.dispose).toHaveBeenCalledTimes(1);
    expect(slots.get('2')!.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes every scan-result handle when the result cannot be read', async () => {
    resetScan();
    const widget = makeFrame('https://example.com/widget');
    const main = makeFrame('https://example.com/', { children: [child('#widget', widget)] });
    const scan = main.evaluateHandle.getMockImplementation()!;
    main.evaluateHandle.mockImplementation(async (script: unknown, arg: any) => {
      const result = await scan(script, arg) as { getProperties: () => Promise<Map<string, any>> };
      const properties = await result.getProperties();
      properties.get('1').jsonValue = async () => {
        throw new Error('Target page, context or browser has been closed');
      };
      return result;
    });

    await expect(runAxeScan(fakePage({}, main))).rejects.toThrow('has been closed');
    for (const handle of main.propertyHandles[0].values())
      expect(handle.dispose).toHaveBeenCalledTimes(1);
  });

  it('bounds frame scans across the whole tree, not per parent, and releases a slot before descending', async () => {
    resetScan();
    let active = 0;
    let maxActive = 0;
    const slowFrame = (url: string, children: FakeChild[] = []) => {
      const frame = makeFrame(url, { children });
      const scan = frame.evaluateHandle.getMockImplementation()!;
      frame.evaluateHandle.mockImplementation(async (script: unknown, arg: any) => {
        maxActive = Math.max(maxActive, ++active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
        return scan(script, arg);
      });
      return frame;
    };
    const children = Array.from({ length: 4 }, (_, outer) => child(`#f${outer}`, slowFrame(
        `https://example.com/${outer}`,
        Array.from({ length: 4 }, (_, inner) => child(`#g${inner}`, slowFrame(`https://example.com/${outer}/${inner}`))),
    )));
    const main = makeFrame('https://example.com/', { children });
    const result = await runAxeScan(fakePage({}, main));

    expect(result.unscannedFrames).toEqual([]);
    expect(scanCalls).toHaveLength(1 + 4 + 16);
    expect(maxActive).toBe(4);
  });

  it('bounds a frame whose timer check never answers by the check budget, not the run budget', async () => {
    resetScan();
    vi.useFakeTimers();
    const stuck = makeFrame('https://example.com/stuck', { liveness: 'hangs' });
    const main = makeFrame('https://example.com/', { children: [child('iframe', stuck)] });
    let settled = false;
    const scan = runAxeScan(fakePage({}, main)).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1024);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect((await scan).unscannedFrames).toEqual(['https://example.com/stuck']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares the scan-wide frame limit with the closed-shadow coverage reads', async () => {
    resetScan();
    let active = 0;
    let maxActive = 0;
    const track = async <T>(work: () => T): Promise<T> => {
      maxActive = Math.max(maxActive, ++active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return work();
    };
    const parents = Array.from({ length: 8 }, (_, outer) => {
      const unvisited = Array.from({ length: 8 }, (_, inner) => {
        const closed = makeFrame(`https://example.com/${outer}/closed-${inner}`, { closedShadow: () => true });
        const read = closed.frameElement;
        closed.frameElement = async () => {
          const element = await read();
          return { ...element, evaluate: (script: unknown, scope: { include: string[], exclude: string[] }) => track(() => element.evaluate(script, scope)) };
        };
        return closed;
      });
      const parent = makeFrame(`https://example.com/${outer}`, { unvisited });
      const scan = parent.evaluateHandle.getMockImplementation()!;
      parent.evaluateHandle.mockImplementation((script: unknown, arg: any) => track(() => scan(script, arg)));
      return parent;
    });
    const main = makeFrame('https://example.com/', { children: parents.map((parent, index) => child(`#p${index}`, parent)) });
    const result = await runAxeScan(fakePage({}, main));

    expect(result.unscannedFrames).toHaveLength(64);
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

    expect(scopes).toEqual(expect.arrayContaining([
      { url: 'top', scope: { include: ['#main'], exclude: ['.ad'] } },
      { url: 'nested', scope: { include: [], exclude: [] } },
    ]));
  });

  it.each(['throws', 'hangs'] as const)('does not list an unvisited frame whose element read %s', async frameElement => {
    resetScan();
    vi.useFakeTimers();
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
      expect(targetsOf(scan.violations, 'image-alt')).toEqual([['img'], ['#a', 'img'], ['#a', 'iframe', 'img']]);
      expect(targetsOf(scan.violations, 'heading-order')).toEqual([['#a', 'h3']]);
    });
  });

  it('reports a frame-free page the same way whichever path scans it', async () => {
    await withPage(async page => {
      const body = '<main><h1>Title</h1><h4>Skipped</h4><img src="a.png"><a href="#"></a><input></main>';
      await page.setContent(`<html><title>Paths</title>${body}</html>`);
      const plainRun = await runAxeScan(page);
      await setContentWithFrames(page, `<html><title>Paths</title>${body}<iframe title="Empty" srcdoc="<html lang=en><title>Empty</title></html>"></iframe></html>`, 1);
      const partialRun = await runAxeScan(page);

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

  type ClosedFrameWindow = { attachClosedFrame: (host: Element, name: string) => void };

  const installAttachClosedFrame = (frame: Page | Frame) => frame.evaluate(() => {
    (window as unknown as ClosedFrameWindow).attachClosedFrame = (host, name) => {
      const iframe = document.createElement('iframe');
      iframe.name = name;
      iframe.srcdoc = '<img src=x.png>';
      host.attachShadow({ mode: 'closed' }).append(iframe);
    };
  });

  async function waitForSrcdocFrames(page: Page, names: string[]) {
    await expect.poll(() => names.map(name => page.frames().find(frame => frame.name() === name)?.url())).toEqual(names.map(() => 'about:srcdoc'));
  }

  it('reports in-scope frames in closed shadow roots, which axe cannot see into', async () => {
    await withPage(async page => {
      await setContentWithFrames(page, '<iframe id="outer" title="Outer" srcdoc="<div id=inner-host></div>"></iframe>', 1);
      const outerFrame = page.frames()[1];
      await Promise.all([installAttachClosedFrame(page), installAttachClosedFrame(outerFrame)]);
      await outerFrame.evaluate(() => (window as unknown as ClosedFrameWindow).attachClosedFrame(document.querySelector('#inner-host')!, 'inner'));
      await page.evaluate(() => {
        const { attachClosedFrame } = window as unknown as ClosedFrameWindow;
        const host = (html: string) => {
          const element = document.createElement('div');
          element.innerHTML = html;
          document.body.append(element);
          return element.firstElementChild!;
        };
        for (const [markup, name] of [
          ['<div></div>', 'visible'],
          ['<div style="display:none"></div>', 'css-hidden'],
          ['<div aria-hidden="TRUE"></div>', 'aria-hidden'],
          ['<div id="chat"></div>', 'chat'],
        ] as const)
          attachClosedFrame(host(markup), name);

        for (const [wrapper, name] of [['<div aria-hidden="true"><slot></slot></div>', 'slot-aria-hidden'], ['<div inert><slot></slot></div>', 'slot-inert']] as const) {
          const outer = host('<div></div>');
          outer.attachShadow({ mode: 'open' }).innerHTML = wrapper;
          const slotted = document.createElement('span');
          outer.append(slotted);
          attachClosedFrame(slotted, name);
        }

        const adRoot = host('<div></div>').attachShadow({ mode: 'closed' });
        adRoot.innerHTML = '<div class="ad"></div>';
        attachClosedFrame(adRoot.querySelector('.ad')!, 'shadow-ad');

        const details = host('<div></div>');
        details.attachShadow({ mode: 'closed' }).innerHTML = '<details><slot></slot></details>';
        const summary = document.createElement('summary');
        const summaryHost = document.createElement('span');
        summary.append(summaryHost);
        details.append(summary);
        attachClosedFrame(summaryHost, 'summary');
      });
      await waitForSrcdocFrames(page, ['visible', 'shadow-ad', 'inner']);

      const result = await runAxeScan(page, { rules: ['image-alt'], exclude: ['#chat', '.ad'] });

      expect(result.unscannedFrames.sort()).toEqual(['about:srcdoc (name="inner")', 'about:srcdoc (name="shadow-ad")', 'about:srcdoc (name="visible")']);
      expect(result.violations).toEqual([]);
    });
  });

  it('scans a frame that exists only inside an open shadow root', async () => {
    await withPage(async page => {
      await page.setContent('<html lang="en"><title>Shadow frame</title><div id="host"></div></html>');
      await page.evaluate(() => {
        document.querySelector('#host')!.attachShadow({ mode: 'open' }).innerHTML = '<iframe title="Shadow" srcdoc="<img src=x.png>"></iframe>';
      });
      await expect.poll(() => page.frames()[1]?.url()).toBe('about:srcdoc');

      const result = await runAxeScan(page, { rules: ['image-alt'] });

      expect(await page.evaluate(() => window.length)).toBe(0);
      expect(targetsOf(result.violations, 'image-alt')).toEqual([[['#host', 'iframe'], 'img']]);
    });
  });

  it('scans an iframe inserted after Playwright last listed the frames, right before the page call', async () => {
    await withPage(async page => {
      await page.setContent('<html lang="en"><title>Late frame</title></html>');
      const mainFrame = page.mainFrame();
      const evaluateHandle = mainFrame.evaluateHandle.bind(mainFrame);
      vi.spyOn(mainFrame, 'evaluateHandle').mockImplementationOnce(async (script: any, arg: any) => {
        await page.evaluate(() => {
          const late = document.createElement('iframe');
          late.title = 'Late';
          late.srcdoc = '<img src=late.png>';
          document.body.append(late);
        });
        await expect.poll(() => page.frames()[1]?.url()).toBe('about:srcdoc');
        await page.frames()[1].waitForLoadState();
        return evaluateHandle(script, arg);
      });

      const result = await runAxeScan(page, { rules: ['image-alt'] });

      expect(targetsOf(result.violations, 'image-alt')).toEqual([['iframe', 'img']]);
      expect(result.unscannedFrames).toEqual([]);
    });
  });

  it('scans an XHTML iframe whose generated selector lost the case of an SVG foreignObject', async () => {
    await withPage(async page => {
      const xhtml = [
        '<html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><title>XHTML</title></head><body>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><foreignObject width="320" height="200">',
        '<iframe xmlns="http://www.w3.org/1999/xhtml" title="Inner" srcdoc="&lt;img src=x.png&gt;"></iframe>',
        '</foreignObject></svg></body></html>',
      ].join('');
      await page.route('http://xhtml.test/', route => route.fulfill({ contentType: 'application/xhtml+xml', body: xhtml }));
      await page.goto('http://xhtml.test/');
      await expect.poll(() => page.frames()[1]?.url()).toBe('about:srcdoc');
      await page.frames()[1].waitForLoadState();

      const result = await runAxeScan(page, { rules: ['image-alt'] });

      expect(result.unscannedFrames).toEqual([]);
      expect(result.violations.find(rule => rule.id === 'image-alt')?.nodes).toHaveLength(1);
    });
  });

  it('keeps a page-owned window.axe that cannot be overwritten', async () => {
    for (const lock of ['non-writable', 'getter-only'] as const) {
      await withPage(async page => {
        await setContentWithFrames(page, '<html lang="en"><title>Locked</title><iframe title="Child" srcdoc="<img src=x.png>"></iframe></html>', 1);
        await page.evaluate(mode => {
          const pageAxe = { version: 'page-owned' };
          Object.defineProperty(window, 'axe', mode === 'non-writable'
            ? { value: pageAxe, writable: false, configurable: false }
            : { get: () => pageAxe, configurable: false });
        }, lock);

        const result = await runAxeScan(page, { rules: ['image-alt'] });

        expect(targetsOf(result.violations, 'image-alt')).toEqual([['iframe', 'img']]);
        expect(await page.evaluate(() => (window as any).axe.version)).toBe('page-owned');
      });
    }
  });

  it('leaves no message listener behind across repeated scans, and keeps the page\'s own', async () => {
    await withPage(async page => {
      await page.setContent('<html lang="en"><title>Listeners</title><button>Named</button></html>');
      await page.evaluate(() => window.addEventListener('message', () => {}));
      const session = await page.context().newCDPSession(page);
      const messageListeners = async () => {
        const { result } = await session.send('Runtime.evaluate', { expression: 'window' });
        const { listeners } = await session.send('DOMDebugger.getEventListeners', { objectId: result.objectId! });
        return listeners.filter(listener => listener.type === 'message').length;
      };

      const counts = [await messageListeners()];
      for (let scan = 0; scan < 3; scan++) {
        await runAxeScan(page);
        counts.push(await messageListeners());
      }

      expect(counts).toEqual([1, 1, 1, 1]);
    });
  });

  it('sends a frame-free page\'s report to Node already projected to the fields the scanner returns', async () => {
    await withPage(async page => {
      await page.setContent(`<html lang="en"><title>Projection</title>${'<img src="x.png">'.repeat(25)}</html>`);
      const mainFrame = page.mainFrame();
      const evaluateHandle = mainFrame.evaluateHandle.bind(mainFrame);
      let payload = '';
      vi.spyOn(mainFrame, 'evaluateHandle').mockImplementationOnce(async (script: any, arg: any) => {
        const handle = await evaluateHandle(script, arg);
        payload = await handle.evaluate(result => (result as unknown as string[])[1]);
        return handle;
      });

      const result = await runAxeScan(page, { rules: ['image-alt'] });
      const sent = JSON.parse(payload);

      expect(Object.keys(sent).sort()).toEqual(['inapplicable', 'incomplete', 'passes', 'url', 'violations']);
      expect(Object.keys(sent.violations[0].nodes[0]).sort()).toEqual(['failureSummary', 'html', 'target']);
      expect(sent.violations).toEqual(result.violations);
    });
  });

  it('applies axe\'s closest-match scope rule to closed-shadow frames as axe applies it to open ones', async () => {
    await withPage(async page => {
      await page.setContent('<html lang="en"><title>Scope</title><main id="outer"><section id="inner"><div id="open-host"></div><div id="closed-host"></div></section></main></html>');
      await installAttachClosedFrame(page);
      await page.evaluate(() => {
        document.querySelector('#open-host')!.attachShadow({ mode: 'open' }).innerHTML = '<iframe title="Open" srcdoc="<img src=x.png>"></iframe>';
        (window as unknown as ClosedFrameWindow).attachClosedFrame(document.querySelector('#closed-host')!, 'closed');
      });
      await waitForSrcdocFrames(page, ['closed']);
      await expect.poll(() => page.frames().filter(frame => frame.url() === 'about:srcdoc').length).toBe(2);

      const result = await runAxeScan(page, { rules: ['image-alt'], include: ['#inner'], exclude: ['#outer'] });

      expect(targetsOf(result.violations, 'image-alt')).toEqual([[['#open-host', 'iframe'], 'img']]);
      expect(result.unscannedFrames).toEqual(['about:srcdoc (name="closed")']);
    });
  });

  it('counts only the topmost modal as active when modals stack', async () => {
    await withPage(async page => {
      await page.setContent('<dialog id="first"><div id="host"></div></dialog><dialog id="second">Second</dialog>');
      await installAttachClosedFrame(page);
      await page.evaluate(() => {
        (window as unknown as ClosedFrameWindow).attachClosedFrame(document.querySelector('#host')!, 'in-first');
        document.querySelector<HTMLDialogElement>('#first')!.showModal();
      });
      await waitForSrcdocFrames(page, ['in-first']);
      expect((await runAxeScan(page, { rules: ['image-alt'] })).unscannedFrames).toEqual(['about:srcdoc (name="in-first")']);

      await page.evaluate(() => document.querySelector<HTMLDialogElement>('#second')!.showModal());
      expect((await runAxeScan(page, { rules: ['image-alt'] })).unscannedFrames).toEqual([]);
    });
  });

  it('lets a modal dialog escape the inertness of its ancestors', async () => {
    await withPage(async page => {
      await page.setContent('<div inert><dialog><div id="inside"></div></dialog></div><div id="outside" inert></div>');
      await installAttachClosedFrame(page);
      await page.evaluate(() => {
        const { attachClosedFrame } = window as unknown as ClosedFrameWindow;
        attachClosedFrame(document.querySelector('#inside')!, 'escaped');
        attachClosedFrame(document.querySelector('#outside')!, 'inert');
        document.querySelector('dialog')!.showModal();
      });
      await waitForSrcdocFrames(page, ['escaped', 'inert']);

      expect((await runAxeScan(page, { rules: ['image-alt'] })).unscannedFrames).toEqual(['about:srcdoc (name="escaped")']);
    });
  });

  async function gotoXhtml(page: Page, body: string, frameCount: number) {
    const xhtml = `<html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><title>XHTML</title></head><body>${body}</body></html>`;
    await page.route('http://xhtml.test/', route => route.fulfill({ contentType: 'application/xhtml+xml', body: xhtml }));
    await page.goto('http://xhtml.test/');
    await expect.poll(() => page.frames().filter(frame => frame.url() === 'about:srcdoc').length).toBe(frameCount);
    await Promise.all(page.frames().map(frame => frame.waitForLoadState()));
  }

  it('resolves axe\'s frame selector from the document root, not from the first element its CSS matches', async () => {
    await withPage(async page => {
      await gotoXhtml(page, [
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><foreignObject width="320" height="200">',
        '<html xmlns="http://www.w3.org/1999/xhtml"><body><div>Decoy</div><iframe title="Decoy" srcdoc="&lt;img alt=&quot;Fine&quot; src=x.png&gt;"></iframe></body></html>',
        '</foreignObject></svg>',
        '<iframe id="checkout" title="Checkout" srcdoc="&lt;img id=missing src=x.png&gt;"></iframe>',
      ].join(''), 2);

      const result = await runAxeScan(page, { rules: ['image-alt'], include: ['#checkout'] });

      expect(targetsOf(result.violations, 'image-alt')).toEqual([['#checkout', '#missing']]);
      expect(result.unscannedFrames).toEqual([]);
    });
  });

  it('follows a prefixed XHTML ancestor by axe\'s qualified node name', async () => {
    await withPage(async page => {
      await gotoXhtml(page, '<p>Before</p><h:div xmlns:h="http://www.w3.org/1999/xhtml"><iframe id="prefixed" title="Prefixed" srcdoc="&lt;img id=missing src=x.png&gt;"></iframe></h:div>', 1);

      const result = await runAxeScan(page, { rules: ['image-alt'] });

      expect(targetsOf(result.violations, 'image-alt')).toEqual([['#prefixed', '#missing']]);
      expect(result.unscannedFrames).toEqual([]);
    });
  });

  it('keeps a frame slotted into a single shadow-DOM modal in scope, whatever its centre hit test says', async () => {
    await withPage(async page => {
      await page.setContent('<div id="dialog-host"><span id="slotted"></span></div>');
      await installAttachClosedFrame(page);
      await page.evaluate(() => {
        const host = document.querySelector('#dialog-host')!;
        host.attachShadow({ mode: 'open' }).innerHTML = '<dialog><slot></slot></dialog>';
        (window as unknown as ClosedFrameWindow).attachClosedFrame(document.querySelector('#slotted')!, 'slotted');
        host.shadowRoot!.querySelector('dialog')!.showModal();
      });
      await waitForSrcdocFrames(page, ['slotted']);

      expect((await runAxeScan(page, { rules: ['image-alt'] })).unscannedFrames).toEqual(['about:srcdoc (name="slotted")']);
    });
  });

  it('keeps a frame in a single modal with pointer-events: none in scope', async () => {
    await withPage(async page => {
      await page.setContent('<dialog style="pointer-events: none"><button>Focusable</button><div id="host"></div></dialog>');
      await installAttachClosedFrame(page);
      await page.evaluate(() => {
        (window as unknown as ClosedFrameWindow).attachClosedFrame(document.querySelector('#host')!, 'unhittable');
        document.querySelector('dialog')!.showModal();
      });
      await waitForSrcdocFrames(page, ['unhittable']);

      expect((await runAxeScan(page, { rules: ['image-alt'] })).unscannedFrames).toEqual(['about:srcdoc (name="unhittable")']);
    });
  });

  it('leaves no frame evaluation pending after repeated scans of a sandboxed frame', async () => {
    await withPage(async page => {
      await setContentWithFrames(page, '<iframe id="locked" sandbox srcdoc="<img src=x.png>"></iframe>', 1);
      const sandboxed = page.frames()[1];
      const evaluate = sandboxed.evaluate.bind(sandboxed);
      let pending = 0;
      vi.spyOn(sandboxed, 'evaluate').mockImplementation(((script: any, arg: any) => {
        pending++;
        return evaluate(script, arg).finally(() => {
          pending--;
        });
      }) as typeof sandboxed.evaluate);

      const pendingAfterEachScan: number[] = [];
      for (let scan = 0; scan < 4; scan++) {
        expect((await runAxeScan(page, { rules: ['image-alt'] })).unscannedFrames).toEqual(['about:srcdoc (name="locked")']);
        pendingAfterEachScan.push(pending);
      }

      expect(pendingAfterEachScan).toEqual([0, 0, 0, 0]);
    });
  });

  it('does not report closed-shadow frames made inert by an open modal dialog', async () => {
    await withPage(async page => {
      await page.setContent('<div id="behind"></div><dialog><div id="inside"></div></dialog>');
      await installAttachClosedFrame(page);
      await page.evaluate(() => {
        const { attachClosedFrame } = window as unknown as ClosedFrameWindow;
        attachClosedFrame(document.querySelector('#behind')!, 'behind-modal');
        attachClosedFrame(document.querySelector('#inside')!, 'inside-modal');
        document.querySelector('dialog')!.showModal();
      });
      await waitForSrcdocFrames(page, ['behind-modal', 'inside-modal']);

      expect((await runAxeScan(page, { rules: ['image-alt'] })).unscannedFrames).toEqual(['about:srcdoc (name="inside-modal")']);
    });
  });

});
