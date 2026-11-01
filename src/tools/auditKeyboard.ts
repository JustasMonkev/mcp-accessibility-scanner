import { z } from 'zod';
import type { JSHandle } from 'playwright';
import { defineTabTool } from './tool.js';
import { writeJsonReport } from './report.js';
import { safeIsoTimestampForFileName, sanitizeForFilePath } from '../utils/fileUtils.js';

type PressableKey = 'Tab' | 'Shift+Tab' | 'Enter';

type TargetRect = { x: number; y: number; width: number; height: number };

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

const maxNeighborTargets = 32;
const maxFocusTextLength = 200;

function rectCenter(rect: TargetRect) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function isUndersizedTarget(rect: TargetRect): boolean {
  return rect.width < MIN_TARGET_SIZE_PX || rect.height < MIN_TARGET_SIZE_PX;
}

function meetsSpacingException(rect: TargetRect, neighbors: TargetRect[]): boolean {
  const center = rectCenter(rect);
  const radius = MIN_TARGET_SIZE_PX / 2;
  return neighbors.every(neighbor => {
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
  if (!point.isPointerTarget || !rect)
    return true;
  if (!isUndersizedTarget(rect))
    return true;
  if (point.inlineTarget)
    return true;
  return meetsSpacingException(rect, point.neighborTargets);
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
        let navigationOccurred = false;
        if (callbacks.activateSkipLink)
          navigationOccurred = await callbacks.activateSkipLink();
        else
          await callbacks.pressKey('Enter');
        const afterActivation = await callbacks.getActiveElementInfo();
        lastKnownPoint = afterActivation;
        const urlAfter = callbacks.getCurrentUrl ? await callbacks.getCurrentUrl() : null;
        const hashChanged = didUrlHashChange(urlBefore, urlAfter);
        skipLinkActivation = {
          attempted: true,
          hashChanged,
          focusChanged: beforeActivation.fingerprint !== buildFingerprint(afterActivation),
          scrollChanged: beforeActivation.scrollY !== afterActivation.scrollY || beforeActivation.scrollX !== afterActivation.scrollX,
          navigationOccurred,
          urlBefore,
          urlAfter,
        };
        if (navigationOccurred && urlBefore !== null && urlBefore !== urlAfter && callbacks.restorePage) {
          await callbacks.restorePage(urlBefore);
          lastKnownPoint = null;
        }
        skipLinkActivated = true;
      }
    }

    let shouldStopOnCycle = false;
    if (options.checkFocusTrap) {
      const directionStart = stops.findLastIndex(previous => previous.key !== key) + 1;
      const recentStops = stops.slice(Math.max(directionStart, stops.length - options.cycleWindow + 1));
      const foundRepeat = buildFingerprint(before) === stop.fingerprint || recentStops.some(previous => previous.fingerprint === stop.fingerprint);
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
    const { reportFile, ...auditOptions } = params;
    const reportFileName = reportFile ?? `audit-keyboard-${safeIsoTimestampForFileName()}.json`;
    const reportPath = await tab.context.outputFile(reportFileName, reportFile !== undefined);
    if (reportFile !== undefined)
      response.deleteFileOnError(reportPath);
    let focusState: JSHandle<{ identities: WeakMap<Element, number>; nextId: number }> | undefined;
    let documentId = 0;
    const getActiveElementInfo = async (): Promise<FocusPoint> => {
      if (focusState) {
        try {
          await focusState.evaluate(() => true);
        } catch (error) {
          if (!(error instanceof Error) || !/Execution context was destroyed|Cannot find context/.test(error.message))
            throw error;
          await focusState.dispose();
          focusState = undefined;
        }
      }
      if (!focusState) {
        focusState = await tab.page.evaluateHandle(() => ({ identities: new WeakMap<Element, number>(), nextId: 0 }));
        documentId++;
      }
      return await tab.page.evaluate(({ checkTargetSize, checkFocusObscured, minTargetSize, maxNeighborTargets, maxTextLength, focusState, documentId }) => {
        let current = document.activeElement;
        while (current?.shadowRoot?.activeElement)
          current = current.shadowRoot.activeElement;
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

        let identity = focusState.identities.get(current);
        if (identity === undefined) {
          identity = focusState.nextId++;
          focusState.identities.set(current, identity);
        }
        const role = current.getAttribute('role') || current.tagName.toLowerCase();
        const idRoot = current.getRootNode() as Document | ShadowRoot;
        const labelledBy = (current.getAttribute('aria-labelledby') || '').split(/[ \t\n\f\r]+/)
          .map(id => id && idRoot.getElementById(id)?.textContent?.trim())
          .filter(Boolean)
          .join(' ');
        const text = current.textContent?.trim().slice(0, maxTextLength) || null;
        const name = current.getAttribute('aria-label')
          || labelledBy
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

        const targetSelector = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex^="-"]), [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"]';
        const isPointerTargetElement = (element: Element, box: DOMRect) => box.width > 0
          && box.height > 0
          && element.matches(targetSelector)
          && !element.matches(':disabled');
        const isPointerTarget = isPointerTargetElement(current, rect);

        let hasSentenceText = false;
        for (let scope: Element = current; scope.parentElement && !hasSentenceText; scope = scope.parentElement) {
          hasSentenceText = Array.from(scope.parentElement.childNodes).some(node => (
            node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim().length > 0
          ));
          if (!window.getComputedStyle(scope.parentElement).display.startsWith('inline'))
            break;
        }
        const inlineTarget = isPointerTarget && style.display.startsWith('inline') && hasSentenceText;

        const neighborTargets: { x: number; y: number; width: number; height: number }[] = [];
        if (checkTargetSize && isPointerTarget && (rect.width < minTargetSize || rect.height < minTargetSize)) {
          for (const candidate of document.querySelectorAll<HTMLElement>(targetSelector)) {
            if (candidate === current)
              continue;
            const other = candidate.getBoundingClientRect();
            if (!isPointerTargetElement(candidate, other))
              continue;
            const outOfRange = other.right < rect.left - 2 * minTargetSize
              || other.left > rect.right + 2 * minTargetSize
              || other.bottom < rect.top - 2 * minTargetSize
              || other.top > rect.bottom + 2 * minTargetSize;
            if (outOfRange)
              continue;
            neighborTargets.push({ x: other.x, y: other.y, width: other.width, height: other.height });
            if (neighborTargets.length >= maxNeighborTargets)
              break;
          }
        }

        let obstruction: { sampled: number; blocked: number; blockedBy: string | null } | null = null;
        const clipLeft = Math.max(rect.left, 0);
        const clipTop = Math.max(rect.top, 0);
        const clipRight = Math.min(rect.right, window.innerWidth - 1);
        const clipBottom = Math.min(rect.bottom, window.innerHeight - 1);
        if (checkFocusObscured && rect.width > 0 && rect.height > 0 && clipRight >= clipLeft && clipBottom >= clipTop) {
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
          const composedParent = (element: Element): Element | null => {
            const root = element.getRootNode();
            return element.assignedSlot ?? element.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
          };
          const composedContains = (ancestor: Element, element: Element) => {
            for (let node: Element | null = element; node; node = composedParent(node)) {
              if (node === ancestor)
                return true;
            }
            return false;
          };
          const paintsOver = (element: Element) => {
            let paints = false;
            for (let node: Element | null = element; node && !composedContains(node, current); node = composedParent(node)) {
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
            let hit = document.elementFromPoint(x, y);
            while (hit?.shadowRoot) {
              const nestedHit = hit.shadowRoot.elementFromPoint(x, y);
              if (!nestedHit || nestedHit === hit)
                break;
              hit = nestedHit;
            }
            if (!hit)
              continue;
            const covers = !composedContains(current, hit)
              && !composedContains(hit, current)
              && !labels.some(label => composedContains(label, hit))
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
          focusIdentity: `${documentId}:${identity}`,
          role,
          name: name ? name.slice(0, maxTextLength) : null,
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
      }, {
        checkTargetSize: auditOptions.checkTargetSize,
        checkFocusObscured: auditOptions.checkFocusObscured,
        minTargetSize: MIN_TARGET_SIZE_PX,
        maxNeighborTargets,
        maxTextLength: maxFocusTextLength,
        focusState,
        documentId,
      });
    };

    const captureScreenshot = async (label: string): Promise<string> => {
      const fileName = await tab.context.outputFile(`${sanitizeForFilePath(label)}-${safeIsoTimestampForFileName()}.png`);
      await tab.page.screenshot({ path: fileName, fullPage: true });
      return fileName;
    };

    const pressKey = async (key: PressableKey) => {
      await tab.waitForCompletion(async () => {
        await tab.page.keyboard.press(key);
      });
    };

    let historyLengthBeforeActivation = 0;
    const result = await runKeyboardFocusAudit(auditOptions, {
      pressKey,
      activateSkipLink: async () => {
        const documentState = await tab.page.evaluateHandle(() => ({ document, historyLength: history.length }));
        try {
          historyLengthBeforeActivation = await documentState.evaluate(state => state.historyLength);
          await pressKey('Enter');
          try {
            return !await tab.page.evaluate(state => state.document === document, documentState);
          } catch (error) {
            if (error instanceof Error && /JSHandles can be evaluated only in the context they were created|Execution context was destroyed/.test(error.message))
              return true;
            throw error;
          }
        } finally {
          await documentState.dispose();
        }
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
      restorePage: async urlBefore => {
        if (await tab.page.evaluate(() => history.length) === historyLengthBeforeActivation + 1)
          await tab.goBack({ waitUntil: 'domcontentloaded' });
        if (tab.page.url() !== urlBefore) {
          await tab.waitForCompletion(async () => {
            await tab.page.evaluate(url => window.location.replace(url), urlBefore);
            await tab.page.waitForURL(url => url.href === urlBefore, { waitUntil: 'domcontentloaded' });
          });
        }
      },
      captureScreenshot,
    }).finally(async () => { await focusState?.dispose(); });

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
    const screenshotResources = result.screenshots.map((screenshotPath, index) => {
      const link = response.addFileResourceLink(screenshotPath, {
        name: `audit-keyboard-screenshot-${index + 1}`,
        title: `Audit keyboard issue screenshot ${index + 1}`,
        description: `Screenshot captured for keyboard audit issue ${index + 1}.`,
        mimeType: 'image/png',
      });
      return {
        path: response.formatFilePath(screenshotPath),
        uri: link.uri,
        name: link.name,
        title: link.title ?? null,
        mimeType: link.mimeType ?? null,
      };
    });
    response.setStructuredContent({
      kind: 'audit_keyboard',
      report: reportResource,
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
      reportUri: reportResource.uri,
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
      ...(result.screenshots.length ? ['', 'Issue screenshots:', ...result.screenshots.map(path => `- ${response.formatFilePath(path)}`)] : []),
      '',
      `JSON report: ${reportResource.path}`,
    ].join('\n'));
  },
});

export default [
  auditKeyboard,
];
