import axe from 'axe-core';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { truncateDataUrls } from '../utils/dataUrl.js';

import type { ElementHandle, Frame, Page } from 'playwright';

declare global {
  interface Window {
    axe?: typeof axe;
    __mcpAccessibilityScannerAxe?: typeof axe;
    __mcpAccessibilityScannerAxeReady?: string;
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

const axeReadyMarker = '__mcpAccessibilityScannerAxeReady';
let axeReadySequence = 0;
const axeReadyNonce = randomUUID();

const axeConfigureSource = `;axe.configure({ allowedOrigins: ['<unsafe_all_origins>'], branding: { application: 'playwright' } });`;

async function injectAxe(frame: Frame, source: string): Promise<void> {
  await frame.evaluate(source);
}

const axeForNamesGlobal = '__mcpAccessibilityScannerAxe';
const axeForNamesSource = [
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
  `window[${JSON.stringify(axeForNamesGlobal)}] = installed;`,
  '})();',
].join('\n');

const mainFrameInjectionTimeoutMs = 10_000;
const childFrameInjectionTimeoutMs = 1000;
const maxCoverageCheckRounds = 4;

export const frameConcurrency = 4;

export function frameReadTimeoutMs(frame: Frame): number {
  return frame.parentFrame() === null ? mainFrameInjectionTimeoutMs : childFrameInjectionTimeoutMs;
}

export async function injectAxeForNames(frame: Frame): Promise<boolean> {
  return injectAxe(frame, axeForNamesSource).then(() => true, () => false);
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

async function hasAxe(frame: Frame, token: string): Promise<boolean> {
  return withFrameTimeout(
      frame.evaluate(({ marker, token }) => window[marker] === token, { marker: axeReadyMarker, token } as const),
      false,
  );
}

type FrameScope = {
  included: boolean;
  excluded: boolean;
  hidden: boolean;
};

function inspectFrameScope(frameElement: Element, scope: { include: string[], exclude: string[] }): FrameScope {
  function flattenedParentOf(element: Element): Element | null {
    while (element.assignedSlot)
      element = element.assignedSlot;
    const root = element.getRootNode();
    return element.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }

  function composedAncestorsOf(element: Element): Element[] {
    const ancestors: Element[] = [];
    for (let current: Element | null = element; current; current = flattenedParentOf(current))
      ancestors.push(current);
    return ancestors;
  }

  function allDocumentAndShadowRoots(): (Document | ShadowRoot)[] {
    const roots: (Document | ShadowRoot)[] = [document];
    for (const root of roots) {
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot)
          roots.push(element.shadowRoot);
      }
    }
    return roots;
  }

  function isVisibleOnTop(root: Document | ShadowRoot, modal: Element): boolean {
    const style = getComputedStyle(modal);
    const rect = modal.getBoundingClientRect();
    const visible = modal.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ??
      (style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility) && style.opacity !== '0');
    return visible && rect.width > 0 && rect.height > 0 && root.elementsFromPoint(rect.left + 1, rect.top + 1).includes(modal);
  }

  function flattenedChildrenOf(parent: Element): Element[] {
    return [...parent.children].flatMap(child => {
      if (child.localName !== 'slot')
        return [child];
      const assigned = (child as HTMLSlotElement).assignedElements({ flatten: true });
      return assigned.length ? assigned : [...child.children];
    });
  }

  function isCollapsedByClosedDetails(element: Element, parent: Element | null): boolean {
    if (parent?.localName !== 'details' || parent.hasAttribute('open'))
      return false;
    const isSummaryOfDetails = element.localName === 'summary' && flattenedChildrenOf(parent).find(child => child.localName === 'summary') === element;
    return !isSummaryOfDetails;
  }

  function hidesItsSubtree(element: Element): boolean {
    const parent = flattenedParentOf(element);
    const style = getComputedStyle(element);
    return element.getAttribute('aria-hidden') === 'true'
      || style.display === 'none'
      || element.hasAttribute('inert')
      || isCollapsedByClosedDetails(element, parent)
      || (element !== frameElement && style.getPropertyValue('content-visibility') === 'hidden');
  }

  const ancestors = composedAncestorsOf(frameElement);
  // Axe resolves flat CSS in the document and omits slot nodes from its scan tree.
  const matchesSelector = (selector: string) => ancestors.some(element =>
    element.getRootNode() === document && !(element instanceof HTMLSlotElement) && element.matches(selector));
  const openModals = allDocumentAndShadowRoots().flatMap(root => [...root.querySelectorAll('dialog:modal')].filter(modal => isVisibleOnTop(root, modal)));
  const blockedByModal = openModals.length > 0 && !openModals.some(modal => ancestors.includes(modal));
  const frameVisibility = getComputedStyle(frameElement).visibility;
  const hidden = blockedByModal
    || ancestors.some(hidesItsSubtree)
    || frameVisibility === 'hidden'
    || frameVisibility === 'collapse';
  return { included: scope.include.some(matchesSelector), excluded: scope.exclude.some(matchesSelector), hidden };
}

async function readFrameElement<T>(
  frame: Frame,
  fallback: T,
  read: (element: ElementHandle) => Promise<T>
): Promise<T> {
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

async function isFrameInScope(
  frame: Frame,
  mainFrame: Frame,
  include: readonly string[],
  exclude: readonly string[]
): Promise<boolean> {
  let includeMatched = !include.length;
  for (let current = frame; current.parentFrame(); current = current.parentFrame()!) {
    const matches = await readFrameElement<FrameScope | null>(current, null, element => element.evaluate(
        inspectFrameScope,
        current.parentFrame() === mainFrame
          ? { include: [...include], exclude: [...exclude] }
          : { include: [], exclude: [] },
    ));
    if (!matches)
      return true;
    if (matches.hidden)
      return false;
    if (matches.excluded)
      return false;
    includeMatched ||= matches.included;
  }
  return includeMatched;
}

function findFramesMissedByAxe(
  frames: readonly Frame[],
  covered: readonly boolean[],
  mainFrame: Frame
): Frame[] {
  const withoutAxe = new Set(frames.filter((_, index) => !covered[index]));
  return frames.filter(frame => {
    for (let current: Frame | null = frame; current && current !== mainFrame; current = current.parentFrame()) {
      if (withoutAxe.has(current))
        return true;
    }
    return false;
  });
}

function haveSameFrames(left: readonly Frame[], right: readonly Frame[]): boolean {
  return left.length === right.length && left.every((frame, index) => frame === right[index]);
}

async function injectAxeIntoFrames(
  page: Page,
  include: readonly string[],
  exclude: readonly string[]
): Promise<string[]> {
  const token = `${axe.version}:${axeReadyNonce}:${++axeReadySequence}`;
  const source = `${axe.source}${axeConfigureSource}window[${JSON.stringify(axeReadyMarker)}]=${JSON.stringify(token)};`;
  const mainFrame = page.mainFrame();
  await injectAxe(mainFrame, source);
  await withConcurrency(
      childFramesOf(page),
      frame => withFrameTimeout(injectAxe(frame, source), undefined),
  );

  const stableFrameIds = new Map<Frame, number>();
  const frameId = (frame: Frame) => {
    if (!stableFrameIds.has(frame))
      stableFrameIds.set(frame, stableFrameIds.size);
    return stableFrameIds.get(frame)!;
  };
  let previousSignature: string | undefined;
  for (let round = 0; round < maxCoverageCheckRounds; round++) {
    const frames = childFramesOf(page);
    const covered = await withConcurrency(frames, frame => hasReachableAxe(frame, token));
    const missed = findFramesMissedByAxe(frames, covered, mainFrame);
    const scopeResults = await withConcurrency(missed, frame => isFrameInScope(frame, mainFrame, include, exclude));
    const inScope = new Set(missed.filter((_, index) => scopeResults[index]));
    if (!haveSameFrames(frames, childFramesOf(page))) {
      previousSignature = undefined;
      continue;
    }
    if (!missed.length)
      return [];
    const signature = frames.map((frame, index) => `${frameId(frame)}:${covered[index] ? 1 : 0}:${inScope.has(frame) ? 1 : 0}`).join(',');
    if (signature === previousSignature)
      return missed.filter(frame => inScope.has(frame)).map(describeFrame);
    previousSignature = signature;
  }
  throw new Error('The frame tree kept changing while Axe coverage was checked. Retry the scan once the page settles.');
}

function childFramesOf(page: Page): Frame[] {
  const mainFrame = page.mainFrame();
  return page.frames().filter(frame => frame !== mainFrame);
}

function isFrameElementReachable(element: Element): boolean {
  for (let current = element; ;) {
    const root = current.getRootNode();
    if (!(root instanceof ShadowRoot))
      return true;
    if (root.host.shadowRoot !== root)
      return false;
    current = root.host;
  }
}

async function hasReachableAxe(frame: Frame, token: string): Promise<boolean> {
  if (!await hasAxe(frame, token))
    return false;
  const reachable = await readFrameElement(frame, false, element => element.evaluate(isFrameElementReachable));
  return reachable && await hasAxe(frame, token);
}

async function runAxeInPage({ context, options }: { context: axe.ElementContext | null, options: axe.RunOptions }) {
  const results = await window.axe!.run(context ?? document, options);
  const findings = (rules: axe.Result[]) => rules.map(rule => ({
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
  return {
    url: results.url,
    violations: findings(results.violations),
    incomplete: findings(results.incomplete),
    passes: results.passes.map(rule => ({ id: rule.id })),
    inapplicable: results.inapplicable.map(rule => ({ id: rule.id })),
  };
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

  const context = include.length || exclude.length ? { include: [...include], exclude: [...exclude] } : null;

  const unscannedFrames = await injectAxeIntoFrames(page, include, exclude);
  const results = await page.evaluate(runAxeInPage, { context, options: axeOptions });
  return { ...results, unscannedFrames };
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
