import axe from 'axe-core';
import { z } from 'zod';

import { truncateDataUrl } from '../utils/dataUrl.js';

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
// The scan result carries only what the reporting tools read. Axe's own result
// object additionally holds the per-node check arrays and the full node list of
// every passing rule, which together are ~85% of a content-heavy page's result
// and are dropped inside the page rather than serialized across the CDP
// connection and thrown away here.
export type AxeNode = {
  target: axe.NodeResult['target'];
  html: string;
  failureSummary: string | null;
};

export type AxeViolation = {
  id: string;
  impact: axe.ImpactValue | null | undefined;
  tags: string[];
  help: string;
  helpUrl: string;
  description: string;
  nodes: AxeNode[];
};

export type AxeScanResult = {
  url: string;
  violations: AxeViolation[];
  incomplete: AxeViolation[];
  // Only the rule count of these is ever reported, so only the ids survive.
  passes: { id: string }[];
  inapplicable: { id: string }[];
  // Child frames Axe could not be installed in, and whose contents therefore
  // contributed nothing to the results above. Empty on a scan that covered
  // everything, so an empty violation list means something only when this is.
  unscannedFrames: string[];
};

export type AxeScanOptions = {
  tags?: readonly AxeTag[];
  rules?: readonly string[];
  disableRules?: readonly string[];
  include?: readonly string[];
  exclude?: readonly string[];
};

// Shared by every scan tool so scoping means the same thing everywhere.
export const axeScopeSchemaShape = {
  includeSelectors: z.array(z.string().min(1)).optional().describe('CSS selectors to restrict the scan to, e.g. ["#checkout-form"]. Omit to scan the whole page. Each selector may match multiple elements.'),
  excludeSelectors: z.array(z.string().min(1)).optional().describe('CSS selectors to exclude from the scan, e.g. ["#cookie-banner", "iframe.chat-widget"]. Applied after includeSelectors, so it can carve regions out of an included subtree.'),
};

// Shared by every scan tool so rule filtering means the same thing everywhere.
export const axeRuleSchemaShape = {
  withRules: z.array(z.string().min(1)).min(1).optional().describe('Run only these Axe rule ids, e.g. ["color-contrast", "image-alt"]. Axe can run a rule list or a tag list but never both, so setting withRules ignores violationsTag entirely. Unknown rule ids are rejected rather than silently skipped, and so is an empty list — omit the option to scan by tags instead.'),
  disableRules: z.array(z.string().min(1)).optional().describe('Axe rule ids to skip, e.g. ["color-contrast"]. Unlike withRules this narrows whatever is already selected, so it applies to violationsTag and withRules alike. Disabling every rule in withRules is an error, not an empty scan. Unknown rule ids are rejected rather than silently skipped.'),
};

// The rule catalogue comes from the very axe-core build injected into the page
// (`axe.source` below), so ids can never drift from what the scan supports and
// no extra injection is needed to check them.
// Axe does reject unknown ids itself, but only from inside the page after
// injection, surfacing as an opaque `frame.evaluate` failure; checking up front
// names the bad id and costs nothing.
let knownRuleIds: Set<string> | undefined;
function assertRuleIdsExist(ruleIds: readonly string[], label: 'withRules' | 'disableRules') {
  if (!ruleIds.length)
    return;
  knownRuleIds ??= new Set(axe.getRules().map(rule => rule.ruleId));
  const unknown = ruleIds.filter(ruleId => !knownRuleIds!.has(ruleId));
  if (unknown.length)
    throw new Error(`Unknown Axe rule id(s) in ${label}: ${unknown.join(', ')}. See https://dequeuniversity.com/rules/axe/ for valid ids.`);
}

// Rule options are run-wide input and need no page, so a crawler can validate
// them once before navigating anything instead of failing every page in turn.
// Returns the rule list to actually run, empty when the caller passed none.
// (Scope selectors stay per-page on purpose: a component may legitimately be
// absent from some pages of a crawl.)
export function assertRuleOptionsValid(options: Pick<AxeScanOptions, 'rules' | 'disableRules'>): string[] {
  // An explicitly empty list is a contradiction, not a no-op: the caller asked
  // to run only the listed rules and listed none. Treating it like an omitted
  // option would silently fall back to the full tag set and scan far more than
  // requested — the same trap the disableRules-empties-withRules guard closes.
  if (options.rules && !options.rules.length)
    throw new Error('withRules is an empty list, which would silently fall back to scanning the full tag set. Omit withRules to scan by tags, or name at least one rule id.');
  assertRuleIdsExist(options.rules ?? [], 'withRules');
  assertRuleIdsExist(options.disableRules ?? [], 'disableRules');
  if (!options.rules?.length)
    return [];
  // axe's ruleShouldRun returns on the runOnly-is-a-rule-list branch before it
  // ever reads the per-rule `enabled` flag that disableRules sets, so passing
  // both would silently run a rule the caller asked to disable. Subtract here
  // so disableRules means the same thing next to withRules as next to tags.
  const disabled = new Set(options.disableRules ?? []);
  const rules = options.rules.filter(rule => !disabled.has(rule));
  // axe rejects an empty runOnly list with a message that names neither
  // option, and falling back to the tag set would scan far more than asked.
  if (!rules.length)
    throw new Error(`disableRules disabled every rule in withRules (${options.rules.join(', ')}), leaving nothing to scan.`);
  return rules;
}

// Axe only rejects a scope when the *whole* include set resolves to nothing, so
// one typo among several include selectors silently shrinks the scan and the
// report still looks clean. Resolve every selector ourselves first: a scan that
// quietly covers less than asked is worse than one that fails loudly.
async function assertScopeSelectorsResolve(
  page: playwright.Page,
  include: readonly string[],
  exclude: readonly string[]
) {
  if (!include.length && !exclude.length)
    return;
  // One round trip for both lists: the includes come first, so the counts split
  // back apart at `include.length`.
  const selectors = [...include, ...exclude];
  const counts = await page.evaluate(list => list.map(selector => {
    try {
      return document.querySelectorAll(selector).length;
    } catch {
      return -1;
    }
  }), selectors);

  for (const [label, list, offset] of [
    ['includeSelectors', include, 0],
    ['excludeSelectors', exclude, include.length],
  ] as const) {
    const invalid = list.filter((_, index) => counts[offset + index] === -1);
    if (invalid.length)
      throw new Error(`Invalid CSS in ${label}: ${invalid.join(', ')}`);
  }

  // An unmatched exclude only leaves extra content in scope, and a crawl may
  // legitimately hit pages without the excluded widget, so it is not an error.
  const unmatched = include.filter((_, index) => counts[index] === 0);
  if (unmatched.length)
    throw new Error(`No elements matched includeSelectors: ${unmatched.join(', ')}. The scan would have silently covered less of the page than requested.`);
}

// Axe's frame support needs its own copy in every frame, and the copy talks to
// the top-level run over postMessage. `<unsafe_all_origins>` is what lets a
// cross-origin frame answer; without it those frames go unscanned.
const axeConfigureSource = `;axe.configure({ allowedOrigins: ['<unsafe_all_origins>'], branding: { application: 'playwright' } });`;

// Injected fresh for every scan rather than reused when `window.axe` already
// looks right: that global belongs to the page, which may have installed its own
// axe or reconfigured ours since, and a scan must run this server's build and
// configuration. Re-injection costs ~70ms per frame against a multi-second scan.
async function injectAxe(frame: playwright.Frame): Promise<void> {
  await frame.evaluate(axe.source);
  await frame.evaluate(axeConfigureSource);
}

// A child frame that never answers must not hang the scan. It goes unscanned
// instead - but not silently: a frame Axe never reached contributes no
// violations, and an unreported one turns into a clean-looking report.
const childFrameInjectionTimeoutMs = 1000;

// Identifies a frame for the coverage warning. The URL alone is not enough for
// a srcdoc or scripted about:blank frame - both report "about:blank" while
// holding a whole document - so the frame's name comes along when it has one.
// The URL is truncated: a data: frame's URL is the document, and this string
// ends up in tool text, structured content and JSON reports alike.
function describeFrame(frame: playwright.Frame): string {
  const url = truncateDataUrl(frame.url()) || 'about:blank';
  const name = frame.name();
  return name ? `${url} (name="${name}")` : url;
}

// Whether this frame currently holds the Axe build about to be run. A frame that
// navigated after its injection - or that appeared since - answers no.
async function hasAxe(frame: playwright.Frame): Promise<boolean> {
  return await frame.evaluate(() => (window as any).axe?.version).catch(() => undefined) === axe.version;
}

// Returns an identifier for every child frame Axe could not be installed in, so
// the caller can say what the scan did not cover. Every failure is reported
// whatever the URL scheme: injection into an empty about:blank frame succeeds,
// so a frame that reaches here failed for a reason worth knowing about.
//
// Duplicates are kept: two unnamed about:blank frames that both fail are two
// documents that went unscanned, and collapsing them would under-count.
async function injectAxeIntoFrames(page: playwright.Page): Promise<string[]> {
  const mainFrame = page.mainFrame();
  await Promise.all(page.frames().map(async frame => {
    if (frame === mainFrame) {
      await injectAxe(frame);
      return;
    }
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    // Both branches resolve: a rejected loser of the race would surface as an
    // unhandled rejection once the winner has already been awaited.
    await Promise.race([
      injectAxe(frame).catch(() => {}),
      new Promise<void>(resolve => {
        timeoutId = setTimeout(resolve, childFrameInjectionTimeoutMs);
      }),
    ]).finally(() => clearTimeout(timeoutId));
  }));

  // Coverage is decided here rather than from the injection results: a frame
  // that navigated while a slower sibling was still injecting has a new document
  // without Axe, and one that appeared since was never injected at all. Both
  // would otherwise contribute nothing to a report that still looked complete.
  // The frame list is re-read for the same reason.
  //
  // Ceiling: a frame that navigates between this check and the run below is
  // still missed. The window is microseconds rather than the length of the
  // slowest injection, but it cannot be closed from outside the page.
  const children = page.frames().filter(frame => frame !== mainFrame);
  const covered = await Promise.all(children.map(hasAxe));
  return children.filter((_, index) => !covered[index]).map(describeFrame);
}

// Runs in the page. Keeps axe's own result shape minus the parts nothing reads:
// per-node check arrays, and the node lists of passing/inapplicable rules.
async function runAxeInPage({ context, options }: { context: unknown, options: unknown }) {
  const results = await (window as any).axe.run(context ?? document, options);
  const findings = (rules: any[]) => rules.map(rule => ({
    id: rule.id,
    impact: rule.impact,
    tags: rule.tags,
    help: rule.help,
    helpUrl: rule.helpUrl,
    description: rule.description,
    nodes: rule.nodes.map((node: any) => ({
      target: node.target,
      html: node.html,
      failureSummary: node.failureSummary ?? null,
    })),
  }));
  return {
    url: results.url,
    violations: findings(results.violations),
    incomplete: findings(results.incomplete),
    passes: results.passes.map((rule: any) => ({ id: rule.id })),
    inapplicable: results.inapplicable.map((rule: any) => ({ id: rule.id })),
  };
}

export async function runAxeScan(page: playwright.Page, options: AxeScanOptions = {}): Promise<AxeScanResult> {
  const rules = assertRuleOptionsValid(options);
  const include = options.include ?? [];
  const exclude = options.exclude ?? [];
  await assertScopeSelectorsResolve(page, include, exclude);

  // `runOnly` holds either a rule list or a tag list, never both. Explicit rule
  // ids are the more specific request, so they win over tags — and the per-rule
  // `enabled` flag disableRules would set is ignored on that branch, which is
  // why assertRuleOptionsValid already subtracted them from the list.
  const axeOptions: Record<string, unknown> = rules.length
    ? { runOnly: { type: 'rule', values: rules } }
    : { runOnly: { type: 'tag', values: [...(options.tags ?? defaultAxeTags)] } };
  if (!rules.length && options.disableRules?.length)
    axeOptions.rules = Object.fromEntries(options.disableRules.map(rule => [rule, { enabled: false }]));

  // exclude wins over include for overlapping subtrees, which is what "scan
  // this component minus the widget" needs.
  const context = include.length || exclude.length ? { include: [...include], exclude: [...exclude] } : null;

  const unscannedFrames = await injectAxeIntoFrames(page);
  const results = await page.evaluate(runAxeInPage, { context, options: axeOptions }) as AxeScanResult;
  return { ...results, unscannedFrames };
}

// A scan that could not reach a frame covered less than it looks like it did,
// so every tool that reports results says so in the same words.
export function unscannedFrameLines(unscannedFrames: string[]): string[] {
  if (!unscannedFrames.length)
    return [];
  return [
    '',
    `WARNING: Axe could not be installed in ${unscannedFrames.length} frame(s), whose contents were not scanned and contribute no findings above:`,
    ...unscannedFrames.map(url => `- ${url}`),
    'A frame that is still loading may succeed on a re-run; one that consistently fails must be audited on its own.',
  ];
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
): AxeViolation[] {
  // Callers that already deduped node lists can pass `dedupe: false` to skip a
  // redundant second dedup pass over potentially large node sets.
  const shouldDedupe = options.dedupe ?? true;
  return violations.map(violation => ({
    ...violation,
    nodes: (shouldDedupe ? dedupeAxeNodes(violation.nodes) : violation.nodes).slice(0, options.maxNodesPerViolation),
  }));
}

// Dedupe once and reuse: callers need the deduped nodes for per-rule counting
// and aggregation, and the trimmed copy for the report payload.
export function prepareAxeResults(
  violations: AxeViolation[],
  maxNodesPerViolation: number
): { deduped: AxeViolation[]; trimmed: AxeViolation[] } {
  const deduped = violations.map(violation => ({
    ...violation,
    nodes: dedupeAxeNodes(violation.nodes),
  }));
  return { deduped, trimmed: trimAxeResults(deduped, { maxNodesPerViolation, dedupe: false }) };
}

export function summarizeAxeViolations(violations: AxeViolation[]) {
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
