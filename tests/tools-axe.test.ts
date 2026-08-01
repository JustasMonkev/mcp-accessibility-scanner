import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { assertRuleOptionsValid, axeRuleSchemaShape, axeTagValues, defaultAxeTags, dedupeAxeNodes, prepareAxeResults, runAxeScan, summarizeAxeViolations, trimAxeResults } from '../src/tools/axe.js';

// The scan drives the page itself: axe-core is injected into every frame, then
// run in the main one. The fake page records what the run was asked to do, and
// answers the scope check with the match count each selector should resolve to
// (-1 for CSS the browser rejects).
type ScanCall = { context: unknown; options: any };

let lastScan: ScanCall | undefined;
let scanResult: any;

function makeFrame(countBySelector: Record<string, number>, url = 'https://example.com/', injectable = true) {
  return {
    url: () => url,
    evaluate: async (script: unknown, arg?: unknown) => {
      // Injection: the axe source and its configuration, both plain strings.
      if (typeof script === 'string') {
        if (!injectable)
          throw new Error('Execution context was destroyed');
        return undefined;
      }
      if (arg === undefined)
        return undefined;
      if (Array.isArray(arg))
        return arg.map(selector => countBySelector[selector as string] ?? 0);
      lastScan = arg as ScanCall;
      if (scanResult instanceof Error)
        throw scanResult;
      return scanResult;
    },
  };
}

function pageWithSelectorCounts(countBySelector: Record<string, number> = {}, childFrames: any[] = []) {
  const frame = makeFrame(countBySelector);
  return {
    ...frame,
    frames: () => [frame, ...childFrames],
    mainFrame: () => frame,
  } as any;
}

function resetScan() {
  lastScan = undefined;
  scanResult = { url: 'https://example.com', violations: [], incomplete: [], passes: [], inapplicable: [] };
}

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
      'label-content-name-mismatch',
      'p-as-heading',
      'table-fake-caption',
      'td-has-header',
    ]);
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

  it('scans with the default tag set and no scope when given no options', async () => {
    resetScan();
    await runAxeScan(pageWithSelectorCounts());
    expect(lastScan?.options).toEqual({ runOnly: { type: 'tag', values: [...defaultAxeTags] } });
    expect(lastScan?.context).toBeNull();
  });

  it('runs explicit rule ids instead of tags, because axe runOnly holds only one of them', async () => {
    resetScan();
    await runAxeScan(pageWithSelectorCounts(), { tags: ['wcag2aa'], rules: ['image-alt', 'label'] });
    // A tag list would overwrite the rule list in axe's single runOnly slot.
    expect(lastScan?.options).toEqual({ runOnly: { type: 'rule', values: ['image-alt', 'label'] } });
  });

  it('rejects an explicitly empty rule list instead of silently scanning the full tag set', async () => {
    resetScan();
    // "Run only these rules: none" is a contradiction; falling back to tags
    // would scan far more than the caller asked for.
    await expect(runAxeScan(pageWithSelectorCounts(), { tags: ['wcag2aa'], rules: [] }))
        .rejects.toThrow(/withRules is an empty list/);
    expect(lastScan).toBeUndefined();
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
    await runAxeScan(pageWithSelectorCounts(), { tags: ['wcag2aa'], disableRules: ['color-contrast'] });
    expect(lastScan?.options).toEqual({
      runOnly: { type: 'tag', values: ['wcag2aa'] },
      rules: { 'color-contrast': { enabled: false } },
    });
  });

  it('subtracts disableRules from an explicit rule list rather than relying on axe', async () => {
    resetScan();
    // axe ignores the per-rule enabled flag once runOnly holds a rule list, so
    // passing both through would still have run `label`.
    await runAxeScan(pageWithSelectorCounts(), { rules: ['image-alt', 'label'], disableRules: ['label'] });
    expect(lastScan?.options).toEqual({ runOnly: { type: 'rule', values: ['image-alt'] } });
  });

  it('refuses a rule list that disableRules empties, instead of silently scanning everything', async () => {
    resetScan();
    await expect(runAxeScan(pageWithSelectorCounts(), { rules: ['image-alt'], disableRules: ['image-alt'] }))
        .rejects.toThrow(/disableRules disabled every rule in withRules \(image-alt\)/);
    expect(lastScan).toBeUndefined();
  });

  it('rejects an unknown rule id in withRules instead of scanning nothing', async () => {
    resetScan();
    await expect(runAxeScan(pageWithSelectorCounts(), { rules: ['image-alt', 'image-altt'] }))
        .rejects.toThrow(/Unknown Axe rule id\(s\) in withRules: image-altt/);
    expect(lastScan).toBeUndefined();
  });

  it('rejects an unknown rule id in disableRules instead of disabling nothing', async () => {
    resetScan();
    await expect(runAxeScan(pageWithSelectorCounts(), { disableRules: ['colour-contrast'] }))
        .rejects.toThrow(/Unknown Axe rule id\(s\) in disableRules: colour-contrast/);
    expect(lastScan).toBeUndefined();
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
    await runAxeScan(pageWithSelectorCounts(), { rules: ['color-contrast', 'region', 'frame-tested', 'aria-allowed-attr'] });
    expect(lastScan?.options.runOnly.values).toHaveLength(4);
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
    // The rule catalogue and the injected source are the same module, and the
    // exact pin keeps a lockfile-less install from resolving a different one.
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
    await runAxeScan(pageWithSelectorCounts({ '#checkout': 1, '#summary': 2, '#cookie-banner': 1 }), {
      tags: ['wcag2aa'],
      include: ['#checkout', '#summary'],
      exclude: ['#cookie-banner'],
    });
    expect(lastScan?.options).toEqual({ runOnly: { type: 'tag', values: ['wcag2aa'] } });
    expect(lastScan?.context).toEqual({ include: ['#checkout', '#summary'], exclude: ['#cookie-banner'] });
  });

  it('fails instead of silently narrowing when one of several include selectors matches nothing', async () => {
    resetScan();
    // Axe itself only errors when the whole include set is empty, so this is
    // the case that would otherwise produce a clean but half-scoped report.
    await expect(runAxeScan(pageWithSelectorCounts({ '#checkout': 1, '#billing-summry': 0 }), {
      include: ['#checkout', '#billing-summry'],
    })).rejects.toThrow(/No elements matched includeSelectors: #billing-summry/);
    expect(lastScan).toBeUndefined();
  });

  it('rejects CSS the browser cannot parse, for includes and excludes alike', async () => {
    resetScan();
    await expect(runAxeScan(pageWithSelectorCounts({ '#ok': 1, ':::bad': -1 }), {
      include: ['#ok'],
      exclude: [':::bad'],
    })).rejects.toThrow(/Invalid CSS in excludeSelectors: :::bad/);
  });

  it('allows an exclude selector that matches nothing on this page', async () => {
    resetScan();
    // A crawl legitimately hits pages without the excluded widget.
    await runAxeScan(pageWithSelectorCounts({ '#cookie-banner': 0 }), { exclude: ['#cookie-banner'] });
    expect(lastScan?.context).toEqual({ include: [], exclude: ['#cookie-banner'] });
  });

  it('reports a child frame Axe could not be installed in, rather than scanning around it', async () => {
    resetScan();
    // A frame that navigates mid-injection contributes no violations, and a
    // report that stays silent about it reads as a clean scan of the whole page.
    const broken = makeFrame({}, 'https://example.com/widget', false);
    const result = await runAxeScan(pageWithSelectorCounts({}, [broken]));

    expect(result.unscannedFrames).toEqual(['https://example.com/widget']);
  });

  it('does not report frames that hold nothing a scan would have covered', async () => {
    resetScan();
    // about:blank and friends have no content to miss.
    const blank = makeFrame({}, 'about:blank', false);
    const result = await runAxeScan(pageWithSelectorCounts({}, [blank]));

    expect(result.unscannedFrames).toEqual([]);
  });

  it('reports no unscanned frames when every injection succeeds', async () => {
    resetScan();
    const healthy = makeFrame({}, 'https://example.com/widget', true);
    const result = await runAxeScan(pageWithSelectorCounts({}, [healthy]));

    expect(result.unscannedFrames).toEqual([]);
  });

  it('rethrows scan failures untouched', async () => {
    resetScan();
    const failure = new Error('axe run failed');
    scanResult = failure;
    await expect(runAxeScan(pageWithSelectorCounts())).rejects.toBe(failure);
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
