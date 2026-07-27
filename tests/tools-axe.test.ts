import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const builderCalls: { withTags: string[][]; withRules: string[][]; disableRules: string[][]; include: string[]; exclude: string[] } = {
  withTags: [],
  withRules: [],
  disableRules: [],
  include: [],
  exclude: [],
};
let analyzeResult: any = { violations: [], incomplete: [], passes: [], inapplicable: [] };

vi.mock('@axe-core/playwright', () => ({
  AxeBuilder: class {
    withTags(tags: string[]) {
      builderCalls.withTags.push(tags);
      return this;
    }
    withRules(rules: string[]) {
      builderCalls.withRules.push(rules);
      return this;
    }
    disableRules(rules: string[]) {
      builderCalls.disableRules.push(rules);
      return this;
    }
    include(selector: string) {
      builderCalls.include.push(selector);
      return this;
    }
    exclude(selector: string) {
      builderCalls.exclude.push(selector);
      return this;
    }
    async analyze() {
      if (analyzeResult instanceof Error)
        throw analyzeResult;
      return analyzeResult;
    }
  },
}));

const { assertRuleOptionsValid, axeRuleSchemaShape, axeTagValues, defaultAxeTags, dedupeAxeNodes, prepareAxeResults, runAxeScan, summarizeAxeViolations, trimAxeResults } = await import('../src/tools/axe.js');

function resetBuilderCalls() {
  builderCalls.withTags = [];
  builderCalls.withRules = [];
  builderCalls.disableRules = [];
  builderCalls.include = [];
  builderCalls.exclude = [];
  analyzeResult = { violations: [], incomplete: [], passes: [], inapplicable: [] };
}

// Stands in for page.evaluate(selectors => …): returns the match count each
// selector should resolve to, or -1 for CSS the browser rejects.
function pageWithSelectorCounts(countBySelector: Record<string, number>) {
  return {
    evaluate: async (_fn: unknown, selectors: string[]) =>
      selectors.map(selector => countBySelector[selector] ?? 0),
  } as any;
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
    resetBuilderCalls();
    await runAxeScan({} as any);
    expect(builderCalls.withTags).toEqual([[...defaultAxeTags]]);
    expect(builderCalls.withRules).toEqual([]);
    expect(builderCalls.disableRules).toEqual([]);
    expect(builderCalls.include).toEqual([]);
    expect(builderCalls.exclude).toEqual([]);
  });

  it('runs explicit rule ids instead of tags, because axe runOnly holds only one of them', async () => {
    resetBuilderCalls();
    await runAxeScan({} as any, { tags: ['wcag2aa'], rules: ['image-alt', 'label'] });
    expect(builderCalls.withRules).toEqual([['image-alt', 'label']]);
    // withTags would overwrite the rule list in axe's single runOnly slot.
    expect(builderCalls.withTags).toEqual([]);
  });

  it('rejects an explicitly empty rule list instead of silently scanning the full tag set', async () => {
    resetBuilderCalls();
    // "Run only these rules: none" is a contradiction; falling back to tags
    // would scan far more than the caller asked for.
    await expect(runAxeScan({} as any, { tags: ['wcag2aa'], rules: [] }))
        .rejects.toThrow(/withRules is an empty list/);
    expect(builderCalls.withTags).toEqual([]);
    expect(builderCalls.withRules).toEqual([]);
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
    resetBuilderCalls();
    await runAxeScan({} as any, { tags: ['wcag2aa'], disableRules: ['color-contrast'] });
    expect(builderCalls.withTags).toEqual([['wcag2aa']]);
    expect(builderCalls.disableRules).toEqual([['color-contrast']]);
  });

  it('subtracts disableRules from an explicit rule list rather than relying on axe', async () => {
    resetBuilderCalls();
    // axe ignores the per-rule enabled flag once runOnly holds a rule list, so
    // passing both through would still have run `label`.
    await runAxeScan({} as any, { rules: ['image-alt', 'label'], disableRules: ['label'] });
    expect(builderCalls.withRules).toEqual([['image-alt']]);
    expect(builderCalls.disableRules).toEqual([]);
  });

  it('refuses a rule list that disableRules empties, instead of silently scanning everything', async () => {
    resetBuilderCalls();
    await expect(runAxeScan({} as any, { rules: ['image-alt'], disableRules: ['image-alt'] }))
        .rejects.toThrow(/disableRules disabled every rule in withRules \(image-alt\)/);
    expect(builderCalls.withRules).toEqual([]);
    expect(builderCalls.withTags).toEqual([]);
  });

  it('rejects an unknown rule id in withRules instead of scanning nothing', async () => {
    resetBuilderCalls();
    await expect(runAxeScan({} as any, { rules: ['image-alt', 'image-altt'] }))
        .rejects.toThrow(/Unknown Axe rule id\(s\) in withRules: image-altt/);
    expect(builderCalls.withRules).toEqual([]);
  });

  it('rejects an unknown rule id in disableRules instead of disabling nothing', async () => {
    resetBuilderCalls();
    await expect(runAxeScan({} as any, { disableRules: ['colour-contrast'] }))
        .rejects.toThrow(/Unknown Axe rule id\(s\) in disableRules: colour-contrast/);
    expect(builderCalls.disableRules).toEqual([]);
  });

  it('validates rule ids before touching the page, so a bad id cannot cost a scan', async () => {
    resetBuilderCalls();
    const page = { evaluate: () => { throw new Error('page should not be touched'); } } as any;
    await expect(runAxeScan(page, { rules: ['nope'], include: ['#content'] }))
        .rejects.toThrow(/Unknown Axe rule id/);
  });

  it('accepts every rule id axe-core actually ships', async () => {
    resetBuilderCalls();
    // Guards against the catalogue check drifting from the injected axe build.
    await runAxeScan({} as any, { rules: ['color-contrast', 'region', 'frame-tested', 'aria-allowed-attr'] });
    expect(builderCalls.withRules[0]).toHaveLength(4);
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

  it('validates rule ids against the exact axe-core build @axe-core/playwright injects', async () => {
    // The catalogue check is only meaningful while both resolve to one version,
    // which is why package.json pins axe-core exactly.
    const [ownPackage, installedAxeCore] = await Promise.all([
      import('../package.json', { with: { type: 'json' } }),
      import('axe-core/package.json', { with: { type: 'json' } }),
    ]);
    expect(ownPackage.default.dependencies['axe-core']).toBe(installedAxeCore.default.version);
  });

  it('pins @axe-core/playwright exactly so a newer wrapper cannot nest a different axe-core', async () => {
    // A ranged wrapper could resolve to a newer release on a clean install and
    // bring its own nested axe-core; validation would then use one catalogue
    // while AxeBuilder injects another. The exact pin makes the two axe-core
    // requirements (ours and the wrapper's) meet in a single resolved copy.
    const ownPackage = await import('../package.json', { with: { type: 'json' } });
    // The wrapper's exports map hides its package.json from import(), so read it.
    const installedWrapper = JSON.parse(fs.readFileSync(
        fileURLToPath(new URL('../node_modules/@axe-core/playwright/package.json', import.meta.url)), 'utf-8'));
    expect(ownPackage.default.dependencies['@axe-core/playwright']).toBe(installedWrapper.version);
    // The proof that nothing nested: the wrapper has no private axe-core copy.
    expect(fs.existsSync(fileURLToPath(new URL('../node_modules/@axe-core/playwright/node_modules/axe-core', import.meta.url)))).toBe(false);
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

  it('applies include and exclude selectors to the builder', async () => {
    resetBuilderCalls();
    await runAxeScan(pageWithSelectorCounts({ '#checkout': 1, '#summary': 2, '#cookie-banner': 1 }), {
      tags: ['wcag2aa'],
      include: ['#checkout', '#summary'],
      exclude: ['#cookie-banner'],
    });
    expect(builderCalls.withTags).toEqual([['wcag2aa']]);
    expect(builderCalls.include).toEqual(['#checkout', '#summary']);
    expect(builderCalls.exclude).toEqual(['#cookie-banner']);
  });

  it('fails instead of silently narrowing when one of several include selectors matches nothing', async () => {
    resetBuilderCalls();
    // Axe itself only errors when the whole include set is empty, so this is
    // the case that would otherwise produce a clean but half-scoped report.
    await expect(runAxeScan(pageWithSelectorCounts({ '#checkout': 1, '#billing-summry': 0 }), {
      include: ['#checkout', '#billing-summry'],
    })).rejects.toThrow(/No elements matched includeSelectors: #billing-summry/);
    expect(builderCalls.include).toEqual([]);
  });

  it('rejects CSS the browser cannot parse, for includes and excludes alike', async () => {
    resetBuilderCalls();
    await expect(runAxeScan(pageWithSelectorCounts({ '#ok': 1, ':::bad': -1 }), {
      include: ['#ok'],
      exclude: [':::bad'],
    })).rejects.toThrow(/Invalid CSS in excludeSelectors: :::bad/);
  });

  it('allows an exclude selector that matches nothing on this page', async () => {
    resetBuilderCalls();
    // A crawl legitimately hits pages without the excluded widget.
    await runAxeScan(pageWithSelectorCounts({ '#cookie-banner': 0 }), { exclude: ['#cookie-banner'] });
    expect(builderCalls.exclude).toEqual(['#cookie-banner']);
  });

  it('rethrows scan failures untouched', async () => {
    resetBuilderCalls();
    const failure = new Error('axe injection failed');
    analyzeResult = failure;
    await expect(runAxeScan({} as any)).rejects.toBe(failure);
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
