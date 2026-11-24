import { z } from 'zod';
import type { JSHandle } from 'playwright';
import { defineTabTool } from './tool.js';
import { fileResource, reserveReportPath, writeJsonReport } from './report.js';
import { safeIsoTimestampForFileName, sanitizeForFilePath } from '../utils/fileUtils.js';

import type { Response } from '../response.js';
import type { Tab } from '../tab.js';

type PressableKey = 'Tab' | 'Shift+Tab' | 'Enter';

type TargetRect = { x: number; y: number; width: number; height: number };

/**
 * SC 2.5.8 spacing outcome measured in the page: `crowded` once a neighbour is found
 * inside the target's spacing circle, `clear` after every candidate was checked, and
 * `inconclusive` when the candidate or element-visit budget ran out first.
 */
type TargetSpacing = 'clear' | 'crowded' | 'inconclusive';

/** @public */
export type FocusPoint = {
  focusIdentity?: string;
  role: string | null;
  name: string | null;
  tagName: string | null;
  id: string | null;
  href: string | null;
  text: string | null;
  boundingBox: TargetRect | null;
  /**
   * Set only for a control that does not take pointer input itself (`pointer-events: none`, hidden) but has
   * descendants that do: the union box of those descendants, which is the area a click activates the control in.
   * Null when the descendants could not be measured within the work limit.
   */
  targetBox?: TargetRect | null;
  inViewport: boolean;
  hasVisibleIndicator: boolean;
  isPointerTarget: boolean;
  inlineTarget: boolean;
  /** The neighbour that decided a `crowded` spacing result, if any. */
  neighborTargets: TargetRect[];
  /** Null when spacing was not measured (not an undersized pointer target, or the check is off). */
  targetSpacing: TargetSpacing | null;
  obstruction: { sampled: number; blocked: number; blockedBy: string | null } | null;
  scrollX: number;
  scrollY: number;
};

type FocusStop = FocusPoint & {
  step: number;
  key: 'Tab' | 'Shift+Tab';
  fingerprint: string;
  scrollDeltaX: number;
  scrollDeltaY: number;
  issues: string[];
};

/** @public */
export type KeyboardAuditOptions = {
  maxTabs: number;
  includeShiftTab: boolean;
  stopOnCycle: boolean;
  cycleWindow: number;
  checkSkipLink: boolean;
  skipLinkMaxTabs: number;
  activateSkipLink: boolean;
  checkFocusTrap: boolean;
  checkFocusVisibility: boolean;
  checkFocusJumps: boolean;
  checkTargetSize: boolean;
  checkFocusObscured: boolean;
  jumpScrollThresholdPx: number;
  screenshotOnIssue: boolean;
  maxIssueScreenshots: number;
};

type KeyboardAuditCallbacks = {
  pressKey: (key: PressableKey) => Promise<void>;
  getActiveElementInfo: () => Promise<FocusPoint>;
  onStep?: (stop: FocusStop) => Promise<void>;
  getCurrentUrl?: () => Promise<string>;
  activateSkipLink?: () => Promise<boolean>;
  restorePage?: (urlBefore: string) => Promise<void>;
  captureScreenshot?: (label: string) => Promise<string>;
};

type SkipLinkActivation = {
  attempted: boolean;
  hashChanged: boolean;
  focusChanged: boolean;
  scrollChanged: boolean;
  navigationOccurred: boolean;
  urlBefore: string | null;
  urlAfter: string | null;
};

type KeyboardAuditResult = {
  stops: FocusStop[];
  uniqueFingerprints: number;
  skipLink: {
    found: boolean;
    step: number | null;
    activated: boolean;
    activation: SkipLinkActivation | null;
  };
  focusVisibilityIssues: FocusStop[];
  focusJumpIssues: FocusStop[];
  targetSizeIssues: FocusStop[];
  targetSizeInconclusive: FocusStop[];
  focusObscuredIssues: FocusStop[];
  focusTrap: {
    detected: boolean;
    step: number | null;
    cycleFingerprint: string | null;
    recentFingerprints: string[];
  };
  screenshots: string[];
};

function buildFingerprint(point: FocusPoint): string {
  if (point.focusIdentity !== undefined)
    return point.focusIdentity;
  return [
    point.role ?? '',
    point.name ?? '',
    point.href ?? '',
    point.tagName ?? '',
    point.id ?? '',
  ].join('|');
}

function isLikelySkipLink(point: FocusPoint): boolean {
  const role = (point.role ?? '').toLowerCase();
  const isLink = role === 'link' || role === 'a' || point.tagName?.toUpperCase() === 'A';
  if (!isLink)
    return false;
  const value = `${point.name ?? ''} ${point.text ?? ''} ${point.id ?? ''}`.toLowerCase();
  if (/\bskip\b/.test(value))
    return true;
  if (!point.href)
    return false;
  try {
    const hash = new URL(point.href).hash.toLowerCase();
    return hash.length > 1 && /(main|content)/.test(hash);
  } catch {
    return false;
  }
}

const MIN_TARGET_SIZE_PX = 24;

// Work limits for the in-page spacing search per focus stop: candidate pointer targets and
// open shadow roots examined, and elements walked to find them (ordinary elements included).
const maxTargetCandidates = 2000;
const maxSpacingVisits = 50_000;
const maxFocusTextLength = 200;

type TargetSizeVerdict = 'pass' | 'fail' | 'inconclusive';

function targetSizeVerdict(point: FocusPoint): TargetSizeVerdict {
  if (!point.isPointerTarget)
    return 'pass';
  if (point.targetBox === null)
    return 'inconclusive';
  const rect = point.targetBox ?? point.boundingBox;
  if (!rect)
    return 'pass';
  if (rect.width >= MIN_TARGET_SIZE_PX && rect.height >= MIN_TARGET_SIZE_PX)
    return 'pass';
  if (point.inlineTarget)
    return 'pass';
  if (point.targetSpacing === 'clear')
    return 'pass';
  if (point.targetSpacing === 'crowded')
    return 'fail';
  return 'inconclusive';
}

function isFocusEntirelyObscured(point: FocusPoint): boolean {
  const obstruction = point.obstruction;
  return obstruction !== null && obstruction.sampled > 0 && obstruction.blocked === obstruction.sampled;
}

function didUrlHashChange(urlBefore: string | null, urlAfter: string | null): boolean {
  if (!urlBefore || !urlAfter)
    return false;
  try {
    return new URL(urlBefore).hash !== new URL(urlAfter).hash;
  } catch {
    return false;
  }
}

type FocusIssue = { name: string, screenshotLabel: string };

function focusIssuesOf(stop: FocusStop, options: KeyboardAuditOptions): FocusIssue[] {
  const issues: FocusIssue[] = [];
  if (options.checkFocusVisibility && !stop.hasVisibleIndicator)
    issues.push({ name: 'no-visible-focus-indicator', screenshotLabel: 'focus-visibility' });
  if (options.checkFocusJumps) {
    const hasLargeJump = Math.abs(stop.scrollDeltaY) > options.jumpScrollThresholdPx;
    const isNotVisible = stop.boundingBox === null || !stop.inViewport;
    if (hasLargeJump || isNotVisible)
      issues.push({ name: 'focus-jump-or-not-visible', screenshotLabel: 'focus-jump' });
  }
  if (options.checkTargetSize && targetSizeVerdict(stop) === 'fail')
    issues.push({ name: 'target-size-below-minimum', screenshotLabel: 'target-size' });
  if (options.checkFocusObscured && isFocusEntirelyObscured(stop))
    issues.push({ name: 'focus-entirely-obscured', screenshotLabel: 'focus-obscured' });
  return issues;
}

function isDocumentRoot(point: FocusPoint): boolean {
  return point.tagName === 'HTML' || point.tagName === 'BODY';
}

function detectFocusTrap(stops: FocusStop[], before: FocusPoint, stop: FocusStop, cycleWindow: number): string[] | undefined {
  const sameDirectionStart = stops.findLastIndex(previous => previous.key !== stop.key) + 1;
  const recentStops = stops.slice(Math.max(sameDirectionStart, stops.length - cycleWindow + 1));
  const foundRepeat = buildFingerprint(before) === stop.fingerprint || recentStops.some(previous => previous.fingerprint === stop.fingerprint);
  const escapedToDocument = recentStops.some(isDocumentRoot) || isDocumentRoot(stop);
  if (!foundRepeat || escapedToDocument)
    return undefined;
  return [...recentStops.map(previous => previous.fingerprint), stop.fingerprint];
}

async function activateSkipLink(stop: FocusStop, callbacks: KeyboardAuditCallbacks): Promise<{ activation: SkipLinkActivation, focusAfter: FocusPoint | null }> {
  const urlBefore = callbacks.getCurrentUrl ? await callbacks.getCurrentUrl() : null;
  let navigationOccurred = false;
  if (callbacks.activateSkipLink)
    navigationOccurred = await callbacks.activateSkipLink();
  else
    await callbacks.pressKey('Enter');
  const after = await callbacks.getActiveElementInfo();
  const urlAfter = callbacks.getCurrentUrl ? await callbacks.getCurrentUrl() : null;
  const activation: SkipLinkActivation = {
    attempted: true,
    hashChanged: didUrlHashChange(urlBefore, urlAfter),
    focusChanged: stop.fingerprint !== buildFingerprint(after),
    scrollChanged: stop.scrollY !== after.scrollY || stop.scrollX !== after.scrollX,
    navigationOccurred,
    urlBefore,
    urlAfter,
  };
  if (navigationOccurred && urlBefore !== null && urlBefore !== urlAfter && callbacks.restorePage) {
    await callbacks.restorePage(urlBefore);
    return { activation, focusAfter: null };
  }
  return { activation, focusAfter: after };
}

/** @public */
export async function runKeyboardFocusAudit(
  options: KeyboardAuditOptions,
  callbacks: KeyboardAuditCallbacks
): Promise<KeyboardAuditResult> {
  const stops: FocusStop[] = [];
  const uniqueFingerprints = new Set<string>();
  const screenshots: string[] = [];
  const skipLink: KeyboardAuditResult['skipLink'] = { found: false, step: null, activated: false, activation: null };
  const focusTrap: KeyboardAuditResult['focusTrap'] = { detected: false, step: null, cycleFingerprint: null, recentFingerprints: [] };
  let lastKnownPoint: FocusPoint | null = null;

  const recordIssue = async (stop: FocusStop, issue: FocusIssue) => {
    stop.issues.push(issue.name);
    if (options.screenshotOnIssue && callbacks.captureScreenshot && screenshots.length < options.maxIssueScreenshots)
      screenshots.push(await callbacks.captureScreenshot(`${issue.screenshotLabel}-${stop.step}`));
  };

  for (let step = 1; step <= options.maxTabs; step++) {
    const key: FocusStop['key'] = options.includeShiftTab && step % 2 === 0 ? 'Shift+Tab' : 'Tab';
    const before = lastKnownPoint ?? await callbacks.getActiveElementInfo();
    await callbacks.pressKey(key);
    const after = await callbacks.getActiveElementInfo();
    lastKnownPoint = after;

    const stop: FocusStop = {
      ...after,
      step,
      key,
      fingerprint: buildFingerprint(after),
      scrollDeltaX: after.scrollX - before.scrollX,
      scrollDeltaY: after.scrollY - before.scrollY,
      issues: [],
    };
    uniqueFingerprints.add(stop.fingerprint);

    for (const issue of focusIssuesOf(stop, options))
      await recordIssue(stop, issue);

    if (options.checkSkipLink && !skipLink.found && step <= options.skipLinkMaxTabs && isLikelySkipLink(stop)) {
      skipLink.found = true;
      skipLink.step = step;
      if (options.activateSkipLink) {
        const { activation, focusAfter } = await activateSkipLink(stop, callbacks);
        skipLink.activation = activation;
        skipLink.activated = true;
        lastKnownPoint = focusAfter;
      }
    }

    const trapCycle = options.checkFocusTrap ? detectFocusTrap(stops, before, stop, options.cycleWindow) : undefined;
    if (trapCycle) {
      focusTrap.detected = true;
      focusTrap.step = step;
      focusTrap.cycleFingerprint = stop.fingerprint;
      focusTrap.recentFingerprints = trapCycle;
      await recordIssue(stop, { name: 'possible-focus-trap', screenshotLabel: 'focus-trap' });
    }

    stops.push(stop);
    await callbacks.onStep?.(stop);
    if (trapCycle && options.stopOnCycle)
      break;
  }

  const stopsWithIssue = (issue: string) => stops.filter(stop => stop.issues.includes(issue));
  return {
    stops,
    uniqueFingerprints: uniqueFingerprints.size,
    skipLink,
    focusVisibilityIssues: stopsWithIssue('no-visible-focus-indicator'),
    focusJumpIssues: stopsWithIssue('focus-jump-or-not-visible'),
    targetSizeIssues: stopsWithIssue('target-size-below-minimum'),
    targetSizeInconclusive: options.checkTargetSize ? stops.filter(stop => targetSizeVerdict(stop) === 'inconclusive') : [],
    focusObscuredIssues: stopsWithIssue('focus-entirely-obscured'),
    focusTrap,
    screenshots,
  };
}

type FocusIdentityState = { identities: WeakMap<Element, number>; nextId: number };

/** @public */
export type CollectFocusPointArgs = {
  checkTargetSize: boolean;
  checkFocusObscured: boolean;
  minTargetSize: number;
  maxTargetCandidates: number;
  maxSpacingVisits: number;
  maxTextLength: number;
  focusState: FocusIdentityState;
  documentId: number;
};

/**
 * Runs inside the page through `page.evaluate`, so it must stay self-contained.
 * @public
 */
export function collectFocusPoint({ checkTargetSize, checkFocusObscured, minTargetSize, maxTargetCandidates, maxSpacingVisits, maxTextLength, focusState, documentId }: CollectFocusPointArgs): FocusPoint {
  const pointerTargetSelector = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex^="-"]), [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"]';
  type Rect = { x: number; y: number; width: number; height: number };

  function deepActiveElement(): Element | null {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement)
      active = active.shadowRoot.activeElement;
    return active;
  }

  function stableIdentityOf(element: Element): number {
    let identity = focusState.identities.get(element);
    if (identity === undefined) {
      identity = focusState.nextId++;
      focusState.identities.set(element, identity);
    }
    return identity;
  }

  function approximateAccessibleName(element: Element, text: string | null): string | null {
    const idRoot = element.getRootNode() as Document | ShadowRoot;
    const labelledBy = (element.getAttribute('aria-labelledby') || '').split(/[ \t\n\f\r]+/)
      .map(id => id && idRoot.getElementById(id)?.textContent?.trim())
      .filter(Boolean)
      .join(' ');
    return element.getAttribute('aria-label')
      || labelledBy
      || element.getAttribute('title')
      || (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.labels?.[0]?.textContent?.trim() : null)
      || text;
  }

  function isInViewport(rect: DOMRect): boolean {
    return rect.width > 0
      && rect.height > 0
      && rect.bottom >= 0
      && rect.right >= 0
      && rect.top <= window.innerHeight
      && rect.left <= window.innerWidth;
  }

  function hasFocusRing(style: CSSStyleDeclaration): boolean {
    const outlineWidth = Number.parseFloat(style.outlineWidth || '0');
    const hasOutline = outlineWidth > 0 && style.outlineStyle !== 'none';
    return hasOutline || style.boxShadow !== 'none';
  }

  // Elements walked per focus stop, shared by the spacing search and the descendant walks of
  // pointerRegion, so one limit bounds all of the work.
  let visited = 0;

  // Hit testing skips hidden (`visibility: hidden` or `collapse`) and `pointer-events: none`
  // boxes. Fully transparent elements still take clicks.
  function takesHits(style: CSSStyleDeclaration): boolean {
    return style.visibility === 'visible' && style.pointerEvents !== 'none';
  }

  function isInert(element: Element): boolean {
    for (let node: Element | null = element; node; node = composedParent(node)) {
      if (node.hasAttribute('inert'))
        return true;
    }
    return false;
  }

  // Children in the flat tree: a host's shadow children, a slot's assigned elements (or its
  // fallback content when nothing is assigned), otherwise the element's children.
  function flatChildren(element: Element): Element[] {
    if (element.shadowRoot)
      return Array.from(element.shadowRoot.children);
    if (element instanceof HTMLSlotElement && element.assignedNodes().length)
      return element.assignedElements();
    return Array.from(element.children);
  }

  // A control that is not hit itself still activates when a descendant that restores
  // `pointer-events` or `visibility` is clicked (the click bubbles to it), and only there.
  // Its target is the union box of those descendants. Every element walked counts against
  // the visit limit; running out returns 'inconclusive'.
  function descendantRegion(element: Element): DOMRect | null | 'inconclusive' {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    const stack = flatChildren(element);
    for (let node = stack.pop(); node; node = stack.pop()) {
      if (++visited > maxSpacingVisits)
        return 'inconclusive';
      if (node.hasAttribute('inert'))
        continue;
      const nodeStyle = window.getComputedStyle(node);
      if (nodeStyle.display === 'none')
        continue;
      const nodeBox = node.getBoundingClientRect();
      if (takesHits(nodeStyle) && nodeBox.width > 0 && nodeBox.height > 0) {
        left = Math.min(left, nodeBox.left);
        top = Math.min(top, nodeBox.top);
        right = Math.max(right, nodeBox.right);
        bottom = Math.max(bottom, nodeBox.bottom);
      }
      for (const child of flatChildren(node))
        stack.push(child);
    }
    return right > left ? new DOMRect(left, top, right - left, bottom - top) : null;
  }

  // SC 2.5.8 targets are regions that accept a pointer action: returns the element's own box,
  // its descendants' region when it is not hit itself, or null for a disabled or inert
  // control, or one nothing inside takes a pointer action on.
  function pointerRegion(element: Element, box: DOMRect): DOMRect | null | 'inconclusive' {
    if (!element.matches(pointerTargetSelector) || element.matches(':disabled') || isInert(element))
      return null;
    if (!takesHits(window.getComputedStyle(element)))
      return descendantRegion(element);
    return box.width > 0 && box.height > 0 ? box : null;
  }

  function sitsInsideSentence(element: Element): boolean {
    for (let scope: Element = element; scope.parentElement; scope = scope.parentElement) {
      const hasSiblingText = Array.from(scope.parentElement.childNodes).some(node => (
        node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim().length > 0
      ));
      if (hasSiblingText)
        return true;
      if (!window.getComputedStyle(scope.parentElement).display.startsWith('inline'))
        return false;
    }
    return false;
  }

  // SC 2.5.8 spacing: a circle of minTargetSize diameter centered on the target must
  // reach neither another target's box nor another undersized target's circle.
  function crowds(center: { x: number; y: number }, neighbor: DOMRect): boolean {
    const nearestX = Math.min(Math.max(center.x, neighbor.left), neighbor.right);
    const nearestY = Math.min(Math.max(center.y, neighbor.top), neighbor.bottom);
    if (Math.hypot(center.x - nearestX, center.y - nearestY) < minTargetSize / 2)
      return true;
    if (neighbor.width >= minTargetSize && neighbor.height >= minTargetSize)
      return false;
    const neighborX = neighbor.left + neighbor.width / 2;
    const neighborY = neighbor.top + neighbor.height / 2;
    return Math.hypot(center.x - neighborX, center.y - neighborY) < minTargetSize;
  }

  // Checks every candidate as it is examined and stops at the first crowding neighbour,
  // so the outcome does not depend on DOM order. Candidates come from the document and
  // every open shadow root inside it, nested ones included, found by one lazy walk per root.
  // Every element walked (descendant walks of pointerRegion included) counts against the
  // visit limit, and every candidate and entered shadow root against the candidate limit.
  // A search cut short by either limit without finding a crowding neighbour is
  // inconclusive, never a pass.
  function measureSpacing(element: Element, rect: DOMRect): { spacing: TargetSpacing; neighbors: Rect[] } {
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const inconclusive = { spacing: 'inconclusive' as const, neighbors: [] };
    let examined = 0;
    const roots: (Document | ShadowRoot)[] = [document];
    for (let root = roots.pop(); root; root = roots.pop()) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const candidate = node as Element;
        if (++visited > maxSpacingVisits)
          return inconclusive;
        if (candidate.shadowRoot) {
          if (++examined > maxTargetCandidates)
            return inconclusive;
          roots.push(candidate.shadowRoot);
        }
        if (candidate === element || !candidate.matches(pointerTargetSelector))
          continue;
        if (++examined > maxTargetCandidates)
          return inconclusive;
        const box = candidate.getBoundingClientRect();
        // A candidate whose own box is clear can only crowd through descendants outside it.
        if (!crowds(center, box) && !candidate.firstElementChild && !candidate.shadowRoot)
          continue;
        const other = pointerRegion(candidate, box);
        if (other === 'inconclusive')
          return inconclusive;
        if (other && crowds(center, other))
          return { spacing: 'crowded', neighbors: [{ x: other.x, y: other.y, width: other.width, height: other.height }] };
      }
    }
    return { spacing: 'clear', neighbors: [] };
  }

  function composedParent(element: Element): Element | null {
    const root = element.getRootNode();
    return element.assignedSlot ?? element.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }

  function composedContains(ancestor: Element, element: Element): boolean {
    for (let node: Element | null = element; node; node = composedParent(node)) {
      if (node === ancestor)
        return true;
    }
    return false;
  }

  function paintsOver(element: Element, focused: Element): boolean {
    let paints = false;
    for (let node: Element | null = element; node && !composedContains(node, focused); node = composedParent(node)) {
      const nodeStyle = window.getComputedStyle(node);
      if (nodeStyle.visibility === 'hidden' || Number.parseFloat(nodeStyle.opacity || '1') === 0)
        return false;
      if (paints)
        continue;
      const alpha = /^rgba\(.*,\s*([\d.]+)\)$/.exec(nodeStyle.backgroundColor);
      paints = nodeStyle.backgroundImage !== 'none'
        || (alpha ? Number.parseFloat(alpha[1]) > 0 : nodeStyle.backgroundColor !== 'transparent');
    }
    return paints;
  }

  function deepElementFromPoint(x: number, y: number): Element | null {
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const nestedHit = hit.shadowRoot.elementFromPoint(x, y);
      if (!nestedHit || nestedHit === hit)
        break;
      hit = nestedHit;
    }
    return hit;
  }

  function describeBlocker(element: Element): string {
    const className = typeof element.className === 'string' ? element.className.trim().split(/\s+/)[0] : '';
    return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${className ? `.${className}` : ''}`;
  }

  function measureObstruction(focused: Element, rect: DOMRect): FocusPoint['obstruction'] {
    const clipLeft = Math.max(rect.left, 0);
    const clipTop = Math.max(rect.top, 0);
    const clipRight = Math.min(rect.right, window.innerWidth - 1);
    const clipBottom = Math.min(rect.bottom, window.innerHeight - 1);
    if (rect.width <= 0 || rect.height <= 0 || clipRight < clipLeft || clipBottom < clipTop)
      return null;
    const clamp = (low: number, high: number, value: number) => Math.min(Math.max(value, low), high);
    const left = clamp(clipLeft, clipRight, clipLeft + 1);
    const right = clamp(clipLeft, clipRight, clipRight - 1);
    const top = clamp(clipTop, clipBottom, clipTop + 1);
    const bottom = clamp(clipTop, clipBottom, clipBottom - 1);
    const samples: [number, number][] = [
      [left, top],
      [right, top],
      [left, bottom],
      [right, bottom],
      [(clipLeft + clipRight) / 2, (clipTop + clipBottom) / 2],
    ];
    const labels = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement || focused instanceof HTMLSelectElement
      ? Array.from(focused.labels ?? [])
      : [];
    let blocked = 0;
    let blockedBy: string | null = null;
    for (const [x, y] of samples) {
      const hit = deepElementFromPoint(x, y);
      if (!hit)
        continue;
      const covers = !composedContains(focused, hit)
        && !composedContains(hit, focused)
        && !labels.some(label => composedContains(label, hit))
        && paintsOver(hit, focused);
      if (!covers)
        continue;
      blocked++;
      blockedBy ??= describeBlocker(hit);
    }
    return { sampled: samples.length, blocked, blockedBy };
  }

  const focused = deepActiveElement();
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  if (!focused) {
    return {
      role: null,
      name: null,
      tagName: null,
      id: null,
      href: null,
      text: null,
      boundingBox: null,
      inViewport: false,
      hasVisibleIndicator: false,
      isPointerTarget: false,
      inlineTarget: false,
      neighborTargets: [],
      targetSpacing: null,
      obstruction: null,
      scrollX,
      scrollY,
    };
  }

  const rect = focused.getBoundingClientRect();
  const style = window.getComputedStyle(focused);
  const text = focused.textContent?.trim().slice(0, maxTextLength) || null;
  const name = approximateAccessibleName(focused, text);
  const region = pointerRegion(focused, rect);
  const pointerTarget = region !== null;
  const measured = region === 'inconclusive' ? null : region;
  let spacing: ReturnType<typeof measureSpacing> | null = null;
  if (checkTargetSize && region === 'inconclusive')
    spacing = { spacing: 'inconclusive', neighbors: [] };
  else if (checkTargetSize && measured && (measured.width < minTargetSize || measured.height < minTargetSize))
    spacing = measureSpacing(focused, measured);
  const point: FocusPoint = {
    focusIdentity: `${documentId}:${stableIdentityOf(focused)}`,
    role: focused.getAttribute('role') || focused.tagName.toLowerCase(),
    name: name ? name.slice(0, maxTextLength) : null,
    tagName: focused.tagName,
    id: focused.id || null,
    href: focused instanceof HTMLAnchorElement ? focused.href : null,
    text,
    boundingBox: rect.width > 0 || rect.height > 0 ? {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    } : null,
    inViewport: isInViewport(rect),
    hasVisibleIndicator: hasFocusRing(style),
    isPointerTarget: pointerTarget,
    inlineTarget: pointerTarget && style.display.startsWith('inline') && sitsInsideSentence(focused),
    neighborTargets: spacing?.neighbors ?? [],
    targetSpacing: spacing?.spacing ?? null,
    obstruction: checkFocusObscured ? measureObstruction(focused, rect) : null,
    scrollX,
    scrollY,
  };
  // Only a region measured from descendants differs from the element's own box.
  if (pointerTarget && region !== rect)
    point.targetBox = measured && { x: measured.x, y: measured.y, width: measured.width, height: measured.height };
  return point;
}

const executionContextGone = /Execution context was destroyed|Cannot find context/;
const documentReplaced = /JSHandles can be evaluated only in the context they were created|Execution context was destroyed/;

function createFocusReader(tab: Tab, options: Pick<KeyboardAuditOptions, 'checkTargetSize' | 'checkFocusObscured'>) {
  let focusState: JSHandle<FocusIdentityState> | undefined;
  let documentId = 0;

  const ensureFocusState = async () => {
    if (!focusState) {
      focusState = await tab.page.evaluateHandle(() => ({ identities: new WeakMap<Element, number>(), nextId: 0 }));
      documentId++;
    }
    return focusState;
  };

  const evaluateFocusPoint = (state: JSHandle<FocusIdentityState>) => tab.page.evaluate(collectFocusPoint, {
    checkTargetSize: options.checkTargetSize,
    checkFocusObscured: options.checkFocusObscured,
    minTargetSize: MIN_TARGET_SIZE_PX,
    maxTargetCandidates,
    maxSpacingVisits,
    maxTextLength: maxFocusTextLength,
    focusState: state,
    documentId,
  });

  return {
    read: async (): Promise<FocusPoint> => {
      const reused = !!focusState;
      const state = await ensureFocusState();
      try {
        return await evaluateFocusPoint(state);
      } catch (error) {
        if (!reused || !(error instanceof Error) || (!executionContextGone.test(error.message) && !documentReplaced.test(error.message)))
          throw error;
        await focusState?.dispose().catch(() => undefined);
        focusState = undefined;
        return await evaluateFocusPoint(await ensureFocusState());
      }
    },
    dispose: async () => {
      await focusState?.dispose();
    },
  };
}

function createSkipLinkNavigation(tab: Tab, pressKey: (key: PressableKey) => Promise<void>) {
  let historyLengthBeforeActivation = 0;
  return {
    activateSkipLink: async (): Promise<boolean> => {
      const documentState = await tab.page.evaluateHandle(() => ({ document, historyLength: history.length }));
      try {
        historyLengthBeforeActivation = await documentState.evaluate(state => state.historyLength);
        await pressKey('Enter');
        try {
          return !await tab.page.evaluate(state => state.document === document, documentState);
        } catch (error) {
          if (error instanceof Error && documentReplaced.test(error.message))
            return true;
          throw error;
        }
      } finally {
        await documentState.dispose();
      }
    },
    restorePage: async (urlBefore: string): Promise<void> => {
      if (await tab.page.evaluate(() => history.length) === historyLengthBeforeActivation + 1)
        await tab.goBack({ waitUntil: 'domcontentloaded' });
      if (tab.page.url() === urlBefore)
        return;
      await tab.waitForCompletion(async () => {
        await tab.page.evaluate(url => window.location.replace(url), urlBefore);
        await tab.page.waitForURL(url => url.href === urlBefore, { waitUntil: 'domcontentloaded' });
      });
    },
  };
}

function previewOf(stops: FocusStop[], describe: (stop: FocusStop) => string): string[] {
  const preview = stops.slice(0, 10).map(describe);
  return preview.length ? preview : ['- None'];
}

function describeElement(stop: FocusStop): string {
  return `${stop.role ?? 'unknown-role'} ${stop.name ?? ''}`;
}

function renderKeyboardSummary(result: KeyboardAuditResult, response: Response, reportPath: string): string {
  const skipLinkResult = result.skipLink.found
    ? `found at step ${result.skipLink.step}${result.skipLink.activated ? ', activated' : ''}`
    : 'not found';
  return [
    `Unique focus stops: ${result.uniqueFingerprints}`,
    `Skip link: ${skipLinkResult}`,
    `No visible focus indicator: ${result.focusVisibilityIssues.length}`,
    ...previewOf(result.focusVisibilityIssues, stop => `- Step ${stop.step} (${stop.key}): ${describeElement(stop)}`.trim()),
    '',
    `Focus trap detected: ${result.focusTrap.detected ? `yes (step ${result.focusTrap.step})` : 'no'}`,
    `Focus jumps: ${result.focusJumpIssues.length}`,
    ...previewOf(result.focusJumpIssues, stop => `- Step ${stop.step}: deltaY=${stop.scrollDeltaY}, inViewport=${stop.inViewport}`),
    '',
    `Target size below 24x24 CSS px (WCAG 2.2 SC 2.5.8, spacing and inline exceptions applied): ${result.targetSizeIssues.length}`,
    ...previewOf(result.targetSizeIssues, stop => `- Step ${stop.step}: ${describeElement(stop)} is ${Math.round((stop.targetBox ?? stop.boundingBox)?.width ?? 0)}x${Math.round((stop.targetBox ?? stop.boundingBox)?.height ?? 0)} CSS px`.replace(/\s+/g, ' ')),
    ...(result.targetSizeInconclusive.length ? [
      `Target size inconclusive (spacing search hit its limit of ${maxTargetCandidates} candidates or ${maxSpacingVisits} elements): ${result.targetSizeInconclusive.length}`,
      ...previewOf(result.targetSizeInconclusive, stop => `- Step ${stop.step}: ${describeElement(stop)}`.replace(/\s+/g, ' ')),
    ] : []),
    '',
    `Focus entirely obscured (WCAG 2.2 SC 2.4.11): ${result.focusObscuredIssues.length}`,
    ...previewOf(result.focusObscuredIssues, stop => `- Step ${stop.step}: ${describeElement(stop)} hidden behind ${stop.obstruction?.blockedBy ?? 'other content'}`.replace(/\s+/g, ' ')),
    ...(result.screenshots.length ? ['', 'Issue screenshots:', ...result.screenshots.map(path => `- ${response.formatFilePath(path)}`)] : []),
    '',
    `JSON report: ${reportPath}`,
  ].join('\n');
}

const auditKeyboardSchema = z.object({
  settleAfterKeyMs: z.number().int().min(0).max(5000).optional().describe('Delay after each audit keypress. Defaults to the server settle timeout. Set to 0 for synchronous focus changes; delayed UI updates can be missed.'),
  maxTabs: z.number().int().min(1).max(200).default(50).describe('Maximum number of Tab keypresses.'),
  includeShiftTab: z.boolean().default(false).describe('Alternate with Shift+Tab during the sequence.'),
  stopOnCycle: z.boolean().default(true).describe('Stop once a focus cycle/trap is detected.'),
  cycleWindow: z.number().int().min(2).max(50).default(10).describe('Recent-window size used for cycle detection.'),
  checkSkipLink: z.boolean().default(true).describe('Check early focus stops for a skip link.'),
  skipLinkMaxTabs: z.number().int().min(1).max(20).default(3).describe('Maximum early steps to look for a skip link.'),
  activateSkipLink: z.boolean().default(false).describe('Press Enter when skip link is found.'),
  checkFocusTrap: z.boolean().default(true).describe('Detect likely focus trap/cycle.'),
  checkFocusVisibility: z.boolean().default(true).describe('Check focus ring visibility heuristic.'),
  checkFocusJumps: z.boolean().default(true).describe('Detect large scroll jumps and invisible focus.'),
  checkTargetSize: z.boolean().default(true).describe('Check target size against WCAG 2.2 SC 2.5.8 (24x24 CSS px, spacing/inline exceptions applied).'),
  checkFocusObscured: z.boolean().default(true).describe('Check that the focused element is not entirely hidden behind other content (WCAG 2.2 SC 2.4.11).'),
  jumpScrollThresholdPx: z.number().int().min(1).default(800).describe('Scroll delta threshold for jump detection.'),
  screenshotOnIssue: z.boolean().default(false).describe('Capture screenshots for detected issues.'),
  maxIssueScreenshots: z.number().int().min(1).max(20).default(3).describe('Maximum screenshots saved when screenshotOnIssue=true.'),
  reportFile: z.string().optional().describe('Output JSON report file name.'),
});

function keyboardAuditSummary(result: KeyboardAuditResult) {
  return {
    uniqueFocusStops: result.uniqueFingerprints,
    skipLinkFound: result.skipLink.found,
    skipLinkStep: result.skipLink.step,
    skipLinkActivated: result.skipLink.activated,
    focusVisibilityIssueCount: result.focusVisibilityIssues.length,
    focusJumpIssueCount: result.focusJumpIssues.length,
    targetSizeIssueCount: result.targetSizeIssues.length,
    targetSizeInconclusiveCount: result.targetSizeInconclusive.length,
    focusObscuredIssueCount: result.focusObscuredIssues.length,
    focusTrapDetected: result.focusTrap.detected,
    focusTrapStep: result.focusTrap.step,
    screenshotCount: result.screenshots.length,
  };
}

const auditKeyboard = defineTabTool({
  capability: 'core',
  schema: {
    name: 'audit_keyboard',
    title: 'Audit keyboard focus flow',
    description: 'Audit keyboard tab order, focus visibility, jumps, skip links, and focus traps.',
    inputSchema: auditKeyboardSchema,
    type: 'destructive',
  },

  handle: async (tab, params, response) => {
    const { reportFile, settleAfterKeyMs, ...auditOptions } = params;
    const reportPath = await reserveReportPath(tab.context, response, reportFile, 'audit-keyboard');
    const focusReader = createFocusReader(tab, auditOptions);
    const pressKey = async (key: PressableKey) => {
      await tab.waitForCompletion(() => tab.page.keyboard.press(key), settleAfterKeyMs);
    };
    const captureScreenshot = async (label: string): Promise<string> => {
      const fileName = await tab.context.outputFile(`${sanitizeForFilePath(label)}-${safeIsoTimestampForFileName()}.png`);
      await tab.page.screenshot({ path: fileName, fullPage: true });
      return fileName;
    };

    let result: KeyboardAuditResult;
    try {
      result = await runKeyboardFocusAudit(auditOptions, {
        pressKey,
        ...createSkipLinkNavigation(tab, pressKey),
        getActiveElementInfo: focusReader.read,
        onStep: async stop => {
          await response.reportProgress({
            progress: stop.step,
            total: params.maxTabs,
            message: `Processed keyboard step ${stop.step}/${params.maxTabs}: ${stop.key}`,
          });
        },
        getCurrentUrl: async () => tab.page.url(),
        captureScreenshot,
      });
    } finally {
      await focusReader.dispose();
    }

    const report = {
      version: 'v1',
      metadata: {
        url: tab.page.url(),
        options: params,
        generatedAt: new Date().toISOString(),
      },
      ...result,
    };

    const reportResource = await writeJsonReport(response, reportPath, report, {
      name: 'audit-keyboard-report',
      title: 'Audit keyboard JSON report',
      description: 'JSON report for keyboard navigation, focus, and skip-link findings.',
    });
    const screenshotResources = result.screenshots.map((screenshotPath, index) => fileResource(response, screenshotPath, {
      name: `audit-keyboard-screenshot-${index + 1}`,
      title: `Audit keyboard issue screenshot ${index + 1}`,
      description: `Screenshot captured for keyboard audit issue ${index + 1}.`,
      mimeType: 'image/png',
    }));
    response.setStructuredContent({
      kind: 'audit_keyboard',
      report: reportResource,
      page: {
        url: tab.page.url(),
      },
      summary: keyboardAuditSummary(result),
      screenshots: screenshotResources,
      reportUri: reportResource.uri,
    });

    response.addCode('// Pressed Tab/Shift+Tab and audited focus behavior heuristics.');
    response.addResult(renderKeyboardSummary(result, response, reportResource.path));
  },
});

export default [
  auditKeyboard,
];
