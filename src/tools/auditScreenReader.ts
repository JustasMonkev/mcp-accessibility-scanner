import fs from 'node:fs';
import { z } from 'zod';
import { defineTabTool } from './tool.js';
import { sanitizeForFilePath } from '../utils/fileUtils.js';

import type * as playwright from 'playwright';

export type Rect = { x: number; y: number; width: number; height: number };

export type AriaTreeNode = {
  role: string;
  name: string | null;
  level: number | null;
  ref: string | null;
  depth: number;
  parent: number | null;
};

export type ElementFacts = {
  tagName: string | null;
  selector: string | null;
  visibleText: string | null;
  href: string | null;
  rect: Rect | null;
  direction: 'ltr' | 'rtl';
  positionFixed: boolean;
  floating: boolean;
  ariaHidden: boolean;
};

export type ScreenReaderNode = AriaTreeNode & ElementFacts & { childCount: number };

export type ScreenReaderCheck =
  | 'missing-accessible-name'
  | 'uninformative-accessible-name'
  | 'filename-as-accessible-name'
  | 'label-in-name-mismatch'
  | 'duplicate-accessible-name'
  | 'reading-order-mismatch';

export type ScreenReaderFinding = {
  check: ScreenReaderCheck;
  wcag: string;
  ref: string | null;
  role: string;
  name: string | null;
  selector: string | null;
  problem: string;
  fix: string;
};

export type ScreenReaderAuditResult = {
  findings: ScreenReaderFinding[];
  countByCheck: Record<ScreenReaderCheck, number>;
  truncatedChecks: ScreenReaderCheck[];
};

export type ScreenReaderAuditOptions = {
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

// Refs are resolved and measured in chunks of this size.
const measureChunkSize = 50;

// Bands narrower than this are noise (sr-only clip boxes, 1px spacers).
const minLayoutSizePx = 2;
const layoutTolerancePx = 1;
const bandOverlapRatio = 0.5;

function normalizeText(value: string | null): string {
  if (!value)
    return '';
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export function parseAriaSnapshot(snapshot: string): AriaTreeNode[] {
  const nodes: AriaTreeNode[] = [];
  const stack: { depth: number; index: number }[] = [];
  for (const rawLine of snapshot.split('\n')) {
    // Playwright YAML-quotes the whole key when the accessible name contains
    // ": ", " #", braces or backticks, doubling any apostrophe inside it. Left
    // quoted, such a node is dropped and its children are mis-parented.
    const quoted = /^(\s*)- '((?:[^']|'')*)'(.*)$/.exec(rawLine);
    const line = quoted ? `${quoted[1]}- ${quoted[2].replace(/''/g, '\'')}${quoted[3]}` : rawLine;
    const match = /^(\s*)- ([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/.exec(line);
    if (!match)
      continue;
    const depth = match[1].length;
    const rest = match[4];
    while (stack.length && stack[stack.length - 1].depth >= depth)
      stack.pop();
    const levelMatch = /\[level=(\d+)\]/.exec(rest);
    nodes.push({
      role: match[2],
      name: match[3] === undefined ? null : match[3].replace(/\\(.)/g, '$1'),
      level: levelMatch ? Number(levelMatch[1]) : null,
      ref: /\[ref=([^\]]+)\]/.exec(rest)?.[1] ?? null,
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
  const rootOf = (index: number): number => band[index] === index ? index : rootOf(band[index]);
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

export function analyzeScreenReader(
  rawNodes: ScreenReaderNode[],
  options: ScreenReaderAuditOptions
): ScreenReaderAuditResult {
  // Playwright inlines a child frame's tree under the iframe node, but inside
  // that document closest() cannot see the embedding <iframe aria-hidden="true">.
  // Hidden state is inherited down the tree instead; a parent always precedes
  // its children in snapshot order.
  const inheritedHidden = rawNodes.map(node => node.ariaHidden);
  const nodes = rawNodes.map((node, index) => {
    if (node.parent !== null && inheritedHidden[node.parent])
      inheritedHidden[index] = true;
    return inheritedHidden[index] === node.ariaHidden ? node : { ...node, ariaHidden: true };
  });

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

// Runs inside the page: no imports, no closures over module scope.
export function collectElementFacts(elements: (SVGElement | HTMLElement)[]): ElementFacts[] {
  // innerText counts visually hidden (clipped) labels as visible, which makes
  // icon-only controls look like text. Walk the subtree instead and skip the
  // usual visually-hidden techniques; the cache keeps nested elements linear.
  const textCache = new Map<Element, string>();
  // Conditions that hide an element AND everything beneath it: display:none,
  // full transparency, the sr-only clip patterns, and collapsed boxes that
  // clip. CSS visibility is deliberately not here — a descendant can restore
  // visibility:visible under a hidden ancestor and still be rendered, so it is
  // evaluated per node in sightedText instead.
  const subtreeHidden = (element: Element) => {
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.opacity === '0')
      return true;
    if (style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clipPath.startsWith('inset(50%'))
      return true;
    // display:contents generates no box of its own, but its text and children
    // render as if lifted into the parent — a 0x0 rect there hides nothing.
    if (style.display === 'contents')
      return false;
    // A collapsed box hides its subtree only when it also clips (the classic
    // sr-only pattern is 1x1 with overflow:hidden). With visible overflow the
    // content renders outside the box.
    const rect = element.getBoundingClientRect();
    return (rect.width <= 1 || rect.height <= 1) && style.overflow !== 'visible';
  };
  const visibilityHidden = (element: Element) => window.getComputedStyle(element).visibility === 'hidden';
  const sightedText = (element: Element): string => {
    const cached = textCache.get(element);
    if (cached !== undefined)
      return cached;
    let text = '';
    // An element's own text nodes render only while its computed visibility is
    // visible; child elements are walked regardless, because unlike the
    // subtreeHidden conditions, visibility can be restored further down.
    const ownTextVisible = !visibilityHidden(element);
    // A web component renders its visible label in its shadow root; walking only
    // light-DOM children makes such a host look like an icon-only control. The
    // shadow tree replaces the host's light children entirely — light nodes
    // render only where a <slot> assigns them, so slots contribute their
    // assigned nodes (or their own fallback content when nothing is assigned)
    // and unassigned light children contribute nothing.
    const children = element.shadowRoot
      ? element.shadowRoot.childNodes
      : element instanceof HTMLSlotElement
        ? element.assignedNodes({ flatten: true })
        : element.childNodes;
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (ownTextVisible)
          text += child.nodeValue ?? '';
      } else if (child.nodeType === Node.ELEMENT_NODE && !subtreeHidden(child as Element)) {
        text += ` ${sightedText(child as Element)}`;
      }
    }
    const value = text.replace(/\s+/g, ' ').trim();
    textCache.set(element, value);
    return value;
  };

  // Button-like inputs render their label from `value` and have no child nodes,
  // so without this they look like icon-only controls to every text check.
  const buttonInputTypes = ['submit', 'button', 'reset'];

  return elements.map(element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    // The visibility predicate must include the element itself, not only its
    // descendants: a control hidden with opacity:0 shows no text at all, and
    // treating its child text as visible raises label-in-name mismatches
    // against a label nobody can see. Button-like inputs render no children,
    // so for them visibility:hidden is as final as the subtree conditions.
    const text = subtreeHidden(element)
      ? ''
      : element instanceof HTMLInputElement && buttonInputTypes.includes(element.type)
        ? (visibilityHidden(element) ? '' : element.value.trim())
        : sightedText(element);
    return {
      tagName: element.tagName.toLowerCase(),
      selector: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${element.classList[0] ? `.${element.classList[0]}` : ''}`,
      visibleText: text ? text.slice(0, 200) : null,
      // The resolved URL, so that "/help" and "https://site/help" are recognised
      // as the same destination rather than reported as ambiguous links.
      href: element instanceof HTMLAnchorElement && element.hasAttribute('href') ? element.href : null,
      rect: {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
      direction: style.direction === 'rtl' ? 'rtl' : 'ltr',
      positionFixed: style.position === 'fixed',
      floating: style.float !== 'none',
      // Playwright's snapshot still lists aria-hidden elements, but a screen
      // reader never reaches them, so nothing about them is a defect. ARIA
      // enumerated tokens are ASCII case-insensitive, so aria-hidden="TRUE"
      // hides exactly like "true" and needs the case-insensitive flag.
      ariaHidden: element.closest('[aria-hidden="true" i]') !== null,
    };
  });
}

const auditScreenReaderSchema = z.object({
  checkNames: z.boolean().default(true).describe('Check accessible name quality (missing, generic, filename, label-in-name, duplicate sibling names).'),
  checkReadingOrder: z.boolean().default(true).describe('Compare accessibility tree order against visual position to find reading-order mismatches.'),
  maxElements: z.number().int().min(1).max(2000).default(400).describe('Maximum accessibility tree elements to analyze; extra elements are reported as truncated.'),
  maxFindingsPerCheck: z.number().int().min(1).max(200).default(20).describe('Maximum findings kept per check; the full count is still reported.'),
  reportFile: z.string().optional().describe('Output JSON report file name.'),
});

function safeIsoTimestampForFileName() {
  return sanitizeForFilePath(new Date().toISOString());
}

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
    const ariaNodes = parseAriaSnapshot(await tab.page.ariaSnapshot({ mode: 'ai' }));
    const refIndexes = ariaNodes.map((node, index) => node.ref ? index : -1).filter(index => index >= 0);
    const childCounts = new Map<number, number>();
    for (const node of ariaNodes) {
      if (node.parent !== null)
        childCounts.set(node.parent, (childCounts.get(node.parent) ?? 0) + 1);
    }

    // Snapshot elements can live in child frames, and a handle can only be
    // evaluated by its own frame, so measure one batch per owning frame.
    type Measured = { index: number; handle: playwright.ElementHandle<SVGElement | HTMLElement> };
    const onlyFrame = tab.page.frames().length === 1 ? tab.page.mainFrame() : null;
    const factsByIndex = new Map<number, ElementFacts>();
    const analyzedIndexes: number[] = [];
    let resolvedCount = 0;
    let reachable = 0;

    // maxElements budgets the elements a screen reader can actually reach: the
    // AI snapshot also refs aria-hidden subtrees, and slicing the raw ref list
    // let those spend the whole budget and leave every visible control below
    // them unmeasured. The ceiling keeps a page made mostly of hidden refs
    // bounded. Refs are resolved a chunk at a time because a ref that went
    // stale costs a full timeout, and one timeout per element serially would
    // stall a large audit for minutes.
    const measureCeiling = Math.min(refIndexes.length, params.maxElements * 2);
    for (let start = 0; start < measureCeiling && reachable < params.maxElements;) {
      // Never take more than the remaining budget, or a maxElements that is not
      // a multiple of the chunk size would analyze a whole extra chunk.
      const size = Math.min(measureChunkSize, params.maxElements - reachable, measureCeiling - start);
      const chunk = refIndexes.slice(start, start + size);
      start += size;
      const handles = await Promise.all(chunk.map(index =>
        tab.page.locator(`aria-ref=${ariaNodes[index].ref}`).elementHandle({ timeout: 1000 }).catch(() => null)));
      const byFrame = new Map<playwright.Frame, Measured[]>();
      for (const [position, handle] of handles.entries()) {
        const frame = handle ? onlyFrame ?? await handle.ownerFrame().catch(() => null) : null;
        if (!handle || !frame)
          continue;
        const batch = byFrame.get(frame);
        if (batch)
          batch.push({ index: chunk[position], handle });
        else
          byFrame.set(frame, [{ index: chunk[position], handle }]);
      }
      for (const [frame, batch] of byFrame) {
        const facts = await frame.evaluate(collectElementFacts, batch.map(entry => entry.handle)).catch(() => null);
        if (facts) {
          batch.forEach((entry, position) => factsByIndex.set(entry.index, facts[position]));
          resolvedCount += batch.length;
          reachable += facts.filter(fact => !fact.ariaHidden).length;
        }
        await Promise.all(batch.map(entry => entry.handle.dispose().catch(() => undefined)));
      }
      analyzedIndexes.push(...chunk);
      await response.reportProgress({
        progress: analyzedIndexes.length,
        total: measureCeiling,
        message: `Measured ${analyzedIndexes.length} accessibility tree elements (${Math.min(reachable, params.maxElements)}/${params.maxElements} screen-reader-reachable)`,
      });
    }

    // A ref goes stale when the page rerenders between ariaSnapshot() and
    // locator resolution. Such elements have no facts, every check skips them,
    // and with nothing resolved at all the audit would otherwise report
    // "Findings: 0" for a page it never actually evaluated.
    const unresolvedCount = analyzedIndexes.length - resolvedCount;
    if (analyzedIndexes.length && !resolvedCount)
      throw new Error(`None of the ${analyzedIndexes.length} accessibility tree elements could be resolved to DOM nodes — the page re-rendered between the snapshot and measurement, so nothing was evaluated. Wait for the page to settle (or trigger the rerender first) and run audit_screen_reader again.`);

    const emptyFacts: ElementFacts = {
      tagName: null,
      selector: null,
      visibleText: null,
      href: null,
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

    const truncatedElements = refIndexes.length - analyzedIndexes.length;
    const elementCountSuffix = truncatedElements > 0
      ? ` (truncated: analyzed the first ${analyzedIndexes.length} of ${refIndexes.length}; raise maxElements to see the rest)`
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
        total: refIndexes.length,
        analyzed: analyzedIndexes.length,
        unresolved: analyzedIndexes.length - resolvedCount,
        truncated: truncatedElements > 0,
      },
      countByCheck: result.countByCheck,
      totalFindings,
      truncatedChecks: result.truncatedChecks,
      findings: result.findings,
    };

    const reportFileName = sanitizeForFilePath(params.reportFile ?? `audit-screen-reader-${safeIsoTimestampForFileName()}.json`);
    const reportPath = await tab.context.outputFile(reportFileName);
    await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    const reportResourceLink = response.addFileResourceLink(reportPath, {
      name: 'audit-screen-reader-report',
      title: 'Audit screen reader JSON report',
      description: 'JSON report for accessible name quality and reading order findings.',
      mimeType: 'application/json',
    });
    response.setStructuredContent({
      kind: 'audit_screen_reader',
      report: {
        path: reportPath,
        uri: reportResourceLink.uri,
        name: reportResourceLink.name,
        title: reportResourceLink.title ?? null,
        mimeType: reportResourceLink.mimeType ?? null,
      },
      page: {
        url: tab.page.url(),
      },
      summary: {
        elementsTotal: refIndexes.length,
        elementsAnalyzed: analyzedIndexes.length,
        elementsUnresolved: unresolvedCount,
        elementsTruncated: truncatedElements,
        totalFindings,
        countByCheck: result.countByCheck,
        truncatedChecks: result.truncatedChecks,
      },
      findings: result.findings,
      reportUri: reportResourceLink.uri,
    });

    const findingLines = result.findings.map(finding => (
      `- [${finding.check}] WCAG ${finding.wcag} — ${finding.problem}\n  Fix: ${finding.fix}${finding.ref ? `\n  Ref: ${finding.ref}` : ''}`
    ));
    response.addCode('// Read the accessibility tree with page.ariaSnapshot() and compared names and geometry against reading order.');
    response.addResult([
      `Elements analyzed: ${analyzedIndexes.length}${elementCountSuffix}`,
      // Unresolved elements were skipped by every check, so a clean result
      // covering only part of the page must say so rather than read as clean.
      ...(unresolvedCount > 0
        ? [`WARNING: ${unresolvedCount} of these went stale before measurement (the page re-rendered mid-audit) and were not evaluated; findings may be incomplete. Re-run once the page is stable.`]
        : []),
      `Findings: ${totalFindings}`,
      'Check | Findings',
      '--- | ---',
      ...(Object.keys(result.countByCheck) as ScreenReaderCheck[]).map(check => `${check} | ${result.countByCheck[check]}`),
      ...(result.truncatedChecks.length
        ? ['', `Showing at most ${params.maxFindingsPerCheck} findings per check; truncated: ${result.truncatedChecks.join(', ')}`]
        : []),
      '',
      ...(findingLines.length ? findingLines : ['- No screen-reader-level issues detected.']),
      '',
      `JSON report: ${reportPath}`,
    ].join('\n'));
  },
});

export default [
  auditScreenReader,
];
