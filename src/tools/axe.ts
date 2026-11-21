import axe from 'axe-core/axe.min.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { truncateDataUrls } from '../utils/dataUrl.js';
import { finishFrameTree, scannedFrame, unscannedFrame, unscannedFramesOf } from './axeFrameTree.js';

import type { FrameOutcome, ScannedFrame, SerializedPartial } from './axeFrameTree.js';
import type { ElementHandle, Frame, JSHandle, Page } from 'playwright';

declare global {
  interface Window {
    __mcpAccessibilityScannerAxe?: typeof axe;
    __mcpAccessibilityScannerProjectReport?: (results: axe.AxeResults) => Omit<AxeScanResult, 'unscannedFrames'>;
    __mcpAccessibilityScannerLiveness?: string;
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

type ScanFindings = Omit<AxeScanResult, 'unscannedFrames'>;

function projectReport(results: axe.AxeResults): ScanFindings {
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

const axePrivateGlobal = '__mcpAccessibilityScannerAxe' satisfies keyof Window;
const projectReportGlobal = '__mcpAccessibilityScannerProjectReport' satisfies keyof Window;
const axePrivateSource = [
  '(() => {',
  'const module = { exports: {} };',
  'const define = undefined;',
  'const hadAxe = \'axe\' in window;',
  'const pageAxe = window.axe;',
  'try {',
  axe.source,
  '} finally {',
  'try { if (!hadAxe) delete window.axe; else if (window.axe !== pageAxe) window.axe = pageAxe; } catch {}',
  '}',
  'const installed = module.exports;',
  `if (typeof installed.runPartial !== 'function') throw new Error('axe-core was not installed');`,
  'installed.frameMessenger({ open() {}, post() { return false; } });',
  `installed.configure({ branding: { application: 'playwright' } });`,
  `window[${JSON.stringify(axePrivateGlobal)}] = installed;`,
  `window[${JSON.stringify(projectReportGlobal)}] = ${projectReport.toString()};`,
  '})();',
].join('\n');

axe.configure({ branding: { application: 'playwright' } });

const mainFrameInjectionTimeoutMs = 10_000;
const childFrameCallTimeoutMs = 1000;
const childFrameLivenessTimeoutMs = 500;
const livenessPollMs = 25;
const childFrameRunTimeoutMs = 60_000;

export const frameConcurrency = 4;

export function frameReadTimeoutMs(frame: Frame): number {
  return frame.parentFrame() === null ? mainFrameInjectionTimeoutMs : childFrameCallTimeoutMs;
}

async function installAxe(frame: Frame): Promise<void> {
  await frame.evaluate(axePrivateSource);
}

export async function injectAxe(frame: Frame): Promise<boolean> {
  return installAxe(frame).then(() => true, () => false);
}

export async function withFrameTimeout<T>(work: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
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

type WorkLimit = <T>(work: () => Promise<T>) => Promise<T>;

function createWorkLimit(limit: number): WorkLimit {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async work => {
    if (active < limit)
      active++;
    else
      await new Promise<void>(resolve => waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next)
        next();
      else
        active--;
    }
  };
}

const maxFrameNameLength = 80;
const maxFrameUrlLength = 2048;

function describeFrame(frame: Frame): string {
  const rawUrl = truncateDataUrls(frame.url()) || 'about:blank';
  const url = rawUrl.length > maxFrameUrlLength ? `${rawUrl.slice(0, maxFrameUrlLength - 3)}...` : rawUrl;
  const name = truncateDataUrls(frame.name().replace(/\s+/g, ' ').trim()).slice(0, maxFrameNameLength);
  return name ? `${url} (name="${name}")` : url;
}

type ScanContext = axe.SerialContextObject | axe.FrameContextObject;

type SelectedChild = {
  context: axe.FrameContext;
  element: ElementHandle | null;
};

type FrameScan = {
  partial: SerializedPartial;
  children: SelectedChild[];
};

type PlainReport = { report: ScanFindings };

type FrameRunInfo = {
  childFrames: axe.FrameContext[];
  frameCount: number;
  plainRun: boolean;
};

type UserScope = { include: string[], exclude: string[] };
const noScope: UserScope = { include: [], exclude: [] };

type FrameWalk = { options: axe.RunOptions, limit: WorkLimit };

async function scanInPage({ context, options, allowPlainRun }: { context: ScanContext, options: axe.RunOptions, allowPlainRun: boolean }): Promise<[FrameRunInfo, string, ...(Element | null)[]]> {
  const instance = window.__mcpAccessibilityScannerAxe!;
  const mayContainFrames = () => {
    if (window.length)
      return true;
    const roots: ParentNode[] = [document];
    for (const root of roots) {
      for (const element of root.querySelectorAll('*')) {
        if (!element.shadowRoot)
          continue;
        if (element.shadowRoot.querySelector('iframe, frame'))
          return true;
        roots.push(element.shadowRoot);
      }
    }
    return false;
  };
  const followAncestry = (selector: axe.CrossTreeSelector) => {
    let root: Document | ShadowRoot | null = document;
    let element: Element | null = null;
    for (const treeSelector of [selector].flat()) {
      let children: Element[] = root ? [...root.children] : [];
      element = null;
      for (const step of String(treeSelector).split(' > ')) {
        const [, escapedName, position] = /^(.+?)(?::nth-child\((\d+)\))?$/.exec(step.trim()) ?? [];
        const name = escapedName?.replace(/\\(.)/g, '$1').toLowerCase();
        const candidate: Element | undefined = position ? children[Number(position) - 1] : children.find(child => child.nodeName.toLowerCase() === name);
        if (!name || candidate?.nodeName.toLowerCase() !== name)
          return null;
        element = candidate;
        children = [...candidate.children];
      }
      root = element?.shadowRoot ?? null;
    }
    return element;
  };
  const selectFrame = (selector: axe.CrossTreeSelector) => {
    const element = followAncestry(selector);
    return element && ['iframe', 'frame'].includes(element.localName.toLowerCase()) ? element : null;
  };

  const childFrames = mayContainFrames() ? instance.utils.getFrameContexts(context, options) : [];
  if (allowPlainRun && !childFrames.length) {
    const report = window.__mcpAccessibilityScannerProjectReport!(await instance.run(context, { ...options, iframes: false }));
    return [{ childFrames, frameCount: 0, plainRun: true }, JSON.stringify(report)];
  }
  const frameElements = childFrames.map(({ frameSelector }) => selectFrame(frameSelector));
  const partial = await instance.runPartial(context, options);
  return [{ childFrames, frameCount: partial.frames.length, plainRun: false }, JSON.stringify(partial), ...frameElements];
}

function isInScopeClosedShadowFrame(frameElement: Element, scope: UserScope): boolean {
  const parentOf = (element: Element) => {
    const root = element.getRootNode();
    return element.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  };
  const pathFrom = (next: (element: Element) => Element | null) => {
    const path: Element[] = [];
    for (let current: Element | null = frameElement; current; current = next(current))
      path.push(current);
    return path;
  };
  const treePath = pathFrom(parentOf);
  const ownRoots = treePath.map(element => element.getRootNode()).filter(root => root instanceof ShadowRoot);
  if (!ownRoots.some(root => root.host.shadowRoot !== root) || !frameElement.checkVisibility({ checkVisibilityCSS: true }))
    return false;

  const composedPath = pathFrom(element => element.assignedSlot ?? parentOf(element));
  if (composedPath.some(element => element.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true'))
    return false;
  const enclosingModal = composedPath.findIndex(element => element.matches('dialog:modal'));
  const inertCandidates = enclosingModal === -1 ? composedPath : composedPath.slice(0, enclosingModal + 1);
  if (inertCandidates.some(element => element.hasAttribute('inert')))
    return false;

  const roots: (Document | ShadowRoot)[] = [document, ...new Set(ownRoots)];
  for (const root of roots) {
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot && !roots.includes(element.shadowRoot))
        roots.push(element.shadowRoot);
    }
  }
  const modals = roots.flatMap(root => [...root.querySelectorAll('dialog:modal')]);
  const enclosingModals = modals.filter(modal => composedPath.includes(modal));
  if (modals.length && !enclosingModals.length)
    return false;
  const composedContains = (container: Element, node: Element) => {
    for (let current: Element | null = node; current; current = current.assignedSlot ?? parentOf(current)) {
      if (current === container)
        return true;
    }
    return false;
  };
  const isCoveredByAnotherModal = (modal: Element) => {
    const box = modal.getBoundingClientRect();
    if (!box.width || !box.height)
      return false;
    const [hit] = (modal.getRootNode() as Document | ShadowRoot).elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return !!hit && !composedContains(modal, hit) && modals.some(other => other !== modal && composedContains(other, hit));
  };
  if (modals.length > 1 && enclosingModals.every(isCoveredByAnotherModal))
    return false;

  const closestMatch = (selectors: string[]) => {
    const matches = new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]));
    const depth = treePath.findIndex(element => matches.has(element));
    return depth === -1 ? Infinity : depth;
  };
  const include = scope.include.length ? closestMatch(scope.include) : treePath.length;
  return include !== Infinity && include <= closestMatch(scope.exclude);
}

async function readFrameElement<T>(frame: Frame, fallback: T, read: (element: ElementHandle) => Promise<T>): Promise<T> {
  const elementPromise = frame.frameElement().catch(() => null);
  const element = await withFrameTimeout(elementPromise, null, childFrameCallTimeoutMs);
  if (!element) {
    void elementPromise.then(late => late?.dispose().catch(() => {}));
    return fallback;
  }
  try {
    return await withFrameTimeout(read(element), fallback, childFrameCallTimeoutMs);
  } finally {
    await element.dispose().catch(() => {});
  }
}

async function closedShadowFrames(frame: Frame, visited: ReadonlySet<Frame>, scope: UserScope, limit: WorkLimit): Promise<string[]> {
  const unvisited = frame.childFrames().filter(child => !visited.has(child));
  const gaps = await Promise.all(unvisited.map(child => limit(() => readFrameElement(child, false, element => element.evaluate(isInScopeClosedShadowFrame, scope)))));
  return unvisited.filter((_, index) => gaps[index]).map(describeFrame);
}

function scanIn(frame: Frame, context: ScanContext, options: axe.RunOptions): Promise<FrameScan>;
function scanIn(frame: Frame, context: ScanContext, options: axe.RunOptions, allowPlainRun: true): Promise<FrameScan | PlainReport>;
async function scanIn(frame: Frame, context: ScanContext, options: axe.RunOptions, allowPlainRun = false): Promise<FrameScan | PlainReport> {
  const result = await frame.evaluateHandle(scanInPage, { context, options, allowPlainRun });
  let properties: Map<string, JSHandle>;
  try {
    properties = await result.getProperties();
  } finally {
    await result.dispose().catch(() => {});
  }
  let children: SelectedChild[] = [];
  try {
    const { childFrames, frameCount, plainRun } = await properties.get('0')!.jsonValue() as FrameRunInfo;
    const json = await properties.get('1')!.jsonValue() as string;
    if (plainRun)
      return { report: JSON.parse(json) as ScanFindings };
    children = childFrames.map((context, index) => ({ context, element: properties.get(String(index + 2))?.asElement() ?? null }));
    return { partial: { json, frameCount }, children };
  } finally {
    const kept = new Set<unknown>(children.map(child => child.element));
    for (const handle of properties.values()) {
      if (!kept.has(handle))
        void handle.dispose().catch(() => {});
    }
  }
}

type ChildRun = {
  outcome: FrameOutcome;
  frame?: Frame;
};

type OwnScan = { frame: Frame, scan: FrameScan };

async function scanDescendants(frame: Frame, scan: FrameScan, walk: FrameWalk, scope: UserScope): Promise<ScannedFrame> {
  const children = await Promise.all(scan.children.map(child => runChildFrame(frame, child, walk)));
  const visited = new Set(children.flatMap(run => run.frame ? [run.frame] : []));
  return scannedFrame(scan.partial, children.map(run => run.outcome), await closedShadowFrames(frame, visited, scope, walk.limit));
}

function armLivenessProbe(token: string): boolean {
  window.__mcpAccessibilityScannerLiveness = undefined;
  setTimeout(() => {
    window.__mcpAccessibilityScannerLiveness = token;
  });
  return true;
}

function livenessProbeFired(token: string): boolean {
  return window.__mcpAccessibilityScannerLiveness === token;
}

async function timersFire(frame: Frame): Promise<boolean> {
  const token = randomUUID();
  if (!await withFrameTimeout(frame.evaluate(armLivenessProbe, token), false, childFrameCallTimeoutMs))
    return false;
  const deadline = Date.now() + childFrameLivenessTimeoutMs;
  do {
    if (await withFrameTimeout(frame.evaluate(livenessProbeFired, token), false, childFrameCallTimeoutMs))
      return true;
    await new Promise(resolve => setTimeout(resolve, livenessPollMs));
  } while (Date.now() < deadline);
  return false;
}

async function canRunAxe(frame: Frame): Promise<boolean> {
  return await withFrameTimeout(injectAxe(frame), false, childFrameCallTimeoutMs) && await timersFire(frame);
}

async function contentFrameOf(parent: Frame, element: ElementHandle): Promise<Frame | null> {
  const direct = await element.contentFrame();
  if (direct)
    return direct;
  for (const candidate of parent.childFrames()) {
    const owner = await candidate.frameElement().catch(() => null);
    if (!owner)
      continue;
    try {
      if (await element.evaluate((node, other) => node === other, owner))
        return candidate;
    } finally {
      await owner.dispose().catch(() => {});
    }
  }
  return null;
}

async function scanOwnFrame(parent: Frame, { context, element }: SelectedChild, options: axe.RunOptions): Promise<ChildRun | OwnScan> {
  const child = element && await withFrameTimeout(contentFrameOf(parent, element), null, childFrameCallTimeoutMs);
  void element?.dispose().catch(() => {});
  if (!child)
    return { outcome: unscannedFrame(`${describeFrame(parent)} > ${[context.frameSelector].flat().join(' >>> ')}`) };
  const failed: ChildRun = { outcome: unscannedFrame(describeFrame(child)), frame: child };
  if (!await canRunAxe(child))
    return failed;
  const pending = scanIn(child, context.frameContext, options);
  const scan = await withFrameTimeout<FrameScan | null>(pending, null, childFrameRunTimeoutMs);
  if (!scan) {
    void pending.then(late => late.children.forEach(({ element }) => void element?.dispose().catch(() => {})), () => {});
    return failed;
  }
  return { frame: child, scan };
}

async function runChildFrame(parent: Frame, child: SelectedChild, walk: FrameWalk): Promise<ChildRun> {
  const own = await walk.limit(() => scanOwnFrame(parent, child, walk.options));
  if ('outcome' in own)
    return own;
  return { outcome: await scanDescendants(own.frame, own.scan, walk, noScope), frame: own.frame };
}

async function scanFrameTree(mainFrame: Frame, context: ScanContext, options: axe.RunOptions, scope: UserScope): Promise<ScanFindings & { unscannedFrames: string[] }> {
  const limit = createWorkLimit(frameConcurrency);
  const scan = await scanIn(mainFrame, context, options, true);
  if ('report' in scan)
    return { ...scan.report, unscannedFrames: await closedShadowFrames(mainFrame, new Set(), scope, limit) };
  const top = await scanDescendants(mainFrame, scan, { options, limit }, scope);
  return { ...projectReport(await finishFrameTree(top, options)), unscannedFrames: unscannedFramesOf(top) };
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

  const scope: UserScope = { include: [...include], exclude: [...exclude] };
  const context: ScanContext = include.length || exclude.length ? scope : { exclude: [] };

  const mainFrame = page.mainFrame();
  await installAxe(mainFrame);
  return scanFrameTree(mainFrame, context, axeOptions, scope);
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
      ? `WARNING: Axe could not scan frames on ${frames.length} ${options.unit}; their contents contribute no findings below.`
      : `WARNING: Axe could not scan ${frames.length} frame(s), whose contents contribute no findings above:`,
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
