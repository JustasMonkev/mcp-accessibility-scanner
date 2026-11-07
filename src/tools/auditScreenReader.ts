import { z } from 'zod';
import { defineTabTool } from './tool.js';
import { measureScreenReaderElements } from './screenReaderMeasurement.js';
import { reserveReportPath, writeJsonReport } from './report.js';

import type { ElementFacts, Rect } from './screenReaderMeasurement.js';

/** @public */
export { collectElementFacts } from './screenReaderMeasurement.js';
/** @public */
export type { ElementFacts, Rect } from './screenReaderMeasurement.js';

type AriaTreeNode = {
  role: string;
  name: string | null;
  level: number | null;
  ref: string | null;
  depth: number;
  parent: number | null;
};

/** @public */
export type ScreenReaderNode = AriaTreeNode & ElementFacts & { childCount: number };

/** @public */
export type ScreenReaderCheck =
  | 'missing-accessible-name'
  | 'uninformative-accessible-name'
  | 'filename-as-accessible-name'
  | 'label-in-name-mismatch'
  | 'duplicate-accessible-name'
  | 'reading-order-mismatch';

type ScreenReaderFinding = {
  check: ScreenReaderCheck;
  wcag: string;
  ref: string | null;
  role: string;
  name: string | null;
  selector: string | null;
  problem: string;
  fix: string;
};

type ScreenReaderAuditResult = {
  findings: ScreenReaderFinding[];
  countByCheck: Record<ScreenReaderCheck, number>;
  truncatedChecks: ScreenReaderCheck[];
};

type ScreenReaderAuditOptions = {
  checkNames: boolean;
  checkReadingOrder: boolean;
  maxFindingsPerCheck: number;
};

const namedRoles = new Set([
  'link', 'button', 'checkbox', 'radio', 'switch', 'textbox', 'searchbox', 'combobox',
  'listbox', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'treeitem', 'option', 'img', 'image',
]);

const labelInNameRoles = new Set([
  'link', 'button', 'checkbox', 'radio', 'switch', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'option', 'treeitem',
]);

const uninformativeNames = new Set([
  'click here', 'click', 'here', 'this link', 'link', 'read more', 'more', 'more info',
  'more information', 'more details', 'details', 'learn more', 'see more', 'view more',
  'read this', 'full story', 'go', 'untitled', 'image', 'photo', 'picture', 'graphic',
  'spacer', 'placeholder',
]);

const filenameNamePattern = /\.(jpe?g|png|gif|webp|svg|avif|bmp|tiff?|ico)$/i;
const cameraFileNamePattern = /^(img|dsc|dscn|pxl|screenshot|image|photo)[-_ ]?\d{3,}$/i;

const minLayoutSizePx = 2;
const layoutTolerancePx = 1;
const bandOverlapRatio = 0.5;

function normalizeText(value: string | null): string {
  if (!value)
    return '';
  return value.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** @public */
export function parseAriaSnapshot(snapshot: string): AriaTreeNode[] {
  const nodes: AriaTreeNode[] = [];
  const stack: { depth: number; index: number }[] = [];
  for (const rawLine of snapshot.split('\n')) {
    const quotedKey = /^(\s*)- '((?:[^']|'')*)'(.*)$/.exec(rawLine);
    const key = quotedKey ? `${quotedKey[1]}- ${quotedKey[2].replace(/''/g, '\'')}` : rawLine.split(/:\s|:$/)[0];
    const match = /^(\s*)- ([a-zA-Z]+)(?:\s+(?:"((?:[^"\\]|\\.)*)"|(\/(?:.*\/)?)))?(.*)$/.exec(key);
    if (!match)
      continue;
    const [, indentation, role, quotedName, slashName, metadata] = match;
    const depth = indentation.length;
    while (stack.length && stack[stack.length - 1].depth >= depth)
      stack.pop();
    const levelMatch = /\[level=(\d+)\]/.exec(metadata);
    nodes.push({
      role,
      name: quotedName === undefined ? slashName ?? null : quotedName.replace(/\\(.)/g, '$1'),
      level: levelMatch ? Number(levelMatch[1]) : null,
      ref: /\[ref=([^\]]+)\]/.exec(metadata)?.[1] ?? null,
      depth,
      parent: stack.length ? stack[stack.length - 1].index : null,
    });
    stack.push({ depth, index: nodes.length - 1 });
  }
  return nodes;
}

function nameLabel(node: ScreenReaderNode): string {
  if (node.name)
    return `"${node.name}"`;
  if (node.visibleText)
    return `showing "${node.visibleText.slice(0, 40)}"`;
  return 'no name';
}

function describe(node: ScreenReaderNode): string {
  return `${node.role} ${nameLabel(node)}${node.selector ? ` (${node.selector})` : ''}`;
}

type Axis = 'x' | 'y';

function spanOf(rect: Rect, axis: Axis): { start: number, size: number, end: number } {
  const start = axis === 'x' ? rect.x : rect.y;
  const size = axis === 'x' ? rect.width : rect.height;
  return { start, size, end: start + size };
}

function overlapRatio(a: Rect, b: Rect, axis: Axis): number {
  const first = spanOf(a, axis);
  const second = spanOf(b, axis);
  const overlap = Math.min(first.end, second.end) - Math.max(first.start, second.start);
  const smaller = Math.min(first.size, second.size);
  return smaller <= 0 ? 0 : overlap / smaller;
}

function uniqueSpansInOrder(rects: Rect[], axis: Axis): Rect[] {
  const sorted = [...rects].sort((first, second) => spanOf(first, axis).start - spanOf(second, axis).start || spanOf(first, axis).size - spanOf(second, axis).size);
  return sorted.filter((rect, index) => {
    if (index === 0)
      return true;
    const current = spanOf(rect, axis);
    const previous = spanOf(sorted[index - 1], axis);
    return current.start !== previous.start || current.size !== previous.size;
  });
}

class DisjointSets {
  private readonly _parent: number[];
  count: number;

  constructor(size: number) {
    this._parent = Array.from({ length: size }, (_, index) => index);
    this.count = size;
  }

  union(first: number, second: number): void {
    const firstRoot = this._root(first);
    const secondRoot = this._root(second);
    if (firstRoot === secondRoot)
      return;
    this._parent[secondRoot] = firstRoot;
    this.count--;
  }

  private _root(index: number): number {
    let root = index;
    while (this._parent[root] !== root)
      root = this._parent[root];
    while (this._parent[index] !== root) {
      const next = this._parent[index];
      this._parent[index] = root;
      index = next;
    }
    return root;
  }
}

function countBands(rects: Rect[], axis: Axis): number {
  const ordered = uniqueSpansInOrder(rects, axis);
  const bands = new DisjointSets(ordered.length);
  for (let i = 0; i < ordered.length; i++) {
    const end = spanOf(ordered[i], axis).end;
    for (let j = i + 1; j < ordered.length && spanOf(ordered[j], axis).start < end; j++) {
      if (overlapRatio(ordered[i], ordered[j], axis) < bandOverlapRatio)
        continue;
      bands.union(i, j);
      if (bands.count === 1)
        return 1;
    }
  }
  return bands.count;
}

function groupBy<T, K>(items: Iterable<T>, keyOf: (item: T) => K | undefined): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === undefined)
      continue;
    const group = groups.get(key);
    if (group)
      group.push(item);
    else
      groups.set(key, [item]);
  }
  return groups;
}

function isLayoutRelevant(node: ScreenReaderNode): boolean {
  if (!node.ref || !node.rect || node.positionFixed || node.floating || node.ariaHidden)
    return false;
  if (!/[\p{L}\p{N}]/u.test(node.visibleText ?? ''))
    return false;
  const { x, y, width, height } = node.rect;
  return width >= minLayoutSizePx && height >= minLayoutSizePx && x + width > 0 && y + height > 0;
}

function restoreDistilledNames(nodes: ScreenReaderNode[]): ScreenReaderNode[] {
  return nodes.map(node => node.name === null && node.accessibleName ? { ...node, name: node.accessibleName } : node);
}

function hasNamedControlAncestor(nodes: ScreenReaderNode[], index: number): boolean {
  for (let parent = nodes[index].parent; parent !== null; parent = nodes[parent].parent) {
    if (nodes[parent].name?.trim() && labelInNameRoles.has(nodes[parent].role))
      return true;
  }
  return false;
}

function checkAccessibleNames(nodes: ScreenReaderNode[], push: (finding: ScreenReaderFinding) => void) {
  for (const [index, node] of nodes.entries()) {
    if (!node.ref || node.ariaHidden)
      continue;
    const name = node.name?.trim() ?? '';
    const base = {
      ref: node.ref,
      role: node.role,
      name: node.name,
      selector: node.selector,
    };

    const isImage = node.role === 'img' || node.role === 'image';
    if (!name && namedRoles.has(node.role) && !(isImage && hasNamedControlAncestor(nodes, index))) {
      push({
        ...base,
        check: 'missing-accessible-name',
        wcag: '4.1.2 Name, Role, Value',
        problem: `${describe(node)} exposes no accessible name, so a screen reader announces only its role.`,
        fix: isImage
          ? 'Describe it with alt text (or a <title> child for inline SVG), or mark it decorative with alt="" and aria-hidden="true".'
          : 'Give it visible text, an aria-label, or an aria-labelledby pointing at visible text.',
      });
      continue;
    }

    if (!name)
      continue;

    const isNamedRole = namedRoles.has(node.role);

    if (isNamedRole && uninformativeNames.has(normalizeText(name))) {
      push({
        ...base,
        check: 'uninformative-accessible-name',
        wcag: '2.4.4 Link Purpose (In Context) / 2.4.9',
        problem: `${describe(node)} is announced as "${name}", which says nothing when read out of context in a links or controls list.`,
        fix: 'Rename it after its destination or action (e.g. "Pricing details"), or extend it with visually hidden text.',
      });
    }

    if (isImage && (filenameNamePattern.test(name) || cameraFileNamePattern.test(name))) {
      push({
        ...base,
        check: 'filename-as-accessible-name',
        wcag: '1.1.1 Non-text Content',
        problem: `${describe(node)} uses the file name "${name}" as its accessible name; a screen reader reads the file name aloud.`,
        fix: 'Replace the alt text with a description of what the image shows.',
      });
    }

    const visibleText = node.visibleText?.trim() ?? '';
    if (visibleLabelMissingFromName(node, visibleText, name)) {
      push({
        ...base,
        check: 'label-in-name-mismatch',
        wcag: '2.5.3 Label in Name',
        problem: `${describe(node)} shows "${visibleText}" but is announced as "${name}", so a voice-control user saying "click ${visibleText}" cannot activate it.`,
        fix: `Make the accessible name start with the visible text, e.g. aria-label="${visibleText} ${name}".`,
      });
    }
  }
}

function visibleLabelMissingFromName(node: ScreenReaderNode, visibleText: string, name: string): boolean {
  const normalizedVisible = normalizeText(visibleText);
  const isLeaf = node.childCount === 0;
  return labelInNameRoles.has(node.role)
    && isLeaf
    && !!normalizedVisible
    && visibleText.length <= 60
    && /[\p{L}\p{N}]/u.test(visibleText)
    && !normalizeText(name).includes(normalizedVisible);
}

function checkDuplicateNames(nodes: ScreenReaderNode[], push: (finding: ScreenReaderFinding) => void) {
  const siblingsWithSameName = groupBy(nodes, node => {
    const normalized = normalizeText(node.name);
    if (!node.ref || node.ariaHidden || !normalized || !labelInNameRoles.has(node.role))
      return undefined;
    return `${node.parent ?? -1}|${node.role}|${normalized}`;
  });

  for (const group of siblingsWithSameName.values()) {
    const targets = new Set(group.map(node => node.href));
    if (group.length < 2 || targets.has(null) || targets.size < 2)
      continue;
    push({
      check: 'duplicate-accessible-name',
      wcag: '2.4.4 Link Purpose (In Context)',
      ref: group[0].ref,
      role: group[0].role,
      name: group[0].name,
      selector: group[0].selector,
      problem: `${group.length} sibling ${group[0].role}s share the accessible name "${group[0].name}" but lead to different targets (${[...targets].slice(0, 4).join(', ')}).`,
      fix: 'Give each one a distinct accessible name, or append visually hidden text that names its target.',
    });
  }
}

type ReadingAxis = {
  isInverted: (furthest: Rect, current: Rect) => boolean;
  sortKey: (rect: Rect) => number;
};

function readingAxis(horizontal: boolean, rtl: boolean): ReadingAxis {
  if (!horizontal)
    return { isInverted: (a, b) => a.y >= b.y + b.height - layoutTolerancePx, sortKey: rect => rect.y };
  if (rtl)
    return { isInverted: (a, b) => a.x + a.width <= b.x + layoutTolerancePx, sortKey: rect => -(rect.x + rect.width) };
  return { isInverted: (a, b) => a.x >= b.x + b.width - layoutTolerancePx, sortKey: rect => rect.x };
}

function visitsBackwards(rects: Rect[], axis: ReadingAxis): boolean {
  let furthest = rects[0];
  for (const current of rects.slice(1)) {
    if (axis.isInverted(furthest, current))
      return true;
    if (axis.sortKey(current) > axis.sortKey(furthest))
      furthest = current;
  }
  return false;
}

function checkReadingOrder(nodes: ScreenReaderNode[], push: (finding: ScreenReaderFinding) => void) {
  const childrenByParent = groupBy(nodes, node => node.parent !== null && isLayoutRelevant(node) ? node.parent : undefined);

  for (const [parentIndex, siblings] of childrenByParent) {
    if (siblings.length < 2)
      continue;
    const rects = siblings.map(node => node.rect!);
    const rows = countBands(rects, 'y');
    const columns = countBands(rects, 'x');
    const horizontal = rows === 1 && columns > 1;
    const vertical = columns === 1 && rows > 1;
    if (!horizontal && !vertical)
      continue;

    const parent = nodes[parentIndex];
    const parentDirection = parent?.rect && parent.tagName !== 'iframe' ? parent.direction : siblings[0].direction;
    const rtl = parentDirection === 'rtl';
    const axis = readingAxis(horizontal, rtl);
    if (!visitsBackwards(rects, axis))
      continue;

    const visualOrder = [...siblings].sort((a, b) => axis.sortKey(a.rect!) - axis.sortKey(b.rect!));
    const label = (list: ScreenReaderNode[]) => list.slice(0, 6).map(node => describe(node)).join(' -> ')
        + (list.length > 6 ? ` -> ... (+${list.length - 6})` : '');
    push({
      check: 'reading-order-mismatch',
      wcag: '1.3.2 Meaningful Sequence',
      ref: parent?.ref ?? siblings[0].ref,
      role: parent?.role ?? 'generic',
      name: parent?.name ?? null,
      selector: parent?.selector ?? null,
      problem: `Inside ${parent ? describe(parent) : 'the page'}, screen readers and keyboard users follow DOM order [${label(siblings)}] but the ${rtl ? 'right-to-left ' : ''}visual order is [${label(visualOrder)}].`,
      fix: 'Reorder the source so DOM order matches the visual order; CSS order, flex-direction: row-reverse and absolute positioning move pixels but not the reading order.',
    });
  }
}

function inheritAriaHidden(nodes: ScreenReaderNode[]): ScreenReaderNode[] {
  const hidden = nodes.map(node => node.ariaHidden);
  return nodes.map((node, index) => {
    if (node.parent !== null && hidden[node.parent])
      hidden[index] = true;
    return hidden[index] === node.ariaHidden ? node : { ...node, ariaHidden: true };
  });
}

/** @public */
export function analyzeScreenReader(
  rawNodes: ScreenReaderNode[],
  options: ScreenReaderAuditOptions
): ScreenReaderAuditResult {
  const nodes = restoreDistilledNames(inheritAriaHidden(rawNodes));

  const findings: ScreenReaderFinding[] = [];
  const countByCheck = {
    'missing-accessible-name': 0,
    'uninformative-accessible-name': 0,
    'filename-as-accessible-name': 0,
    'label-in-name-mismatch': 0,
    'duplicate-accessible-name': 0,
    'reading-order-mismatch': 0,
  } satisfies Record<ScreenReaderCheck, number>;

  const push = (finding: ScreenReaderFinding) => {
    countByCheck[finding.check]++;
    if (countByCheck[finding.check] <= options.maxFindingsPerCheck)
      findings.push(finding);
  };

  if (options.checkNames) {
    checkAccessibleNames(nodes, push);
    checkDuplicateNames(nodes, push);
  }
  if (options.checkReadingOrder)
    checkReadingOrder(nodes, push);

  const truncatedChecks = (Object.keys(countByCheck) as ScreenReaderCheck[])
      .filter(check => countByCheck[check] > options.maxFindingsPerCheck);
  return { findings, countByCheck, truncatedChecks };
}

const auditScreenReaderSchema = z.object({
  checkNames: z.boolean().default(true).describe('Check accessible name quality (missing, generic, filename, label-in-name, duplicate sibling names).'),
  checkReadingOrder: z.boolean().default(true).describe('Compare accessibility tree order against visual position to find reading-order mismatches.'),
  maxElements: z.number().int().min(1).max(2000).default(400).describe('Maximum accessibility tree elements to analyze; extra elements are reported as truncated.'),
  maxFindingsPerCheck: z.number().int().min(1).max(200).default(20).describe('Maximum findings kept per check; the full count is still reported.'),
  reportFile: z.string().optional().describe('Output JSON report file name.'),
});

const auditScreenReader = defineTabTool({
  capability: 'core',
  schema: {
    name: 'audit_screen_reader',
    title: 'Audit screen reader experience',
    description: 'Audit accessible name quality and reading order using the browser accessibility tree and element geometry.',
    inputSchema: auditScreenReaderSchema,
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const reportPath = await reserveReportPath(tab.context, response, params.reportFile, 'audit-screen-reader');
    const ariaNodes = parseAriaSnapshot(await tab.page.ariaSnapshot({ mode: 'ai' }));

    const measurement = await measureScreenReaderElements(tab.page, ariaNodes, {
      maxElements: params.maxElements,
      checkNames: params.checkNames,
      reportProgress: progress => response.reportProgress(progress),
    });
    const { factsByIndex, totalElements, analyzedElements, limitations } = measurement;
    const { unresolvedElements: unresolvedCount, unmeasuredNames, truncatedElements, stoppedAtFrameWorkLimit } = limitations;

    const result = analyzeScreenReader(withElementFacts(ariaNodes, factsByIndex), {
      checkNames: params.checkNames,
      checkReadingOrder: params.checkReadingOrder,
      maxFindingsPerCheck: params.maxFindingsPerCheck,
    });

    const totalFindings = Object.values(result.countByCheck).reduce((sum, count) => sum + count, 0);

    const report = {
      version: 'v1',
      metadata: {
        url: tab.page.url(),
        options: params,
        generatedAt: new Date().toISOString(),
      },
      elements: {
        total: totalElements,
        analyzed: analyzedElements,
        unresolved: unresolvedCount,
        unmeasuredNames,
        truncated: truncatedElements > 0 || stoppedAtFrameWorkLimit !== null,
      },
      countByCheck: result.countByCheck,
      totalFindings,
      truncatedChecks: result.truncatedChecks,
      findings: result.findings,
    };

    const reportResource = await writeJsonReport(response, reportPath, report, {
      name: 'audit-screen-reader-report',
      title: 'Audit screen reader JSON report',
      description: 'JSON report for accessible name quality and reading order findings.',
    });
    response.setStructuredContent({
      kind: 'audit_screen_reader',
      report: reportResource,
      page: {
        url: tab.page.url(),
      },
      summary: {
        elementsTotal: totalElements,
        elementsAnalyzed: analyzedElements,
        elementsUnresolved: unresolvedCount,
        elementsWithoutMeasuredName: unmeasuredNames,
        elementsTruncated: truncatedElements,
        stoppedAtFrameWorkLimit,
        totalFindings,
        countByCheck: result.countByCheck,
        truncatedChecks: result.truncatedChecks,
      },
      findings: result.findings,
      reportUri: reportResource.uri,
    });

    response.addCode('// Read the accessibility tree with page.ariaSnapshot() and compared names and geometry against reading order.');
    response.addResult(renderScreenReaderSummary(result, measurement, totalFindings, params.maxFindingsPerCheck, reportResource.path));
  },
});

const emptyFacts: ElementFacts = {
  tagName: null,
  selector: null,
  visibleText: null,
  href: null,
  accessibleName: null,
  nameMeasured: false,
  rect: null,
  direction: 'ltr',
  positionFixed: false,
  floating: false,
  ariaHidden: false,
};

function withElementFacts(ariaNodes: AriaTreeNode[], factsByIndex: ReadonlyMap<number, ElementFacts>): ScreenReaderNode[] {
  const childCounts = new Map<number, number>();
  for (const node of ariaNodes) {
    if (node.parent !== null)
      childCounts.set(node.parent, (childCounts.get(node.parent) ?? 0) + 1);
  }
  return ariaNodes.map((node, index) => ({
    ...node,
    ...(factsByIndex.get(index) ?? emptyFacts),
    ref: factsByIndex.has(index) ? node.ref : null,
    childCount: childCounts.get(index) ?? 0,
  }));
}

type Measurement = Awaited<ReturnType<typeof measureScreenReaderElements>>;

function elementCountSuffix({ totalElements, analyzedElements, limitations }: Measurement): string {
  if (limitations.stoppedAtFrameWorkLimit !== null)
    return ` (stopped after ${analyzedElements} of ${totalElements}: timed-out frame work reached the ${limitations.stoppedAtFrameWorkLimit}-operation limit; re-run once the page is stable)`;
  if (limitations.truncatedElements > 0)
    return ` (truncated: analyzed the first ${analyzedElements} of ${totalElements}; raise maxElements to see the rest)`;
  return '';
}

function renderScreenReaderSummary(result: ScreenReaderAuditResult, measurement: Measurement, totalFindings: number, maxFindingsPerCheck: number, reportPath: string): string {
  const { unresolvedElements, unmeasuredNames } = measurement.limitations;
  const findingLines = result.findings.map(finding => (
    `- [${finding.check}] WCAG ${finding.wcag} — ${finding.problem}\n  Fix: ${finding.fix}${finding.ref ? `\n  Ref: ${finding.ref}` : ''}`
  ));
  return [
    `Elements analyzed: ${measurement.analyzedElements}${elementCountSuffix(measurement)}`,
    ...(unresolvedElements > 0
      ? [`WARNING: ${unresolvedElements} of these went stale before measurement (the page re-rendered mid-audit, or their frame stopped answering) and were not evaluated; findings may be incomplete. Re-run once the page is stable.`]
      : []),
    ...(unmeasuredNames > 0
      ? [`WARNING: accessible names could not be measured for ${unmeasuredNames} of these (axe-core could not be installed or run in their frame); a control named only through its children may be reported there as missing a name.`]
      : []),
    `Findings: ${totalFindings}`,
    'Check | Findings',
    '--- | ---',
    ...Object.entries(result.countByCheck).map(([check, count]) => `${check} | ${count}`),
    ...(result.truncatedChecks.length
      ? ['', `Showing at most ${maxFindingsPerCheck} findings per check; truncated: ${result.truncatedChecks.join(', ')}`]
      : []),
    '',
    ...(findingLines.length ? findingLines : ['- No screen-reader-level issues detected.']),
    '',
    `JSON report: ${reportPath}`,
  ].join('\n');
}

export default [
  auditScreenReader,
];
