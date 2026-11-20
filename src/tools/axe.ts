import axe from 'axe-core/axe.min.js';
import { z } from 'zod';

import { truncateDataUrls } from '../utils/dataUrl.js';

import type { ElementHandle, Frame, Page } from 'playwright';

declare global {
  interface Window {
    __mcpAccessibilityScannerAxe?: typeof axe;
  }
}

export const axeTagValues = [
  'wcag2a', 'wcag2aa', 'wcag2aaa', 'wcag21a', 'wcag21aa', 'wcag21aaa',
  'wcag22a', 'wcag22aa', 'wcag22aaa', 'section508', 'cat.aria', 'cat.color',
  'cat.forms', 'cat.keyboard', 'cat.language', 'cat.name-role-value',
  'cat.parsing', 'cat.semantics', 'cat.sensory-and-visual-cues',
  'cat.structure', 'cat.tables', 'cat.text-alternatives', 'cat.time-and-media',
  'best-practice', 'experimental',
] as const;

export type AxeTag = (typeof axeTagValues)[number];

export const defaultAxeTags: readonly AxeTag[] = axeTagValues.filter(
    tag => tag.startsWith('wcag') || tag === 'section508'
);
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
  passes: { id: string }[];
  inapplicable: { id: string }[];
  unscannedFrames: string[];
};

export type AxeScanOptions = {
  tags?: readonly AxeTag[];
  rules?: readonly string[];
  disableRules?: readonly string[];
  include?: readonly string[];
  exclude?: readonly string[];
};

export const axeScopeSchemaShape = {
  includeSelectors: z.array(z.string().min(1)).optional().describe('CSS selectors to restrict the scan to, e.g. ["#checkout-form"]. Omit to scan the whole page. Each selector may match multiple elements.'),
  excludeSelectors: z.array(z.string().min(1)).optional().describe('CSS selectors to exclude from the scan, e.g. ["#cookie-banner", "iframe.chat-widget"]. Applied after includeSelectors, so it can carve regions out of an included subtree.'),
};

export const axeRuleSchemaShape = {
  withRules: z.array(z.string().min(1)).min(1).optional().describe('Run only these Axe rule ids, e.g. ["color-contrast", "image-alt"]. Axe can run a rule list or a tag list but never both, so setting withRules ignores violationsTag entirely. Unknown rule ids are rejected rather than silently skipped, and so is an empty list — omit the option to scan by tags instead.'),
  disableRules: z.array(z.string().min(1)).optional().describe('Axe rule ids to skip, e.g. ["color-contrast"]. Unlike withRules this narrows whatever is already selected, so it applies to violationsTag and withRules alike. Disabling every rule in withRules is an error, not an empty scan. Unknown rule ids are rejected rather than silently skipped.'),
};

export const axeScanSchemaShape = {
  violationsTag: z.array(z.enum(axeTagValues)).min(1).default([...defaultAxeTags]).describe('Axe tags to include in scans.'),
  maxNodesPerViolation: z.number().int().min(1).max(50).default(10).describe('Maximum nodes kept per violation in the report.'),
  reportFile: z.string().optional().describe('Output JSON report file name.'),
};

export function axeScanOptions(params: {
  violationsTag: readonly AxeTag[];
  withRules?: readonly string[];
  disableRules?: readonly string[];
  includeSelectors?: readonly string[];
  excludeSelectors?: readonly string[];
}): AxeScanOptions {
  return {
    tags: params.violationsTag,
    rules: params.withRules,
    disableRules: params.disableRules,
    include: params.includeSelectors,
    exclude: params.excludeSelectors,
  };
}

let knownRuleIds: Set<string> | undefined;
function assertRuleIdsExist(ruleIds: readonly string[], label: 'withRules' | 'disableRules') {
  if (!ruleIds.length)
    return;
  knownRuleIds ??= new Set(axe.getRules().map(rule => rule.ruleId));
  const unknown = ruleIds.filter(ruleId => !knownRuleIds!.has(ruleId));
  if (unknown.length)
    throw new Error(`Unknown Axe rule id(s) in ${label}: ${unknown.join(', ')}. See https://dequeuniversity.com/rules/axe/ for valid ids.`);
}

export function assertRuleOptionsValid(options: Pick<AxeScanOptions, 'rules' | 'disableRules'>): string[] {
  if (options.rules && !options.rules.length)
    throw new Error('withRules is an empty list, which would silently fall back to scanning the full tag set. Omit withRules to scan by tags, or name at least one rule id.');
  assertRuleIdsExist(options.rules ?? [], 'withRules');
  assertRuleIdsExist(options.disableRules ?? [], 'disableRules');
  if (!options.rules?.length)
    return [];
  const disabled = new Set(options.disableRules ?? []);
  const rules = options.rules.filter(rule => !disabled.has(rule));
  if (!rules.length)
    throw new Error(`disableRules disabled every rule in withRules (${options.rules.join(', ')}), leaving nothing to scan.`);
  return rules;
}

async function assertScopeSelectorsResolve(
  page: Page,
  include: readonly string[],
  exclude: readonly string[]
) {
  if (!include.length && !exclude.length)
    return;
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

  const unmatched = include.filter((_, index) => counts[index] === 0);
  if (unmatched.length)
    throw new Error(`No elements matched includeSelectors: ${unmatched.join(', ')}. The scan would have silently covered less of the page than requested.`);
}

// The scan reads results through a private global rather than `window.axe`,
// so a page that ships its own axe-core (or clobbers `window.axe`) can neither
// replace this build nor be replaced by it.
const axePrivateGlobal = '__mcpAccessibilityScannerAxe' satisfies keyof Window;
const axePrivateSource = [
  '(() => {',
  'const hadAxe = \'axe\' in window;',
  'const pageAxe = window.axe;',
  'let installed;',
  'try {',
  axe.source,
  'installed = window.axe;',
  '} finally {',
  'if (hadAxe) window.axe = pageAxe; else delete window.axe;',
  '}',
  `if (!installed || installed === pageAxe) throw new Error('axe-core was not installed');`,
  `installed.configure({ branding: { application: 'playwright' } });`,
  `window[${JSON.stringify(axePrivateGlobal)}] = installed;`,
  '})();',
].join('\n');

// helpUrl is minted wherever the report is built: in the page for a plain
// axe.run, here in Node for finishRun. Both instances carry the same branding.
axe.configure({ branding: { application: 'playwright' } });

const mainFrameInjectionTimeoutMs = 10_000;
const childFrameInjectionTimeoutMs = 1000;
// Matches axe.run's default pingWaitTime: how long a child frame gets to show
// it can run its own tasks before it is reported unscanned.
const childFrameLivenessTimeoutMs = 500;
// Matches axe.run's default frameWaitTime: the longest one child frame's own
// run may take. Its descendants each get their own budget.
const childFrameRunTimeoutMs = 60_000;

export const frameConcurrency = 4;

export function frameReadTimeoutMs(frame: Frame): number {
  return frame.parentFrame() === null ? mainFrameInjectionTimeoutMs : childFrameInjectionTimeoutMs;
}

export async function injectAxeForNames(frame: Frame): Promise<boolean> {
  return frame.evaluate(axePrivateSource).then(() => true, () => false);
}

export async function withFrameTimeout<T>(work: Promise<T>, fallback: T, timeoutMs = childFrameInjectionTimeoutMs): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.catch(() => fallback),
      new Promise<T>(resolve => {
        timeoutId = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function withConcurrency<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  let next = 0;
  const results: R[] = [];
  await Promise.all(Array.from(
      { length: Math.min(frameConcurrency, items.length) },
      async () => {
        while (next < items.length) {
          const index = next++;
          results[index] = await run(items[index]);
        }
      },
  ));
  return results;
}

const maxFrameNameLength = 80;
const maxFrameUrlLength = 2048;

function describeFrame(frame: Frame): string {
  const rawUrl = truncateDataUrls(frame.url()) || 'about:blank';
  const url = rawUrl.length > maxFrameUrlLength ? `${rawUrl.slice(0, maxFrameUrlLength - 3)}...` : rawUrl;
  const name = truncateDataUrls(frame.name().replace(/\s+/g, ' ').trim()).slice(0, maxFrameNameLength);
  return name ? `${url} (name="${name}")` : url;
}

// Only the serializable context forms: what the scan builds for the top frame,
// and what getFrameContexts hands back for each child frame.
type ScanContext = axe.SerialContextObject | axe.FrameContextObject;

type FramePartial = {
  partial: axe.PartialResult;
  childFrames: axe.FrameContext[];
};

type FrameScan = FramePartial & {
  // One per childFrames entry: the iframe element axe selected, or null when
  // its selector no longer resolved by the time it was captured.
  frameElements: (ElementHandle | null)[];
};

// The caller's selectors, which apply in the top document only.
type UserScope = { include: string[], exclude: string[] };
const noScope: UserScope = { include: [], exclude: [] };

// Runs in the page. getFrameContexts applies axe's own frame selection (scope,
// visibility to assistive technology, shadow DOM), so the frames it returns are
// exactly the ones axe.run would have asked to join the scan. Their elements
// are captured in the same task: resolving the positional selectors later
// could land on a different frame once an earlier sibling is removed.
//
// The partial result carries every passing and inapplicable node too (axe only
// applies resultTypes in finishRun), and it crosses the protocol as one JSON
// string because that is roughly twice as fast as Playwright's structured
// serialization for a payload of this size.
async function runPartialInPage({ context, options }: { context: ScanContext, options: axe.RunOptions }): Promise<[string, ...(Element | null)[]]> {
  const instance = window.__mcpAccessibilityScannerAxe!;
  const childFrames = instance.utils.getFrameContexts(context, options);
  const frameElements = childFrames.map(({ frameSelector }) => instance.utils.shadowSelect(frameSelector));
  const partial = await instance.runPartial(context, options);
  return [JSON.stringify({ partial, childFrames } satisfies FramePartial), ...frameElements];
}

// Runs in the page. A document with no frames to visit is scanned with a plain
// axe.run, which needs no frame messaging there and builds node selectors only
// for the nodes it reports, where runPartial serializes every node it touched.
// Returns null when there are frames, leaving the scan to the runPartial walk.
async function runWithoutFramesInPage({ context, options }: { context: ScanContext, options: axe.RunOptions }): Promise<string | null> {
  const instance = window.__mcpAccessibilityScannerAxe!;
  if (instance.utils.getFrameContexts(context, options).length)
    return null;
  return JSON.stringify(await instance.run(context, { ...options, iframes: false }));
}

// Runs in the page, on an iframe element axe did not visit. Axe cannot see into
// a closed shadow root, so a frame there is skipped without axe ever choosing
// to skip it. Such a frame counts as a coverage gap unless it is not rendered,
// is hidden from assistive technology, or lies outside the caller's scope.
function isInScopeClosedShadowFrame(frameElement: Element, scope: UserScope): boolean {
  const ancestors: Element[] = [];
  let closed = false;
  for (let current: Element | null = frameElement; current;) {
    ancestors.push(current);
    const root = current.getRootNode();
    if (!current.parentElement && root instanceof ShadowRoot)
      closed ||= root.host.shadowRoot !== root;
    current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  if (!closed || !frameElement.checkVisibility({ checkVisibilityCSS: true }))
    return false;
  if (ancestors.some(element => element.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true' || element.hasAttribute('inert')))
    return false;
  const contains = (selector: string) => ancestors.some(element => element.matches(selector));
  return !scope.exclude.some(contains) && (!scope.include.length || scope.include.some(contains));
}

async function readFrameElement<T>(frame: Frame, fallback: T, read: (element: ElementHandle) => Promise<T>): Promise<T> {
  const elementPromise = frame.frameElement().catch(() => null);
  const element = await withFrameTimeout(elementPromise, null);
  if (!element) {
    void elementPromise.then(late => late?.dispose().catch(() => {}));
    return fallback;
  }
  try {
    return await withFrameTimeout(read(element), fallback);
  } finally {
    await element.dispose().catch(() => {});
  }
}

// A frame whose element cannot be read (it detached, or its parent stopped
// answering) is not listed: most unvisited frames are ones axe skipped on
// purpose, and guessing would turn every detached frame into a false alarm.
async function closedShadowFrames(frame: Frame, visited: ReadonlySet<Frame>, scope: UserScope): Promise<string[]> {
  const unvisited = frame.childFrames().filter(child => !visited.has(child));
  const gaps = await withConcurrency(unvisited, child => readFrameElement(child, false, element => element.evaluate(isInScopeClosedShadowFrame, scope)));
  return unvisited.filter((_, index) => gaps[index]).map(describeFrame);
}

function disposeAll(handles: readonly (ElementHandle | null)[]) {
  for (const handle of handles)
    void handle?.dispose().catch(() => {});
}

async function runPartialIn(frame: Frame, context: ScanContext, options: axe.RunOptions): Promise<FrameScan> {
  const result = await frame.evaluateHandle(runPartialInPage, { context, options });
  try {
    const properties = await result.getProperties();
    const { partial, childFrames } = JSON.parse(await properties.get('0')!.jsonValue() as string) as FramePartial;
    const frameElements = childFrames.map((_, index) => properties.get(String(index + 1))?.asElement() ?? null);
    return { partial, childFrames, frameElements };
  } finally {
    await result.dispose().catch(() => {});
  }
}

type PartialRun = {
  // In the order finishRun requires: each frame, then its descendants, then
  // its next sibling. A frame that could not run is a null with no descendants.
  partials: axe.PartialResults;
  unscannedFrames: string[];
  // The child frame this run resolved to, whether or not it could be scanned.
  frame?: Frame;
};

async function scanDescendants(frame: Frame, scan: FrameScan, options: axe.RunOptions, scope: UserScope): Promise<PartialRun> {
  const children = await withConcurrency(
      scan.childFrames.map((child, index) => ({ child, element: scan.frameElements[index] })),
      ({ child, element }) => runChildFrame(frame, child, element, options),
  );
  const visited = new Set(children.flatMap(run => run.frame ? [run.frame] : []));
  return {
    partials: [scan.partial, ...children.flatMap(run => run.partials)],
    unscannedFrames: [...children.flatMap(run => run.unscannedFrames), ...await closedShadowFrames(frame, visited, scope)],
  };
}

// The counterpart of axe.run's frame ping. Injection alone is not enough: a
// sandbox without allow-scripts accepts the injected source yet never fires its
// timers, so runPartial would sit there until the run budget expires.
async function canRunAxe(frame: Frame): Promise<boolean> {
  return await withFrameTimeout(injectAxeForNames(frame), false)
    && await withFrameTimeout(frame.evaluate(() => new Promise<boolean>(resolve => setTimeout(() => resolve(true)))), false, childFrameLivenessTimeoutMs);
}

// A child frame that cannot be resolved, injected or run becomes a null in
// place of its results, which tells finishRun to skip it and its descendants.
// The run budget covers only this frame's own runPartial: a descendant that
// hangs costs that descendant alone, never the findings already collected.
async function runChildFrame(parent: Frame, { frameSelector, frameContext }: axe.FrameContext, element: ElementHandle | null, options: axe.RunOptions): Promise<PartialRun> {
  const child = element && await withFrameTimeout(element.contentFrame(), null);
  void element?.dispose().catch(() => {});
  if (!child)
    return { partials: [null], unscannedFrames: [`${describeFrame(parent)} > ${[frameSelector].flat().join(' >>> ')}`] };
  const failed: PartialRun = { partials: [null], unscannedFrames: [describeFrame(child)], frame: child };
  if (!await canRunAxe(child))
    return failed;
  const pending = runPartialIn(child, frameContext, options);
  const scan = await withFrameTimeout<FrameScan | null>(pending, null, childFrameRunTimeoutMs);
  if (!scan) {
    void pending.then(late => disposeAll(late.frameElements), () => {});
    return failed;
  }
  return { ...await scanDescendants(child, scan, options, noScope), frame: child };
}

function findingsOf(rules: axe.Result[]): AxeViolation[] {
  return rules.map(rule => ({
    id: rule.id,
    impact: rule.impact,
    tags: rule.tags,
    help: rule.help,
    helpUrl: rule.helpUrl,
    description: rule.description,
    nodes: rule.nodes.map(node => ({
      target: node.target,
      html: node.html,
      failureSummary: node.failureSummary ?? null,
    })),
  }));
}

async function scanFrameTree(mainFrame: Frame, context: ScanContext, options: axe.RunOptions, scope: UserScope): Promise<{ results: axe.AxeResults, unscannedFrames: string[] }> {
  const withoutFrames = await mainFrame.evaluate(runWithoutFramesInPage, { context, options });
  if (withoutFrames !== null)
    return { results: JSON.parse(withoutFrames) as axe.AxeResults, unscannedFrames: await closedShadowFrames(mainFrame, new Set(), scope) };
  const { partials, unscannedFrames } = await scanDescendants(mainFrame, await runPartialIn(mainFrame, context, options), options, scope);
  // finishRun merges every frame's results and runs the cross-frame `after`
  // checks. It needs no DOM, so it runs here rather than in a page where third-
  // party script could read cross-origin frames' findings.
  return { results: await axe.finishRun(partials, options), unscannedFrames };
}

export async function runAxeScan(page: Page, options: AxeScanOptions = {}): Promise<AxeScanResult> {
  const rules = assertRuleOptionsValid(options);
  const include = options.include ?? [];
  const exclude = options.exclude ?? [];
  await assertScopeSelectorsResolve(page, include, exclude);

  const axeOptions: axe.RunOptions = rules.length
    ? { runOnly: { type: 'rule', values: rules } }
    : { runOnly: { type: 'tag', values: [...(options.tags ?? defaultAxeTags)] } };
  if (!rules.length && options.disableRules?.length)
    axeOptions.rules = Object.fromEntries(options.disableRules.map(rule => [rule, { enabled: false }]));
  axeOptions.resultTypes = ['violations', 'incomplete'];

  const context: ScanContext = include.length || exclude.length
    ? { include: [...include], exclude: [...exclude] }
    : { exclude: [] };

  const mainFrame = page.mainFrame();
  await mainFrame.evaluate(axePrivateSource);
  const { results, unscannedFrames } = await scanFrameTree(mainFrame, context, axeOptions, { include: [...include], exclude: [...exclude] });
  return {
    url: results.url,
    violations: findingsOf(results.violations),
    incomplete: findingsOf(results.incomplete),
    passes: results.passes.map(rule => ({ id: rule.id })),
    inapplicable: results.inapplicable.map(rule => ({ id: rule.id })),
    unscannedFrames,
  };
}

export function unscannedFrameLines(
  frames: readonly string[],
  options: { unit?: string, maxEntries?: number, trailingLines?: readonly string[] } = {}
): string[] {
  if (!frames.length)
    return [];
  const entries = frames.slice(0, options.maxEntries ?? frames.length);
  return [
    ...(options.unit ? [] : ['']),
    options.unit
      ? `WARNING: Axe could not be installed in frames on ${frames.length} ${options.unit}; their contents were not scanned and contribute no findings below.`
      : `WARNING: Axe could not be installed in ${frames.length} frame(s), whose contents were not scanned and contribute no findings above:`,
    ...entries.map(frame => `- ${frame}`),
    ...(options.trailingLines ?? ['A frame that is still loading may succeed on a re-run; one that consistently fails must be audited on its own.']),
  ];
}

export function dedupeAxeNodes(nodes: AxeNode[]): AxeNode[] {
  const seen = new Set<string>();
  return nodes.filter(node => {
    const key = `${JSON.stringify(node.target ?? [])}|${node.html ?? ''}`;
    if (seen.has(key))
      return false;
    seen.add(key);
    return true;
  });
}

/** @public */
export function trimAxeResults(
  violations: AxeViolation[],
  options: { maxNodesPerViolation: number; dedupe?: boolean }
): AxeViolation[] {
  const shouldDedupe = options.dedupe ?? true;
  return violations.map(violation => ({
    ...violation,
    nodes: (shouldDedupe ? dedupeAxeNodes(violation.nodes) : violation.nodes).slice(0, options.maxNodesPerViolation),
  }));
}

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
