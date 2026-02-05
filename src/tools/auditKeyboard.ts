import fs from 'fs';
import { z } from 'zod';
import { defineTabTool } from './tool.js';

type PressableKey = 'Tab' | 'Shift+Tab' | 'Enter';

export type FocusPoint = {
  role: string | null;
  name: string | null;
  tagName: string | null;
  id: string | null;
  href: string | null;
  text: string | null;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  inViewport: boolean;
  hasVisibleIndicator: boolean;
  scrollX: number;
  scrollY: number;
};

export type FocusStop = FocusPoint & {
  step: number;
  key: 'Tab' | 'Shift+Tab';
  fingerprint: string;
  scrollDeltaX: number;
  scrollDeltaY: number;
  issues: string[];
};

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
  jumpScrollThresholdPx: number;
  screenshotOnIssue: boolean;
  maxIssueScreenshots: number;
};

type KeyboardAuditCallbacks = {
  pressKey: (key: PressableKey) => Promise<void>;
  getActiveElementInfo: () => Promise<FocusPoint>;
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

export type KeyboardAuditResult = {
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
  if (point.role !== 'link')
    return false;
  const value = `${point.name ?? ''} ${point.text ?? ''}`.toLowerCase();
  return /\bskip\b/.test(value);
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

  for (let step = 1; step <= options.maxTabs; step++) {
    const key: FocusStop['key'] = options.includeShiftTab && step % 2 === 0 ? 'Shift+Tab' : 'Tab';
    const before = await callbacks.getActiveElementInfo();
    await callbacks.pressKey(key);
    const after = await callbacks.getActiveElementInfo();

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

    if (options.checkSkipLink && step <= options.skipLinkMaxTabs && isLikelySkipLink(stop) && skipLinkStep === null) {
      skipLinkStep = step;
      if (options.activateSkipLink && !skipLinkActivated) {
        const beforeActivation = stop;
        const urlBefore = callbacks.getCurrentUrl ? await callbacks.getCurrentUrl() : null;
        await callbacks.pressKey('Enter');
        const afterActivation = await callbacks.getActiveElementInfo();
        const urlAfter = callbacks.getCurrentUrl ? await callbacks.getCurrentUrl() : null;
        const navigationOccurred = urlBefore !== null && urlAfter !== null && urlBefore !== urlAfter;
        skipLinkActivation = {
          attempted: true,
          hashChanged: (urlBefore && urlAfter) ? new URL(urlBefore).hash !== new URL(urlAfter).hash : false,
          focusChanged: buildFingerprint(beforeActivation) !== buildFingerprint(afterActivation),
          scrollChanged: beforeActivation.scrollY !== afterActivation.scrollY || beforeActivation.scrollX !== afterActivation.scrollX,
          navigationOccurred,
          urlBefore,
          urlAfter,
        };
        if (navigationOccurred && callbacks.goBack)
          await callbacks.goBack();
        skipLinkActivated = true;
      }
    }

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
        stops.push(stop);
        if (options.stopOnCycle)
          break;
      }
    }

    stops.push(stop);
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
      const activeHandle = await tab.page.evaluateHandle(() => document.activeElement);
      try {
        const [accessibilityNode, elementInfo] = await Promise.all([
          (tab.page as any).accessibility.snapshot({ root: activeHandle as any, interestingOnly: false }),
          tab.page.evaluate(element => {
            const current = element as HTMLElement | null;
            const scrollX = window.scrollX;
            const scrollY = window.scrollY;
            if (!current) {
              return {
                tagName: null,
                id: null,
                href: null,
                text: null,
                boundingBox: null,
                inViewport: false,
                hasVisibleIndicator: false,
                scrollX,
                scrollY,
              };
            }

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

            return {
              tagName: current.tagName,
              id: current.id || null,
              href: current instanceof HTMLAnchorElement ? current.href : null,
              text: current.textContent?.trim().slice(0, 200) || null,
              boundingBox: rect.width > 0 || rect.height > 0 ? {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              } : null,
              inViewport,
              hasVisibleIndicator: hasOutline || hasBoxShadow,
              scrollX,
              scrollY,
            };
          }, activeHandle),
        ]);

        return {
          role: accessibilityNode?.role ?? null,
          name: accessibilityNode?.name ?? null,
          tagName: elementInfo.tagName,
          id: elementInfo.id,
          href: elementInfo.href,
          text: elementInfo.text,
          boundingBox: elementInfo.boundingBox,
          inViewport: elementInfo.inViewport,
          hasVisibleIndicator: elementInfo.hasVisibleIndicator,
          scrollX: elementInfo.scrollX,
          scrollY: elementInfo.scrollY,
        };
      } finally {
        await activeHandle.dispose();
      }
    };

    const captureScreenshot = async (label: string): Promise<string> => {
      const fileName = await tab.context.outputFile(`${label}-${new Date().toISOString()}.png`);
      await tab.page.screenshot({ path: fileName, fullPage: true });
      return fileName;
    };

    const result = await runKeyboardFocusAudit({
      maxTabs: params.maxTabs,
      includeShiftTab: params.includeShiftTab,
      stopOnCycle: params.stopOnCycle,
      cycleWindow: params.cycleWindow,
      checkSkipLink: params.checkSkipLink,
      skipLinkMaxTabs: params.skipLinkMaxTabs,
      activateSkipLink: params.activateSkipLink,
      checkFocusTrap: params.checkFocusTrap,
      checkFocusVisibility: params.checkFocusVisibility,
      checkFocusJumps: params.checkFocusJumps,
      jumpScrollThresholdPx: params.jumpScrollThresholdPx,
      screenshotOnIssue: params.screenshotOnIssue,
      maxIssueScreenshots: params.maxIssueScreenshots,
    }, {
      pressKey: async key => {
        await tab.waitForCompletion(async () => {
          await tab.page.keyboard.press(key);
        });
      },
      getActiveElementInfo,
      getCurrentUrl: async () => tab.page.url(),
      goBack: async () => {
        await tab.page.goBack({ waitUntil: 'domcontentloaded' });
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

    const reportFileName = params.reportFile ?? `audit-keyboard-${new Date().toISOString()}.json`;
    const reportPath = await tab.context.outputFile(reportFileName);
    await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');

    const focusVisibilityPreview = result.focusVisibilityIssues.slice(0, 10).map(stop => (
      `- Step ${stop.step} (${stop.key}): ${stop.role ?? 'unknown-role'} ${stop.name ?? ''}`.trim()
    ));
    const focusJumpPreview = result.focusJumpIssues.slice(0, 10).map(stop => (
      `- Step ${stop.step}: deltaY=${stop.scrollDeltaY}, inViewport=${stop.inViewport}`
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
      ...(result.screenshots.length ? ['', 'Issue screenshots:', ...result.screenshots.map(path => `- ${path}`)] : []),
      '',
      `JSON report: ${reportPath}`,
    ].join('\n'));
  },
});

export default [
  auditKeyboard,
];
