import AxeBuilder from '@axe-core/playwright';

import type * as playwright from 'playwright';

export const axeTagValues = [
  'wcag2a', 'wcag2aa', 'wcag2aaa', 'wcag21a', 'wcag21aa', 'wcag21aaa',
  'wcag22a', 'wcag22aa', 'wcag22aaa', 'section508', 'cat.aria', 'cat.color',
  'cat.forms', 'cat.keyboard', 'cat.language', 'cat.name-role-value',
  'cat.parsing', 'cat.semantics', 'cat.sensory-and-visual-cues',
  'cat.structure', 'cat.tables', 'cat.text-alternatives', 'cat.time-and-media',
] as const;

export type AxeTag = (typeof axeTagValues)[number];
export type AxeScanResult = Awaited<ReturnType<InstanceType<typeof AxeBuilder>['analyze']>>;
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

export async function runAxeScan(page: playwright.Page, tags: readonly AxeTag[]): Promise<AxeScanResult> {
  return await new AxeBuilder({ page }).withTags([...tags]).analyze();
}

export function dedupeAxeNodes(nodes: AxeNode[]): AxeNode[] {
  const seen = new Set<string>();
  return nodes.filter(node => {
    const key = JSON.stringify({ target: node.target ?? [], html: node.html ?? '' });
    if (seen.has(key))
      return false;
    seen.add(key);
    return true;
  });
}

export function trimAxeResults(
  results: Pick<AxeScanResult, 'violations'>,
  options: { maxNodesPerViolation: number }
): TrimmedAxeViolation[] {
  return results.violations.map(violation => {
    const nodes = dedupeAxeNodes(violation.nodes).slice(0, options.maxNodesPerViolation).map(node => ({
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
