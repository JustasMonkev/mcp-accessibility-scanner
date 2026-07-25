import { describe, expect, it, vi } from 'vitest';

const builderCalls: { withTags: string[][]; include: string[]; exclude: string[] } = {
  withTags: [],
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

const { axeTagValues, defaultAxeTags, dedupeAxeNodes, prepareAxeResults, runAxeScan, summarizeAxeViolations, trimAxeResults } = await import('../src/tools/axe.js');

function resetBuilderCalls() {
  builderCalls.withTags = [];
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
    expect(builderCalls.include).toEqual([]);
    expect(builderCalls.exclude).toEqual([]);
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
