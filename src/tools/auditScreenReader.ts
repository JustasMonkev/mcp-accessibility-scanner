import { z } from 'zod';
import { defineTabTool } from './tool.js';
import { measureScreenReaderElements } from './screenReaderMeasurement.js';
import { writeJsonReport } from './report.js';
import { safeIsoTimestampForFileName } from '../utils/fileUtils.js';

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

// Roles that a screen-reader user reaches out of context, so an empty or
// meaningless accessible name leaves them with nothing to act on.
const namedRoles = new Set([
  'link', 'button', 'checkbox', 'radio', 'switch', 'textbox', 'searchbox', 'combobox',
  'listbox', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'treeitem', 'option', 'img', 'image',
]);

// Only roles whose accessible name is expected to start with the visible label;
// containers are excluded because their text is the concatenation of children.
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

// Bands narrower than this are noise (sr-only clip boxes, 1px spacers).
const minLayoutSizePx = 2;
const layoutTolerancePx = 1;
const bandOverlapRatio = 0.5;

function normalizeText(value: string | null): string {
  if (!value)
    return '';
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** @public */
export function parseAriaSnapshot(snapshot: string): AriaTreeNode[] {
  const nodes: AriaTreeNode[] = [];
  const stack: { depth: number; index: number }[] = [];
  for (const rawLine of snapshot.split('\n')) {
    // Playwright YAML-quotes the whole key when the accessible name contains
    // ": ", " #", braces or backticks, doubling any apostrophe inside it. Left
    // quoted, such a node is dropped and its children are mis-parented.
    const quotedKey = /^(\s*)- '((?:[^']|'')*)'(.*)$/.exec(rawLine);
    // Separate the key from inline text before finding the final slash: the
    // value can contain slashes too. Keys containing ": " are YAML-quoted.
    const key = quotedKey ? `${quotedKey[1]}- ${quotedKey[2].replace(/''/g, '\'')}` : rawLine.split(/:\s|:$/)[0];
    // AI snapshots do not convert strings to regexes. On Playwright 1.63,
    // literal names starting and ending in / are emitted without quotes;
    // keep their delimiters and backslashes exactly as the page named them.
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

function describe(node: ScreenReaderNode): string {
  const label = node.name ? `"${node.name}"` : node.visibleText ? `showing "${node.visibleText.slice(0, 40)}"` : 'no name';
  return `${node.role} ${label}${node.selector ? ` (${node.selector})` : ''}`;
}

function overlapRatio(a: Rect, b: Rect, axis: 'x' | 'y'): number {
  const aStart = axis === 'x' ? a.x : a.y;
  const bStart = axis === 'x' ? b.x : b.y;
  const aSize = axis === 'x' ? a.width : a.height;
  const bSize = axis === 'x' ? b.width : b.height;
  const overlap = Math.min(aStart + aSize, bStart + bSize) - Math.max(aStart, bStart);
  const smaller = Math.min(aSize, bSize);
  return smaller <= 0 ? 0 : overlap / smaller;
}

function countBands(rects: Rect[], axis: 'x' | 'y'): number {
  const band = rects.map((_, index) => index);
  // Iterative find with write-back path compression, so a long union chain
  // costs O(1) per lookup instead of a walk each time.
  const rootOf = (index: number): number => {
    let root = index;
    while (band[root] !== root)
      root = band[root];
    while (band[index] !== root) {
      const next = band[index];
      band[index] = root;
      index = next;
    }
    return root;
  };
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (overlapRatio(rects[i], rects[j], axis) >= bandOverlapRatio)
        band[rootOf(j)] = rootOf(i);
    }
  }
  return new Set(rects.map((_, index) => rootOf(index))).size;
}

function isLayoutRelevant(node: ScreenReaderNode): boolean {
  // Floated and fixed boxes are placed outside the normal flow on purpose (media
  // beside a paragraph, sticky bars), so their visual position never claims to
  // match source order.
  if (!node.ref || !node.rect || node.positionFixed || node.floating || node.ariaHidden)
    return false;
  // Only text-bearing elements can change what is *read* when they move. Icon
  // affordances next to their label (disclosure arrows, leading glyphs) are the
  // single largest source of false reading-order alarms.
  if (!/[\p{L}\p{N}]/u.test(node.visibleText ?? ''))
    return false;
  const { x, y, width, height } = node.rect;
  // Off-canvas and clipped boxes are the standard visually-hidden techniques:
  // they have no visual order to compare the reading order against.
  return width >= minLayoutSizePx && height >= minLayoutSizePx && x + width > 0 && y + height > 0;
}

/**
 * Playwright's AI snapshot drops a name once every element that produced it
 * is rendered as the node's own children (removeRedundantNames in its
 * distiller, since 1.62): `<a><strong>Docs</strong></a>` becomes `- link:`
 * over `- strong: Docs`, and a control labelled through aria-labelledby by
 * one of its own descendants loses its name the same way. The accessibility
 * tree still has the name, so it is taken from the one measured in the page.
 * A control the page names nothing keeps its missing name, and a name the
 * snapshot does carry is never replaced.
 */
function restoreDistilledNames(nodes: ScreenReaderNode[]): ScreenReaderNode[] {
  return nodes.map(node => node.name === null && node.accessibleName ? { ...node, name: node.accessibleName } : node);
}

// An image inside a named link or button is announced through that control, so
// its own missing name is not a defect (icon buttons are full of these).
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

    // Both name-quality checks below judge how a control or image is announced,
    // so they only apply to roles that carry their own name.
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

    // Only an image is *described* by its name, so only there is a file name a
    // defect; a link or button legitimately named after the file it downloads
    // ("logo.png") is doing its job.
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
    const normalizedVisible = normalizeText(visibleText);
    const isLeaf = node.childCount === 0;
    if (labelInNameRoles.has(node.role) && isLeaf && normalizedVisible && visibleText.length <= 60
        && /[\p{L}\p{N}]/u.test(visibleText) && !normalizeText(name).includes(normalizedVisible)) {
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

function checkDuplicateNames(nodes: ScreenReaderNode[], push: (finding: ScreenReaderFinding) => void) {
  const byParent = new Map<string, ScreenReaderNode[]>();
  for (const node of nodes) {
    const normalized = normalizeText(node.name);
    if (!node.ref || node.ariaHidden || !normalized || !labelInNameRoles.has(node.role))
      continue;
    const key = `${node.parent ?? -1}|${node.role}|${normalized}`;
    const group = byParent.get(key);
    if (group)
      group.push(node);
    else
      byParent.set(key, [node]);
  }

  for (const group of byParent.values()) {
    // Same name pointing at the same destination is allowed (WCAG 2.4.4); only
    // siblings that do different things are ambiguous. A destination is only
    // observable for links, so controls whose action we cannot see (two "Save"
    // submit buttons in one form) are never claimed to differ.
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

function checkReadingOrder(nodes: ScreenReaderNode[], push: (finding: ScreenReaderFinding) => void) {
  const childrenByParent = new Map<number, ScreenReaderNode[]>();
  for (const node of nodes) {
    if (node.parent === null || !isLayoutRelevant(node))
      continue;
    const siblings = childrenByParent.get(node.parent);
    if (siblings)
      siblings.push(node);
    else
      childrenByParent.set(node.parent, [node]);
  }

  for (const [parentIndex, siblings] of childrenByParent) {
    if (siblings.length < 2)
      continue;
    const rects = siblings.map(node => node.rect!);
    const rows = countBands(rects, 'y');
    const columns = countBands(rects, 'x');
    // A true 2-D layout (grid, CSS columns, wrapped flex) has no single correct
    // linear visual order, so comparing against DOM order there only cries wolf.
    const horizontal = rows === 1 && columns > 1;
    const vertical = columns === 1 && rows > 1;
    if (!horizontal && !vertical)
      continue;

    // The container's own direction decides the order of its children, but an
    // unmeasured parent has no measured direction (it defaults to ltr), and an
    // iframe element's direction belongs to the embedding page rather than to
    // the document inside it. Fall back to the children's inherited direction.
    const parent = nodes[parentIndex];
    const parentDirection = parent?.rect && parent.tagName !== 'iframe' ? parent.direction : siblings[0].direction;
    const rtl = parentDirection === 'rtl';
    const isInverted = (a: Rect, b: Rect) => horizontal
      ? (rtl ? a.x + a.width <= b.x + layoutTolerancePx : a.x >= b.x + b.width - layoutTolerancePx)
      : a.y >= b.y + b.height - layoutTolerancePx;

    let inversions = 0;
    for (let i = 0; i < siblings.length; i++) {
      for (let j = i + 1; j < siblings.length; j++) {
        if (isInverted(rects[i], rects[j]))
          inversions++;
      }
    }
    if (!inversions)
      continue;

    const sortKey = (rect: Rect) => horizontal ? (rtl ? -(rect.x + rect.width) : rect.x) : rect.y;
    const visualOrder = [...siblings].sort((a, b) => sortKey(a.rect!) - sortKey(b.rect!));
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

/** @public */
export function analyzeScreenReader(
  rawNodes: ScreenReaderNode[],
  options: ScreenReaderAuditOptions
): ScreenReaderAuditResult {
  // Playwright inlines a child frame's tree under the iframe node, but inside
  // that document closest() cannot see the embedding <iframe aria-hidden="true">.
  // Hidden state is inherited down the tree instead; a parent always precedes
  // its children in snapshot order.
  const inheritedHidden = rawNodes.map(node => node.ariaHidden);
  const nodes = restoreDistilledNames(rawNodes.map((node, index) => {
    if (node.parent !== null && inheritedHidden[node.parent])
      inheritedHidden[index] = true;
    return inheritedHidden[index] === node.ariaHidden ? node : { ...node, ariaHidden: true };
  }));

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

  // SAFETY: this locally created table has exactly the ScreenReaderCheck keys listed above.
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
    const reportFileName = params.reportFile ?? `audit-screen-reader-${safeIsoTimestampForFileName()}.json`;
    const reportPath = await tab.context.outputFile(reportFileName, params.reportFile !== undefined);
    if (params.reportFile !== undefined)
      response.deleteFileOnError(reportPath);
    const ariaNodes = parseAriaSnapshot(await tab.page.ariaSnapshot({ mode: 'ai' }));
    const childCounts = new Map<number, number>();
    for (const node of ariaNodes) {
      if (node.parent !== null)
        childCounts.set(node.parent, (childCounts.get(node.parent) ?? 0) + 1);
    }

    const measurement = await measureScreenReaderElements(tab.page, ariaNodes, {
      maxElements: params.maxElements,
      checkNames: params.checkNames,
      reportProgress: progress => response.reportProgress(progress),
    });
    const { factsByIndex, totalElements, analyzedElements, limitations } = measurement;
    const { unresolvedElements: unresolvedCount, unmeasuredNames, truncatedElements, stoppedAtFrameWorkLimit } = limitations;

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

    const nodes: ScreenReaderNode[] = ariaNodes.map((node, index) => ({
      ...node,
      ...(factsByIndex.get(index) ?? emptyFacts),
      ref: factsByIndex.has(index) ? node.ref : null,
      childCount: childCounts.get(index) ?? 0,
    }));

    const result = analyzeScreenReader(nodes, {
      checkNames: params.checkNames,
      checkReadingOrder: params.checkReadingOrder,
      maxFindingsPerCheck: params.maxFindingsPerCheck,
    });

    const elementCountSuffix = stoppedAtFrameWorkLimit !== null
      ? ` (stopped after ${analyzedElements} of ${totalElements}: timed-out frame work reached the ${stoppedAtFrameWorkLimit}-operation limit; re-run once the page is stable)`
      : truncatedElements > 0
        ? ` (truncated: analyzed the first ${analyzedElements} of ${totalElements}; raise maxElements to see the rest)`
        : '';
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
        totalFindings,
        countByCheck: result.countByCheck,
        truncatedChecks: result.truncatedChecks,
      },
      findings: result.findings,
      reportUri: reportResource.uri,
    });

    const findingLines = result.findings.map(finding => (
      `- [${finding.check}] WCAG ${finding.wcag} — ${finding.problem}\n  Fix: ${finding.fix}${finding.ref ? `\n  Ref: ${finding.ref}` : ''}`
    ));
    response.addCode('// Read the accessibility tree with page.ariaSnapshot() and compared names and geometry against reading order.');
    response.addResult([
      `Elements analyzed: ${analyzedElements}${elementCountSuffix}`,
      // Unresolved elements were skipped by every check, so a clean result
      // covering only part of the page must say so rather than read as clean.
      ...(unresolvedCount > 0
        ? [`WARNING: ${unresolvedCount} of these went stale before measurement (the page re-rendered mid-audit, or their frame stopped answering) and were not evaluated; findings may be incomplete. Re-run once the page is stable.`]
        : []),
      // Without a measured name, a control whose name the snapshot distilled
      // into its children is reported as unnamed, so that must be said too.
      ...(unmeasuredNames > 0
        ? [`WARNING: accessible names could not be measured for ${unmeasuredNames} of these (axe-core could not be installed or run in their frame); a control named only through its children may be reported there as missing a name.`]
        : []),
      `Findings: ${totalFindings}`,
      'Check | Findings',
      '--- | ---',
      ...Object.entries(result.countByCheck).map(([check, count]) => `${check} | ${count}`),
      ...(result.truncatedChecks.length
        ? ['', `Showing at most ${params.maxFindingsPerCheck} findings per check; truncated: ${result.truncatedChecks.join(', ')}`]
        : []),
      '',
      ...(findingLines.length ? findingLines : ['- No screen-reader-level issues detected.']),
      '',
      `JSON report: ${reportResource.path}`,
    ].join('\n'));
  },
});

export default [
  auditScreenReader,
];
