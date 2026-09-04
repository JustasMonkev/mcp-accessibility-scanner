import fs from 'node:fs';
import { z } from 'zod';
import { defineTabTool } from './tool.js';
import { safeIsoTimestampForFileName, sanitizeForFilePath } from '../utils/fileUtils.js';

type PressableKey = 'Tab' | 'Shift+Tab' | 'Enter';

type TargetRect = { x: number; y: number; width: number; height: number };

/** @public */
export type FocusPoint = {
  role: string | null;
  name: string | null;
  tagName: string | null;
  id: string | null;
  href: string | null;
  text: string | null;
  boundingBox: TargetRect | null;
  inViewport: boolean;
  hasVisibleIndicator: boolean;
  isPointerTarget: boolean;
  inlineTarget: boolean;
  neighborTargets: TargetRect[];
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
  goBack?: () => Promise<void>;
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

// WCAG 2.2 SC 2.5.8 Target Size (Minimum), in CSS pixels.
const MIN_TARGET_SIZE_PX = 24;

function rectCenter(rect: TargetRect) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function isUndersizedTarget(rect: TargetRect): boolean {
  return rect.width < MIN_TARGET_SIZE_PX || rect.height < MIN_TARGET_SIZE_PX;
}

/**
 * SC 2.5.8 spacing exception: an undersized target passes when a 24px-diameter
 * circle centered on its bounding box intersects neither another target's box nor
 * the equivalent circle of another undersized target.
 */
function meetsSpacingException(rect: TargetRect, neighbors: TargetRect[]): boolean {
  const center = rectCenter(rect);
  const radius = MIN_TARGET_SIZE_PX / 2;
  return neighbors.every(neighbor => {
    // Every neighbor is "another target", so its box is tested first; an
    // undersized one additionally owns a circle, and both must be cleared.
    const nearestX = Math.min(Math.max(center.x, neighbor.x), neighbor.x + neighbor.width);
    const nearestY = Math.min(Math.max(center.y, neighbor.y), neighbor.y + neighbor.height);
    if (Math.hypot(center.x - nearestX, center.y - nearestY) < radius)
      return false;
    if (!isUndersizedTarget(neighbor))
      return true;
    const neighborCenter = rectCenter(neighbor);
    return Math.hypot(center.x - neighborCenter.x, center.y - neighborCenter.y) >= MIN_TARGET_SIZE_PX;
  });
}

function meetsTargetSizeMinimum(point: FocusPoint): boolean {
  const rect = point.boundingBox;
  // Document root / non-interactive focus stops are not pointer targets at all.
  if (!point.isPointerTarget || !rect)
    return true;
  if (!isUndersizedTarget(rect))
    return true;
  // ponytail: only the spacing and inline exceptions are evaluated. The
  // user-agent-control, essential and equivalent-alternative exceptions need
  // author intent that is not observable from the DOM, so undersized targets
  // relying on them are reported and must be triaged by hand. Upgrade path:
  // compare against a default-stylesheet baseline for user-agent control, and
  // accept an allowlist of selectors for essential/equivalent.
  if (point.inlineTarget)
    return true;
  return meetsSpacingException(rect, point.neighborTargets);
}

/**
 * SC 2.4.11 Focus Not Obscured (Minimum) is only violated when the focused
 * component is *entirely* hidden, so a partially covered target passes here.
 */
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


async function maybeCaptureIssueScreenshot(
  options: KeyboardAuditOptions,
  callbacks: KeyboardAuditCallbacks,
  screenshots: string[],
  issueName: string
) {
  if (!options.screenshotOnIssue || !callbacks.captureScreenshot)
    return;
  if (screenshots.length >= options.maxIssueScreenshots)
    return;
  const path = await callbacks.captureScreenshot(issueName);
  screenshots.push(path);
}

/** @public */
export async function runKeyboardFocusAudit(
  options: KeyboardAuditOptions,
  callbacks: KeyboardAuditCallbacks
): Promise<KeyboardAuditResult> {
  const stops: FocusStop[] = [];
  const uniqueFingerprints = new Set<string>();
  const screenshots: string[] = [];
  let skipLinkStep: number | null = null;
  let skipLinkActivation: SkipLinkActivation | null = null;
  let skipLinkActivated = false;
  let focusTrapDetectedAt: number | null = null;
  let focusTrapFingerprint: string | null = null;
  let focusTrapRecentFingerprints: string[] = [];
  // Focus info from the end of the previous step; reused as the "before" state
  // of the next step to avoid a second page round-trip per keypress.
  let lastKnownPoint: FocusPoint | null = null;

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

    if (options.checkFocusVisibility && !stop.hasVisibleIndicator) {
      stop.issues.push('no-visible-focus-indicator');
      await maybeCaptureIssueScreenshot(options, callbacks, screenshots, `focus-visibility-${step}`);
    }

    if (options.checkFocusJumps) {
      const hasLargeJump = Math.abs(stop.scrollDeltaY) > options.jumpScrollThresholdPx;
      const isNotVisible = stop.boundingBox === null || !stop.inViewport;
      if (hasLargeJump || isNotVisible) {
        stop.issues.push('focus-jump-or-not-visible');
        await maybeCaptureIssueScreenshot(options, callbacks, screenshots, `focus-jump-${step}`);
      }
    }

    if (options.checkTargetSize && !meetsTargetSizeMinimum(stop)) {
      stop.issues.push('target-size-below-minimum');
      await maybeCaptureIssueScreenshot(options, callbacks, screenshots, `target-size-${step}`);
    }

    if (options.checkFocusObscured && isFocusEntirelyObscured(stop)) {
      stop.issues.push('focus-entirely-obscured');
      await maybeCaptureIssueScreenshot(options, callbacks, screenshots, `focus-obscured-${step}`);
    }

    if (options.checkSkipLink && step <= options.skipLinkMaxTabs && isLikelySkipLink(stop) && skipLinkStep === null) {
      skipLinkStep = step;
      if (options.activateSkipLink && !skipLinkActivated) {
        const beforeActivation = stop;
        const urlBefore = callbacks.getCurrentUrl ? await callbacks.getCurrentUrl() : null;
        await callbacks.pressKey('Enter');
        const afterActivation = await callbacks.getActiveElementInfo();
        lastKnownPoint = afterActivation;
        const urlAfter = callbacks.getCurrentUrl ? await callbacks.getCurrentUrl() : null;
        const hashChanged = didUrlHashChange(urlBefore, urlAfter);
        const fullUrlChanged = urlBefore !== null && urlAfter !== null && urlBefore !== urlAfter;
        const navigationOccurred = fullUrlChanged && !hashChanged;
        skipLinkActivation = {
          attempted: true,
          hashChanged,
          focusChanged: buildFingerprint(beforeActivation) !== buildFingerprint(afterActivation),
          scrollChanged: beforeActivation.scrollY !== afterActivation.scrollY || beforeActivation.scrollX !== afterActivation.scrollX,
          navigationOccurred,
          urlBefore,
          urlAfter,
        };
        if (navigationOccurred && callbacks.goBack) {
          await callbacks.goBack();
          // Focus state is unknown after navigating back; re-query next step.
          lastKnownPoint = null;
        }
        skipLinkActivated = true;
      }
    }

    let shouldStopOnCycle = false;
    if (options.checkFocusTrap) {
      const recentStops = stops.slice(Math.max(0, stops.length - options.cycleWindow + 1));
      const foundRepeat = recentStops.some(previous => previous.fingerprint === stop.fingerprint);
      const touchedDocumentRoot = recentStops.some(previous => previous.tagName === 'HTML' || previous.tagName === 'BODY') || stop.tagName === 'HTML' || stop.tagName === 'BODY';
      if (foundRepeat && !touchedDocumentRoot) {
        focusTrapDetectedAt = step;
        focusTrapFingerprint = stop.fingerprint;
        focusTrapRecentFingerprints = [...recentStops.map(previous => previous.fingerprint), stop.fingerprint];
        stop.issues.push('possible-focus-trap');
        await maybeCaptureIssueScreenshot(options, callbacks, screenshots, `focus-trap-${step}`);
        if (options.stopOnCycle)
          shouldStopOnCycle = true;
      }
    }

    stops.push(stop);
    await callbacks.onStep?.(stop);
    if (shouldStopOnCycle)
      break;
  }

  return {
    stops,
    uniqueFingerprints: uniqueFingerprints.size,
    skipLink: {
      found: skipLinkStep !== null,
      step: skipLinkStep,
      activated: skipLinkActivated,
      activation: skipLinkActivation,
    },
    focusVisibilityIssues: stops.filter(stop => stop.issues.includes('no-visible-focus-indicator')),
    focusJumpIssues: stops.filter(stop => stop.issues.includes('focus-jump-or-not-visible')),
    targetSizeIssues: stops.filter(stop => stop.issues.includes('target-size-below-minimum')),
    focusObscuredIssues: stops.filter(stop => stop.issues.includes('focus-entirely-obscured')),
    focusTrap: {
      detected: focusTrapDetectedAt !== null,
      step: focusTrapDetectedAt,
      cycleFingerprint: focusTrapFingerprint,
      recentFingerprints: focusTrapRecentFingerprints,
    },
    screenshots,
  };
}

const auditKeyboardSchema = z.object({
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
    const getActiveElementInfo = async (): Promise<FocusPoint> => {
      return await tab.page.evaluate(() => {
        const current = document.activeElement as HTMLElement | null;
        const scrollX = window.scrollX;
        const scrollY = window.scrollY;
        if (!current) {
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
            obstruction: null,
            scrollX,
            scrollY,
          };
        }

        const role = current.getAttribute('role') || current.tagName.toLowerCase();
        const labelledBy = current.getAttribute('aria-labelledby');
        const text = current.textContent?.trim().slice(0, 200) || null;
        const name = current.getAttribute('aria-label')
          || labelledBy && document.getElementById(labelledBy)?.textContent?.trim()
          || current.getAttribute('title')
          || (current instanceof HTMLInputElement || current instanceof HTMLTextAreaElement ? current.labels?.[0]?.textContent?.trim() : null)
          || text;

        const rect = current.getBoundingClientRect();
        const style = window.getComputedStyle(current);
        const outlineWidth = Number.parseFloat(style.outlineWidth || '0');
        const hasOutline = outlineWidth > 0 && style.outlineStyle !== 'none';
        const hasBoxShadow = style.boxShadow !== 'none';
        const inViewport = rect.width > 0
          && rect.height > 0
          && rect.bottom >= 0
          && rect.right >= 0
          && rect.top <= window.innerHeight
          && rect.left <= window.innerWidth;

        // Kept in sync with MIN_TARGET_SIZE_PX; page.evaluate cannot close over it.
        const minTargetSize = 24;
        // ponytail: target size comes from the layout box, so a target whose visible
        // area is cut down by an overflow or clip-path ancestor is under-reported.
        // Intersecting with clipping ancestors was measured against ordinary markup and
        // cost four false positives (carousel slides parked off-track, rows of a plain
        // overflow: auto list) per true positive, and clip-path shapes are not derivable
        // from a rect at all. Upgrade path: clip only against ancestors that cannot be
        // scrolled or animated to reveal the rest of the target.
        const targetSelector = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex^="-"]), [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"]';
        // Shared by the focused element and its spacing neighbors so a disabled or
        // unrendered control is never counted as a pointer target on either side.
        const isPointerTargetElement = (element: Element, box: DOMRect) => box.width > 0
          && box.height > 0
          && element.matches(targetSelector)
          && !element.matches(':disabled');
        const isPointerTarget = isPointerTargetElement(current, rect);

        // "Target is in a sentence": approximated as an inline-level target that sits
        // directly next to running text.
        // ponytail: ceiling is that targets merely constrained by the line-height of
        // nearby non-target text are missed. Upgrade path: compare the target height
        // against the parent's computed line-height.
        // The target may sit inside inline formatting (<strong>, <span>, ...), so walk
        // up through inline-level wrappers to the containing block before concluding
        // there is no running text beside it.
        let hasSentenceText = false;
        for (let scope: Element = current; scope.parentElement && !hasSentenceText; scope = scope.parentElement) {
          hasSentenceText = Array.from(scope.parentElement.childNodes).some(node => (
            node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim().length > 0
          ));
          if (!window.getComputedStyle(scope.parentElement).display.startsWith('inline'))
            break;
        }
        // Any inline-level display (inline, inline-block, inline-flex, ...) can sit in a
        // sentence; SC 2.5.8's exception is about the sentence, not the display keyword.
        const inlineTarget = isPointerTarget && style.display.startsWith('inline') && hasSentenceText;

        const neighborTargets: { x: number; y: number; width: number; height: number }[] = [];
        if (isPointerTarget && (rect.width < minTargetSize || rect.height < minTargetSize)) {
          for (const candidate of document.querySelectorAll<HTMLElement>(targetSelector)) {
            if (candidate === current)
              continue;
            const other = candidate.getBoundingClientRect();
            if (!isPointerTargetElement(candidate, other))
              continue;
            // Only targets close enough for either 24px circle to reach can matter;
            // the margin overshoots deliberately so the spacing test never misses one.
            const outOfRange = other.right < rect.left - 2 * minTargetSize
              || other.left > rect.right + 2 * minTargetSize
              || other.bottom < rect.top - 2 * minTargetSize
              || other.top > rect.bottom + 2 * minTargetSize;
            if (outOfRange)
              continue;
            neighborTargets.push({ x: other.x, y: other.y, width: other.width, height: other.height });
            // ponytail: payload cap. A cluster denser than 32 neighbors within 48px
            // would under-report rather than over-report; raise the cap if that appears.
            if (neighborTargets.length >= 32)
              break;
          }
        }

        let obstruction: { sampled: number; blocked: number; blockedBy: string | null } | null = null;
        const clipLeft = Math.max(rect.left, 0);
        const clipTop = Math.max(rect.top, 0);
        const clipRight = Math.min(rect.right, window.innerWidth - 1);
        const clipBottom = Math.min(rect.bottom, window.innerHeight - 1);
        // SC 2.4.11 applies to anything that receives focus, so this is deliberately not
        // gated on isPointerTarget: contenteditable, iframes and tabindex-only widgets
        // are sampled too.
        if (rect.width > 0 && rect.height > 0 && clipRight >= clipLeft && clipBottom >= clipTop) {
          const inset = (low: number, high: number, value: number) => Math.min(Math.max(value, low), high);
          const samples: [number, number][] = [
            [inset(clipLeft, clipRight, clipLeft + 1), inset(clipTop, clipBottom, clipTop + 1)],
            [inset(clipLeft, clipRight, clipRight - 1), inset(clipTop, clipBottom, clipTop + 1)],
            [inset(clipLeft, clipRight, clipLeft + 1), inset(clipTop, clipBottom, clipBottom - 1)],
            [inset(clipLeft, clipRight, clipRight - 1), inset(clipTop, clipBottom, clipBottom - 1)],
            [(clipLeft + clipRight) / 2, (clipTop + clipBottom) / 2],
          ];
          const labels = current instanceof HTMLInputElement || current instanceof HTMLTextAreaElement || current instanceof HTMLSelectElement
            ? Array.from(current.labels ?? [])
            : [];
          // SC 2.4.11 is about visual coverage, not hit-test order, so a hit only counts
          // when it (or a wrapper of it that is not also around the target) actually
          // paints: visible, non-zero opacity and a non-transparent background.
          // ponytail: the remaining ceiling is that a covering layer with
          // `pointer-events: none` is never returned by hit testing, so it is missed
          // (under-report, never a false alarm). Upgrade path: intersect the focused box
          // against the boxes of positioned/stacking-context layers painted above it.
          const paintsOver = (element: Element) => {
            let paints = false;
            // Painted evidence never short-circuits the walk: an ancestor that renders
            // nothing (opacity: 0, visibility: hidden) hides its painted children too.
            for (let node: Element | null = element; node && !node.contains(current); node = node.parentElement) {
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
          };
          let blocked = 0;
          let blockedBy: string | null = null;
          for (const [x, y] of samples) {
            const hit = document.elementFromPoint(x, y);
            // Descendants paint the target itself; ancestors and associated labels
            // wrap it (the common visually-hidden custom control pattern).
            const covers = hit !== null
              && !current.contains(hit)
              && !hit.contains(current)
              && !labels.some(label => label.contains(hit))
              && paintsOver(hit);
            if (!covers)
              continue;
            blocked++;
            const className = typeof hit.className === 'string' ? hit.className.trim().split(/\s+/)[0] : '';
            blockedBy = blockedBy ?? `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ''}${className ? `.${className}` : ''}`;
          }
          obstruction = { sampled: samples.length, blocked, blockedBy };
        }

        return {
          role,
          name: name ? name.slice(0, 200) : null,
          tagName: current.tagName,
          id: current.id || null,
          href: current instanceof HTMLAnchorElement ? current.href : null,
          text,
          boundingBox: rect.width > 0 || rect.height > 0 ? {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          } : null,
          inViewport,
          hasVisibleIndicator: hasOutline || hasBoxShadow,
          isPointerTarget,
          inlineTarget,
          neighborTargets,
          obstruction,
          scrollX,
          scrollY,
        };
      });
    };

    const captureScreenshot = async (label: string): Promise<string> => {
      const fileName = await tab.context.outputFile(`${sanitizeForFilePath(label)}-${safeIsoTimestampForFileName()}.png`);
      await tab.page.screenshot({ path: fileName, fullPage: true });
      return fileName;
    };

    const { reportFile, ...auditOptions } = params;
    const result = await runKeyboardFocusAudit(auditOptions, {
      pressKey: async key => {
        await tab.waitForCompletion(async () => {
          await tab.page.keyboard.press(key);
        });
      },
      getActiveElementInfo,
      onStep: async stop => {
        await response.reportProgress({
          progress: stop.step,
          total: params.maxTabs,
          message: `Processed keyboard step ${stop.step}/${params.maxTabs}: ${stop.key}`,
        });
      },
      getCurrentUrl: async () => tab.page.url(),
      goBack: async () => {
        await tab.goBack({ waitUntil: 'domcontentloaded' });
      },
      captureScreenshot,
    });

    const report = {
      version: 'v1',
      metadata: {
        url: tab.page.url(),
        options: params,
        generatedAt: new Date().toISOString(),
      },
      ...result,
    };

    const reportFileName = reportFile ?? `audit-keyboard-${safeIsoTimestampForFileName()}.json`;
    const reportPath = await tab.context.outputFile(reportFileName, reportFile !== undefined);
    await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    const reportResourceLink = response.addFileResourceLink(reportPath, {
      name: 'audit-keyboard-report',
      title: 'Audit keyboard JSON report',
      description: 'JSON report for keyboard navigation, focus, and skip-link findings.',
      mimeType: 'application/json',
    });
    const screenshotResources = result.screenshots.map((screenshotPath, index) => {
      const link = response.addFileResourceLink(screenshotPath, {
        name: `audit-keyboard-screenshot-${index + 1}`,
        title: `Audit keyboard issue screenshot ${index + 1}`,
        description: `Screenshot captured for keyboard audit issue ${index + 1}.`,
        mimeType: 'image/png',
      });
      return {
        path: screenshotPath,
        uri: link.uri,
        name: link.name,
        title: link.title ?? null,
        mimeType: link.mimeType ?? null,
      };
    });
    response.setStructuredContent({
      kind: 'audit_keyboard',
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
        uniqueFocusStops: result.uniqueFingerprints,
        skipLinkFound: result.skipLink.found,
        skipLinkStep: result.skipLink.step,
        skipLinkActivated: result.skipLink.activated,
        focusVisibilityIssueCount: result.focusVisibilityIssues.length,
        focusJumpIssueCount: result.focusJumpIssues.length,
        targetSizeIssueCount: result.targetSizeIssues.length,
        focusObscuredIssueCount: result.focusObscuredIssues.length,
        focusTrapDetected: result.focusTrap.detected,
        focusTrapStep: result.focusTrap.step,
        screenshotCount: result.screenshots.length,
      },
      screenshots: screenshotResources,
      reportUri: reportResourceLink.uri,
    });

    const focusVisibilityPreview = result.focusVisibilityIssues.slice(0, 10).map(stop => (
      `- Step ${stop.step} (${stop.key}): ${stop.role ?? 'unknown-role'} ${stop.name ?? ''}`.trim()
    ));
    const focusJumpPreview = result.focusJumpIssues.slice(0, 10).map(stop => (
      `- Step ${stop.step}: deltaY=${stop.scrollDeltaY}, inViewport=${stop.inViewport}`
    ));
    const targetSizePreview = result.targetSizeIssues.slice(0, 10).map(stop => (
      `- Step ${stop.step}: ${stop.role ?? 'unknown-role'} ${stop.name ?? ''} is ${Math.round(stop.boundingBox?.width ?? 0)}x${Math.round(stop.boundingBox?.height ?? 0)} CSS px`.replace(/\s+/g, ' ')
    ));
    const focusObscuredPreview = result.focusObscuredIssues.slice(0, 10).map(stop => (
      `- Step ${stop.step}: ${stop.role ?? 'unknown-role'} ${stop.name ?? ''} hidden behind ${stop.obstruction?.blockedBy ?? 'other content'}`.replace(/\s+/g, ' ')
    ));
    const skipLinkResult = result.skipLink.found
      ? `found at step ${result.skipLink.step}${result.skipLink.activated ? ', activated' : ''}`
      : 'not found';

    response.addCode('// Pressed Tab/Shift+Tab and audited focus behavior heuristics.');
    response.addResult([
      `Unique focus stops: ${result.uniqueFingerprints}`,
      `Skip link: ${skipLinkResult}`,
      `No visible focus indicator: ${result.focusVisibilityIssues.length}`,
      ...(focusVisibilityPreview.length ? focusVisibilityPreview : ['- None']),
      '',
      `Focus trap detected: ${result.focusTrap.detected ? `yes (step ${result.focusTrap.step})` : 'no'}`,
      `Focus jumps: ${result.focusJumpIssues.length}`,
      ...(focusJumpPreview.length ? focusJumpPreview : ['- None']),
      '',
      `Target size below 24x24 CSS px (WCAG 2.2 SC 2.5.8, spacing and inline exceptions applied): ${result.targetSizeIssues.length}`,
      ...(targetSizePreview.length ? targetSizePreview : ['- None']),
      '',
      `Focus entirely obscured (WCAG 2.2 SC 2.4.11): ${result.focusObscuredIssues.length}`,
      ...(focusObscuredPreview.length ? focusObscuredPreview : ['- None']),
      ...(result.screenshots.length ? ['', 'Issue screenshots:', ...result.screenshots.map(path => `- ${path}`)] : []),
      '',
      `JSON report: ${reportPath}`,
    ].join('\n'));
  },
});

export default [
  auditKeyboard,
];
