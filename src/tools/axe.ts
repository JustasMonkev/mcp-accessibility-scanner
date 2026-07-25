import { AxeBuilder } from '@axe-core/playwright';
import type { AxeResults } from 'axe-core';
import { z } from 'zod';

import type * as playwright from 'playwright';

export const axeTagValues = [
  'wcag2a', 'wcag2aa', 'wcag2aaa', 'wcag21a', 'wcag21aa', 'wcag21aaa',
  'wcag22a', 'wcag22aa', 'wcag22aaa', 'section508', 'cat.aria', 'cat.color',
  'cat.forms', 'cat.keyboard', 'cat.language', 'cat.name-role-value',
  'cat.parsing', 'cat.semantics', 'cat.sensory-and-visual-cues',
  'cat.structure', 'cat.tables', 'cat.text-alternatives', 'cat.time-and-media',
  'best-practice', 'experimental',
] as const;

export type AxeTag = (typeof axeTagValues)[number];

// Default scan set: only tags that map to a conformance criterion, so a default
// report keeps meaning "this fails WCAG/Section 508".
//
// The `cat.*` tags are deliberately absent. Axe matches `runOnly` tags with OR,
// so keeping e.g. `cat.keyboard` in the default set pulls in best-practice rules
// like `region` and `landmark-one-main` that carry both tags — merely omitting
// the `best-practice` tag does not make those rules opt-in. Almost nothing is
// lost: the only rules reachable solely through a `cat.*` tag are `duplicate-id`
// and `duplicate-id-active`, both deprecated in Axe since WCAG dropped SC 4.1.1.
//
// Five rules tagged `experimental` also carry a real `wcag*` tag and therefore
// still run by default: css-orientation-lock (SC 1.3.4),
// label-content-name-mismatch (SC 2.5.3), p-as-heading, table-fake-caption and
// td-has-header (SC 1.3.1). That is deliberate. `experimental` in Axe describes
// how settled the heuristic is, not whether the criterion is real, so filtering
// them out would drop genuine conformance coverage from the default scan — the
// opposite of what this tag set is for.
export const defaultAxeTags: readonly AxeTag[] = axeTagValues.filter(
    tag => tag.startsWith('wcag') || tag === 'section508'
);
export type AxeScanResult = AxeResults;
export type AxeViolation = AxeScanResult['violations'][number];
export type AxeNode = AxeViolation['nodes'][number];

export type TrimmedAxeNode = {
  target: AxeNode['target'];
  html: string;
  failureSummary: string | null;
};

export type TrimmedAxeViolation = {
  id: string;
  impact: AxeViolation['impact'];
  tags: string[];
  help: string;
  helpUrl: string;
  description: string;
  nodes: TrimmedAxeNode[];
};

export type AxeScanOptions = {
  tags?: readonly AxeTag[];
  include?: readonly string[];
  exclude?: readonly string[];
};

// Shared by every scan tool so scoping means the same thing everywhere.
export const axeScopeSchemaShape = {
  includeSelectors: z.array(z.string().min(1)).optional().describe('CSS selectors to restrict the scan to, e.g. ["#checkout-form"]. Omit to scan the whole page. Each selector may match multiple elements.'),
  excludeSelectors: z.array(z.string().min(1)).optional().describe('CSS selectors to exclude from the scan, e.g. ["#cookie-banner", "iframe.chat-widget"]. Applied after includeSelectors, so it can carve regions out of an included subtree.'),
};

// Axe only rejects a scope when the *whole* include set resolves to nothing, so
// one typo among several include selectors silently shrinks the scan and the
// report still looks clean. Resolve every selector ourselves first: a scan that
// quietly covers less than asked is worse than one that fails loudly.
async function assertScopeSelectorsResolve(
  page: playwright.Page,
  selectors: readonly string[],
  label: 'includeSelectors' | 'excludeSelectors'
) {
  if (!selectors.length)
    return;
  const counts = await page.evaluate(list => list.map(selector => {
    try {
      return document.querySelectorAll(selector).length;
    } catch {
      return -1;
    }
  }), [...selectors]);

  const invalid = selectors.filter((_, index) => counts[index] === -1);
  if (invalid.length)
    throw new Error(`Invalid CSS in ${label}: ${invalid.join(', ')}`);

  // An unmatched exclude only leaves extra content in scope, and a crawl may
  // legitimately hit pages without the excluded widget, so it is not an error.
  if (label === 'excludeSelectors')
    return;
  const unmatched = selectors.filter((_, index) => counts[index] === 0);
  if (unmatched.length)
    throw new Error(`No elements matched ${label}: ${unmatched.join(', ')}. The scan would have silently covered less of the page than requested.`);
}

export async function runAxeScan(page: playwright.Page, options: AxeScanOptions = {}): Promise<AxeScanResult> {
  await assertScopeSelectorsResolve(page, options.include ?? [], 'includeSelectors');
  await assertScopeSelectorsResolve(page, options.exclude ?? [], 'excludeSelectors');

  const builder = new AxeBuilder({ page }).withTags([...(options.tags ?? defaultAxeTags)]);
  // include/exclude are cumulative in AxeBuilder; exclude wins over include for
  // overlapping subtrees, which is what "scan this component minus the widget"
  // needs.
  for (const selector of options.include ?? [])
    builder.include(selector);
  for (const selector of options.exclude ?? [])
    builder.exclude(selector);
  return await builder.analyze();
}

export function dedupeAxeNodes(nodes: AxeNode[]): AxeNode[] {
  const seen = new Set<string>();
  return nodes.filter(node => {
    // The JSON-encoded target is self-delimiting, so appending the raw HTML
    // keeps the key unambiguous without serializing a wrapper object.
    const key = `${JSON.stringify(node.target ?? [])}|${node.html ?? ''}`;
    if (seen.has(key))
      return false;
    seen.add(key);
    return true;
  });
}

export function trimAxeResults(
  violations: AxeViolation[],
  options: { maxNodesPerViolation: number; dedupe?: boolean }
): TrimmedAxeViolation[] {
  // Callers that already deduped node lists can pass `dedupe: false` to skip a
  // redundant second dedup pass over potentially large node sets.
  const shouldDedupe = options.dedupe ?? true;
  return violations.map(violation => {
    const sourceNodes = shouldDedupe ? dedupeAxeNodes(violation.nodes) : violation.nodes;
    const nodes = sourceNodes.slice(0, options.maxNodesPerViolation).map(node => ({
      target: [...(node.target ?? [])],
      html: node.html ?? '',
      failureSummary: node.failureSummary ?? null,
    }));
    return {
      id: violation.id,
      impact: violation.impact,
      tags: [...violation.tags],
      help: violation.help,
      helpUrl: violation.helpUrl,
      description: violation.description,
      nodes,
    };
  });
}

// Dedupe once and reuse: callers need the deduped nodes for per-rule counting
// and aggregation, and the trimmed copy for the report payload.
export function prepareAxeResults(
  violations: AxeViolation[],
  maxNodesPerViolation: number
): { deduped: AxeViolation[]; trimmed: TrimmedAxeViolation[] } {
  const deduped = violations.map(violation => ({
    ...violation,
    nodes: dedupeAxeNodes(violation.nodes),
  }));
  return { deduped, trimmed: trimAxeResults(deduped, { maxNodesPerViolation, dedupe: false }) };
}

export function summarizeAxeViolations(violations: TrimmedAxeViolation[]) {
  const byImpact: Record<string, number> = {};
  const byRuleId: Record<string, number> = {};
  let totalNodes = 0;

  for (const violation of violations) {
    const impact = violation.impact ?? 'unknown';
    const nodeCount = violation.nodes.length;
    byImpact[impact] = (byImpact[impact] ?? 0) + nodeCount;
    byRuleId[violation.id] = (byRuleId[violation.id] ?? 0) + nodeCount;
    totalNodes += nodeCount;
  }

  return {
    totalRules: violations.length,
    totalNodes,
    byImpact,
    byRuleId,
  };
}
