import { describe, expect, it, vi } from 'vitest';
import { runKeyboardFocusAudit, type FocusPoint, type KeyboardAuditOptions } from '../src/tools/auditKeyboard.js';

function focusPoint(overrides: Partial<FocusPoint>): FocusPoint {
  return {
    role: null,
    name: null,
    tagName: 'DIV',
    id: null,
    href: null,
    text: null,
    boundingBox: { x: 0, y: 0, width: 50, height: 20 },
    inViewport: true,
    hasVisibleIndicator: true,
    isPointerTarget: false,
    inlineTarget: false,
    neighborTargets: [],
    obstruction: null,
    scrollX: 0,
    scrollY: 0,
    ...overrides,
  };
}

const baseOptions: KeyboardAuditOptions = {
  maxTabs: 1,
  includeShiftTab: false,
  stopOnCycle: false,
  cycleWindow: 4,
  checkSkipLink: false,
  skipLinkMaxTabs: 3,
  activateSkipLink: false,
  checkFocusTrap: false,
  checkFocusVisibility: false,
  checkFocusJumps: false,
  checkTargetSize: true,
  checkFocusObscured: true,
  jumpScrollThresholdPx: 800,
  screenshotOnIssue: false,
  maxIssueScreenshots: 3,
};

function auditSingleStop(point: FocusPoint, options: Partial<KeyboardAuditOptions> = {}) {
  const sequence = [focusPoint({ tagName: 'BODY' }), point];
  let index = 0;
  return runKeyboardFocusAudit({ ...baseOptions, ...options }, {
    pressKey: vi.fn(async () => undefined),
    getActiveElementInfo: vi.fn(async () => sequence[index++]),
  });
}

describe('runKeyboardFocusAudit', () => {
  it('detects skip links, focus cycles, visibility issues, and scroll jumps', async () => {
    const sequence: FocusPoint[] = [
      focusPoint({ role: 'document', tagName: 'BODY' }),
      focusPoint({ role: 'link', name: 'Skip to content', text: 'Skip to content', tagName: 'A', href: '#main' }),
      focusPoint({ role: 'button', name: 'Menu', tagName: 'BUTTON', id: 'menu', hasVisibleIndicator: false }),
      focusPoint({ role: 'button', name: 'Search', tagName: 'BUTTON', id: 'search', scrollY: 1200 }),
      focusPoint({ role: 'button', name: 'Menu', tagName: 'BUTTON', id: 'menu', hasVisibleIndicator: false, scrollY: 1200 }),
    ];

    let index = 0;
    const result = await runKeyboardFocusAudit({
      maxTabs: 10,
      includeShiftTab: false,
      stopOnCycle: true,
      cycleWindow: 4,
      checkSkipLink: true,
      skipLinkMaxTabs: 3,
      activateSkipLink: false,
      checkFocusTrap: true,
      checkFocusVisibility: true,
      checkFocusJumps: true,
      checkTargetSize: false,
      checkFocusObscured: false,
      jumpScrollThresholdPx: 800,
      screenshotOnIssue: false,
      maxIssueScreenshots: 3,
    }, {
      pressKey: vi.fn(async () => undefined),
      getActiveElementInfo: vi.fn(async () => {
        const point = sequence[index];
        index++;
        return point;
      }),
    });

    expect(result.skipLink.found).toBe(true);
    expect(result.skipLink.step).toBe(1);
    expect(result.focusTrap.detected).toBe(true);
    expect(result.focusTrap.step).toBe(4);
    expect(result.focusVisibilityIssues.length).toBeGreaterThan(0);
    expect(result.focusJumpIssues.some(stop => stop.step === 3)).toBe(true);
  });

  it('serializes detected findings into JSON-safe report shape', async () => {
    const sequence: FocusPoint[] = [
      focusPoint({ role: 'document', tagName: 'BODY' }),
      focusPoint({ role: 'link', name: 'Skip to main', text: 'Skip to main', tagName: 'A', href: '#main' }),
    ];

    let index = 0;
    const result = await runKeyboardFocusAudit({
      maxTabs: 1,
      includeShiftTab: false,
      stopOnCycle: true,
      cycleWindow: 3,
      checkSkipLink: true,
      skipLinkMaxTabs: 3,
      activateSkipLink: false,
      checkFocusTrap: true,
      checkFocusVisibility: true,
      checkFocusJumps: true,
      checkTargetSize: false,
      checkFocusObscured: false,
      jumpScrollThresholdPx: 800,
      screenshotOnIssue: false,
      maxIssueScreenshots: 3,
    }, {
      pressKey: vi.fn(async () => undefined),
      getActiveElementInfo: vi.fn(async () => {
        const point = sequence[index];
        index++;
        return point;
      }),
    });

    const report = {
      version: 'v1',
      metadata: { generatedAt: new Date().toISOString() },
      ...result,
    };

    const parsed = JSON.parse(JSON.stringify(report));
    expect(parsed.version).toBe('v1');
    expect(parsed.skipLink.found).toBe(true);
    expect(Array.isArray(parsed.stops)).toBe(true);
  });

  it('records a focus trap stop only once when stopOnCycle is false', async () => {
    const sequence: FocusPoint[] = [
      focusPoint({ role: 'document', tagName: 'BODY' }),
      focusPoint({ role: 'button', name: 'Menu', tagName: 'BUTTON', id: 'menu' }),
      focusPoint({ role: 'button', name: 'Menu', tagName: 'BUTTON', id: 'menu' }),
    ];

    let index = 0;
    const result = await runKeyboardFocusAudit({
      maxTabs: 2,
      includeShiftTab: false,
      stopOnCycle: false,
      cycleWindow: 4,
      checkSkipLink: false,
      skipLinkMaxTabs: 3,
      activateSkipLink: false,
      checkFocusTrap: true,
      checkFocusVisibility: false,
      checkFocusJumps: false,
      checkTargetSize: false,
      checkFocusObscured: false,
      jumpScrollThresholdPx: 800,
      screenshotOnIssue: false,
      maxIssueScreenshots: 3,
    }, {
      pressKey: vi.fn(async () => undefined),
      getActiveElementInfo: vi.fn(async () => {
        const point = sequence[index];
        index++;
        return point;
      }),
    });

    expect(result.stops).toHaveLength(2);
    const focusTrapStops = result.stops.filter(stop => stop.issues.includes('possible-focus-trap'));
    expect(focusTrapStops).toHaveLength(1);
    expect(focusTrapStops[0]?.step).toBe(2);
  });

  it('does not throw when skip-link URL values are not parseable URLs', async () => {
    const sequence: FocusPoint[] = [
      focusPoint({ role: 'document', tagName: 'BODY' }),
      focusPoint({ role: 'link', name: 'Skip to content', text: 'Skip to content', tagName: 'A', href: '#main' }),
      focusPoint({ role: 'main', tagName: 'MAIN' }),
    ];

    let index = 0;
    const getCurrentUrl = vi.fn()
        .mockResolvedValueOnce('not-a-url')
        .mockResolvedValueOnce('still-not-a-url');

    const result = await runKeyboardFocusAudit({
      maxTabs: 1,
      includeShiftTab: false,
      stopOnCycle: true,
      cycleWindow: 4,
      checkSkipLink: true,
      skipLinkMaxTabs: 3,
      activateSkipLink: true,
      checkFocusTrap: false,
      checkFocusVisibility: false,
      checkFocusJumps: false,
      checkTargetSize: false,
      checkFocusObscured: false,
      jumpScrollThresholdPx: 800,
      screenshotOnIssue: false,
      maxIssueScreenshots: 3,
    }, {
      pressKey: vi.fn(async () => undefined),
      getActiveElementInfo: vi.fn(async () => {
        const point = sequence[index];
        index++;
        return point;
      }),
      getCurrentUrl,
    });

    expect(result.skipLink.activation?.attempted).toBe(true);
    expect(result.skipLink.activation?.hashChanged).toBe(false);
  });

  it('detects skip links for anchors with implicit role metadata', async () => {
    const sequence: FocusPoint[] = [
      focusPoint({ role: 'document', tagName: 'BODY' }),
      focusPoint({ role: 'a', name: 'Skip to main content', text: 'Skip to main content', tagName: 'A', href: 'https://example.com/#main-content' }),
    ];

    let index = 0;
    const result = await runKeyboardFocusAudit({
      maxTabs: 1,
      includeShiftTab: false,
      stopOnCycle: true,
      cycleWindow: 4,
      checkSkipLink: true,
      skipLinkMaxTabs: 3,
      activateSkipLink: false,
      checkFocusTrap: false,
      checkFocusVisibility: false,
      checkFocusJumps: false,
      checkTargetSize: false,
      checkFocusObscured: false,
      jumpScrollThresholdPx: 800,
      screenshotOnIssue: false,
      maxIssueScreenshots: 3,
    }, {
      pressKey: vi.fn(async () => undefined),
      getActiveElementInfo: vi.fn(async () => {
        const point = sequence[index];
        index++;
        return point;
      }),
    });

    expect(result.skipLink.found).toBe(true);
    expect(result.skipLink.step).toBe(1);
  });

  it('alternates Tab and Shift+Tab when includeShiftTab is enabled', async () => {
    const sequence: FocusPoint[] = [
      focusPoint({ role: 'document', tagName: 'BODY' }),
      focusPoint({ role: 'button', name: 'One', tagName: 'BUTTON', id: 'one' }),
      focusPoint({ role: 'button', name: 'Two', tagName: 'BUTTON', id: 'two' }),
      focusPoint({ role: 'button', name: 'Three', tagName: 'BUTTON', id: 'three' }),
      focusPoint({ role: 'button', name: 'Four', tagName: 'BUTTON', id: 'four' }),
      focusPoint({ role: 'button', name: 'Five', tagName: 'BUTTON', id: 'five' }),
      focusPoint({ role: 'button', name: 'Six', tagName: 'BUTTON', id: 'six' }),
      focusPoint({ role: 'button', name: 'Seven', tagName: 'BUTTON', id: 'seven' }),
    ];

    let index = 0;
    const pressKey = vi.fn(async () => undefined);
    await runKeyboardFocusAudit({
      maxTabs: 4,
      includeShiftTab: true,
      stopOnCycle: false,
      cycleWindow: 4,
      checkSkipLink: false,
      skipLinkMaxTabs: 3,
      activateSkipLink: false,
      checkFocusTrap: false,
      checkFocusVisibility: false,
      checkFocusJumps: false,
      checkTargetSize: false,
      checkFocusObscured: false,
      jumpScrollThresholdPx: 800,
      screenshotOnIssue: false,
      maxIssueScreenshots: 3,
    }, {
      pressKey,
      getActiveElementInfo: vi.fn(async () => {
        const point = sequence[index];
        index++;
        return point;
      }),
    });

    expect(pressKey.mock.calls.map(call => call[0])).toEqual(['Tab', 'Shift+Tab', 'Tab', 'Shift+Tab']);
  });

  it('activates skip link and does not goBack for hash-only URL changes', async () => {
    const sequence: FocusPoint[] = [
      focusPoint({ role: 'document', tagName: 'BODY' }),
      focusPoint({ role: 'link', name: 'Skip to content', text: 'Skip to content', tagName: 'A', href: 'https://example.com/#main' }),
      focusPoint({ role: 'main', name: 'Main content', tagName: 'MAIN', id: 'main', scrollY: 500 }),
    ];

    let index = 0;
    const goBack = vi.fn(async () => undefined);
    const getCurrentUrl = vi.fn()
        .mockResolvedValueOnce('https://example.com/')
        .mockResolvedValueOnce('https://example.com/#main');

    const result = await runKeyboardFocusAudit({
      maxTabs: 1,
      includeShiftTab: false,
      stopOnCycle: true,
      cycleWindow: 4,
      checkSkipLink: true,
      skipLinkMaxTabs: 3,
      activateSkipLink: true,
      checkFocusTrap: false,
      checkFocusVisibility: false,
      checkFocusJumps: false,
      checkTargetSize: false,
      checkFocusObscured: false,
      jumpScrollThresholdPx: 800,
      screenshotOnIssue: false,
      maxIssueScreenshots: 3,
    }, {
      pressKey: vi.fn(async () => undefined),
      getActiveElementInfo: vi.fn(async () => {
        const point = sequence[index];
        index++;
        return point;
      }),
      getCurrentUrl,
      goBack,
    });

    expect(result.skipLink.activation?.attempted).toBe(true);
    expect(result.skipLink.activation?.hashChanged).toBe(true);
    expect(result.skipLink.activation?.navigationOccurred).toBe(false);
    expect(goBack).not.toHaveBeenCalled();
  });

  it('navigates back when skip-link activation triggers full-page navigation', async () => {
    const sequence: FocusPoint[] = [
      focusPoint({ role: 'document', tagName: 'BODY' }),
      focusPoint({ role: 'link', name: 'Skip to content', text: 'Skip to content', tagName: 'A', href: 'https://example.com/target' }),
      focusPoint({ role: 'heading', name: 'Destination', tagName: 'H1' }),
    ];

    let index = 0;
    const goBack = vi.fn(async () => undefined);
    const getCurrentUrl = vi.fn()
        .mockResolvedValueOnce('https://example.com/start')
        .mockResolvedValueOnce('https://example.com/target');

    const result = await runKeyboardFocusAudit({
      maxTabs: 1,
      includeShiftTab: false,
      stopOnCycle: true,
      cycleWindow: 4,
      checkSkipLink: true,
      skipLinkMaxTabs: 3,
      activateSkipLink: true,
      checkFocusTrap: false,
      checkFocusVisibility: false,
      checkFocusJumps: false,
      checkTargetSize: false,
      checkFocusObscured: false,
      jumpScrollThresholdPx: 800,
      screenshotOnIssue: false,
      maxIssueScreenshots: 3,
    }, {
      pressKey: vi.fn(async () => undefined),
      getActiveElementInfo: vi.fn(async () => {
        const point = sequence[index];
        index++;
        return point;
      }),
      getCurrentUrl,
      goBack,
    });

    expect(result.skipLink.activation?.navigationOccurred).toBe(true);
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  it('captures screenshots for issues up to maxIssueScreenshots', async () => {
    const sequence: FocusPoint[] = [
      focusPoint({ role: 'document', tagName: 'BODY' }),
      focusPoint({ role: 'button', name: 'First', tagName: 'BUTTON', id: 'one', hasVisibleIndicator: false, inViewport: false, boundingBox: null }),
      focusPoint({ role: 'button', name: 'Second', tagName: 'BUTTON', id: 'two', hasVisibleIndicator: false, inViewport: false, boundingBox: null }),
      focusPoint({ role: 'button', name: 'Third', tagName: 'BUTTON', id: 'three', hasVisibleIndicator: false, inViewport: false, boundingBox: null }),
      focusPoint({ role: 'button', name: 'Fourth', tagName: 'BUTTON', id: 'four', hasVisibleIndicator: false, inViewport: false, boundingBox: null }),
      focusPoint({ role: 'button', name: 'First', tagName: 'BUTTON', id: 'one', hasVisibleIndicator: false, inViewport: false, boundingBox: null }),
    ];

    let index = 0;
    const captureScreenshot = vi.fn(async (label: string) => `/tmp/${label}.png`);
    const result = await runKeyboardFocusAudit({
      maxTabs: 3,
      includeShiftTab: false,
      stopOnCycle: true,
      cycleWindow: 3,
      checkSkipLink: false,
      skipLinkMaxTabs: 3,
      activateSkipLink: false,
      checkFocusTrap: true,
      checkFocusVisibility: true,
      checkFocusJumps: true,
      checkTargetSize: false,
      checkFocusObscured: false,
      jumpScrollThresholdPx: 10,
      screenshotOnIssue: true,
      maxIssueScreenshots: 2,
    }, {
      pressKey: vi.fn(async () => undefined),
      getActiveElementInfo: vi.fn(async () => {
        const point = sequence[index];
        index++;
        return point;
      }),
      captureScreenshot,
    });

    expect(captureScreenshot).toHaveBeenCalledTimes(2);
    expect(result.screenshots).toHaveLength(2);
  });

  it('supports long runs up to maxTabs without hanging', async () => {
    const sequence: FocusPoint[] = Array.from({ length: 220 }, (_, index) => {
      return focusPoint({
        role: 'button',
        name: `Button ${index}`,
        tagName: 'BUTTON',
        id: `btn-${index}`,
      });
    });

    let index = 0;
    const result = await runKeyboardFocusAudit({
      maxTabs: 100,
      includeShiftTab: false,
      stopOnCycle: false,
      cycleWindow: 10,
      checkSkipLink: false,
      skipLinkMaxTabs: 3,
      activateSkipLink: false,
      checkFocusTrap: false,
      checkFocusVisibility: false,
      checkFocusJumps: false,
      checkTargetSize: false,
      checkFocusObscured: false,
      jumpScrollThresholdPx: 800,
      screenshotOnIssue: false,
      maxIssueScreenshots: 3,
    }, {
      pressKey: vi.fn(async () => undefined),
      getActiveElementInfo: vi.fn(async () => {
        const point = sequence[index];
        index++;
        return point;
      }),
    });

    expect(result.stops).toHaveLength(100);
  });

  it('treats 24x24 as compliant and 23x23 as compliant only while it stays isolated', async () => {
    const boundary = await auditSingleStop(focusPoint({
      role: 'button', tagName: 'BUTTON', name: 'Exactly', isPointerTarget: true,
      boundingBox: { x: 0, y: 0, width: 24, height: 24 },
      neighborTargets: [{ x: 24, y: 0, width: 24, height: 24 }],
    }));
    expect(boundary.targetSizeIssues).toHaveLength(0);

    // An isolated undersized target still satisfies the spacing exception.
    const isolated = await auditSingleStop(focusPoint({
      role: 'link', tagName: 'A', name: 'Tiny', isPointerTarget: true,
      boundingBox: { x: 0, y: 0, width: 23, height: 23 },
    }));
    expect(isolated.targetSizeIssues).toHaveLength(0);

    // Two 16px targets 4px apart: centers are 20px apart, so the circles overlap.
    const crowded = await auditSingleStop(focusPoint({
      role: 'link', tagName: 'A', name: 'Tiny', isPointerTarget: true,
      boundingBox: { x: 0, y: 0, width: 16, height: 16 },
      neighborTargets: [{ x: 20, y: 0, width: 16, height: 16 }],
    }));
    expect(crowded.targetSizeIssues.map(stop => stop.step)).toEqual([1]);
    expect(crowded.stops[0]?.issues).toContain('target-size-below-minimum');
  });

  it('passes an undersized target that satisfies the SC 2.5.8 spacing exception', async () => {
    const result = await auditSingleStop(focusPoint({
      role: 'button', tagName: 'BUTTON', name: 'Spaced', isPointerTarget: true,
      boundingBox: { x: 100, y: 100, width: 16, height: 16 },
      // Neighbor center is 48px away, so the two 24px-diameter circles never meet.
      neighborTargets: [{ x: 148, y: 100, width: 16, height: 16 }],
    }));
    expect(result.targetSizeIssues).toHaveLength(0);
  });

  it('flags an undersized target whose spacing circle intersects a neighbor', async () => {
    const crowdedCircles = await auditSingleStop(focusPoint({
      role: 'button', tagName: 'BUTTON', name: 'Crowded', isPointerTarget: true,
      boundingBox: { x: 100, y: 100, width: 16, height: 16 },
      neighborTargets: [{ x: 120, y: 100, width: 16, height: 16 }],
    }));
    expect(crowdedCircles.targetSizeIssues).toHaveLength(1);

    const nextToLargeTarget = await auditSingleStop(focusPoint({
      role: 'button', tagName: 'BUTTON', name: 'Adjacent', isPointerTarget: true,
      boundingBox: { x: 100, y: 100, width: 16, height: 16 },
      neighborTargets: [{ x: 112, y: 100, width: 80, height: 40 }],
    }));
    expect(nextToLargeTarget.targetSizeIssues).toHaveLength(1);
  });

  it('tests an undersized neighbour by its box as well as by its circle', async () => {
    // A 100x10 strip is undersized, so it owns a circle, but it is also "another
    // target": its box starts 2px away even though its center is 57px away.
    const stripInsideCircle = await auditSingleStop(focusPoint({
      role: 'link', tagName: 'A', name: 'Short target', isPointerTarget: true,
      boundingBox: { x: 0, y: 0, width: 10, height: 10 },
      neighborTargets: [{ x: 12, y: 0, width: 100, height: 10 }],
    }));
    expect(stripInsideCircle.targetSizeIssues).toHaveLength(1);

    // Same strip moved clear of the circle passes both tests.
    const stripClear = await auditSingleStop(focusPoint({
      role: 'link', tagName: 'A', name: 'Short clear', isPointerTarget: true,
      boundingBox: { x: 0, y: 0, width: 10, height: 10 },
      neighborTargets: [{ x: 30, y: 0, width: 100, height: 10 }],
    }));
    expect(stripClear.targetSizeIssues).toHaveLength(0);

    // The relation is asymmetric: from the strip's side the short target's box is
    // 45px away, so the strip itself stays compliant.
    const fromTheStrip = await auditSingleStop(focusPoint({
      role: 'link', tagName: 'A', name: 'Long strip', isPointerTarget: true,
      boundingBox: { x: 12, y: 0, width: 100, height: 10 },
      neighborTargets: [{ x: 0, y: 0, width: 10, height: 10 }],
    }));
    expect(fromTheStrip.targetSizeIssues).toHaveLength(0);
  });

  it('does not apply target size to inline targets or non-target focus stops', async () => {
    const inline = await auditSingleStop(focusPoint({
      role: 'link', tagName: 'A', name: 'terms', isPointerTarget: true, inlineTarget: true,
      boundingBox: { x: 0, y: 0, width: 40, height: 18 },
      neighborTargets: [{ x: 44, y: 0, width: 40, height: 18 }],
    }));
    expect(inline.targetSizeIssues).toHaveLength(0);

    const documentRoot = await auditSingleStop(focusPoint({
      role: 'document', tagName: 'BODY',
      boundingBox: { x: 0, y: 0, width: 10, height: 10 },
    }));
    expect(documentRoot.targetSizeIssues).toHaveLength(0);

    const checkOff = await auditSingleStop(focusPoint({
      role: 'button', tagName: 'BUTTON', isPointerTarget: true,
      boundingBox: { x: 0, y: 0, width: 10, height: 10 },
    }), { checkTargetSize: false });
    expect(checkOff.targetSizeIssues).toHaveLength(0);
  });

  it('flags a fully obscured focus target but not a partially obscured one', async () => {
    const hidden = await auditSingleStop(focusPoint({
      role: 'link', tagName: 'A', name: 'Behind footer', isPointerTarget: true,
      obstruction: { sampled: 5, blocked: 5, blockedBy: 'div#sticky-footer' },
    }));
    expect(hidden.focusObscuredIssues.map(stop => stop.step)).toEqual([1]);
    expect(hidden.stops[0]?.issues).toContain('focus-entirely-obscured');

    const partial = await auditSingleStop(focusPoint({
      role: 'link', tagName: 'A', name: 'Half covered', isPointerTarget: true,
      obstruction: { sampled: 5, blocked: 4, blockedBy: 'div#sticky-footer' },
    }));
    expect(partial.focusObscuredIssues).toHaveLength(0);
  });

  it('applies SC 2.4.11 to focusable stops that are not pointer targets', async () => {
    // A contenteditable or iframe is measured too; the measurement layer no longer
    // gates obstruction sampling on isPointerTarget.
    const editable = await auditSingleStop(focusPoint({
      role: 'div', tagName: 'DIV', name: 'Editable region', isPointerTarget: false,
      obstruction: { sampled: 5, blocked: 5, blockedBy: 'div#panel' },
    }));
    expect(editable.focusObscuredIssues.map(stop => stop.step)).toEqual([1]);
    expect(editable.targetSizeIssues).toHaveLength(0);

    // A transparent click-catcher paints nothing, so measurement reports it unblocked.
    const behindGlass = await auditSingleStop(focusPoint({
      role: 'button', tagName: 'BUTTON', name: 'Covered control', isPointerTarget: true,
      obstruction: { sampled: 5, blocked: 0, blockedBy: null },
    }));
    expect(behindGlass.focusObscuredIssues).toHaveLength(0);
  });

  it('keeps the inline exception and ignores disabled neighbours for SC 2.5.8', async () => {
    // An inline-block link inside a sentence is inline-level, so it stays exempt even
    // with a crowding neighbour.
    const inlineBlock = await auditSingleStop(focusPoint({
      role: 'link', tagName: 'A', name: 'Inline block terms', isPointerTarget: true, inlineTarget: true,
      boundingBox: { x: 0, y: 340, width: 12, height: 18 },
      neighborTargets: [{ x: 16, y: 340, width: 12, height: 18 }],
    }));
    expect(inlineBlock.targetSizeIssues).toHaveLength(0);

    // The same geometry without the sentence context is still a real failure.
    const standalone = await auditSingleStop(focusPoint({
      role: 'link', tagName: 'A', name: 'Standalone', isPointerTarget: true,
      boundingBox: { x: 0, y: 340, width: 12, height: 18 },
      neighborTargets: [{ x: 16, y: 340, width: 12, height: 18 }],
    }));
    expect(standalone.targetSizeIssues).toHaveLength(1);

    // A disabled control is filtered out during measurement, so it never reaches
    // neighborTargets and the isolated target passes.
    const nextToDisabled = await auditSingleStop(focusPoint({
      role: 'link', tagName: 'A', name: 'Isolated link', isPointerTarget: true,
      boundingBox: { x: 0, y: 400, width: 18, height: 18 },
      neighborTargets: [],
    }));
    expect(nextToDisabled.targetSizeIssues).toHaveLength(0);
  });

  it('does not flag obscured focus when nothing was measured or the check is off', async () => {
    const unmeasured = await auditSingleStop(focusPoint({ role: 'button', tagName: 'BUTTON', isPointerTarget: true }));
    expect(unmeasured.focusObscuredIssues).toHaveLength(0);

    const off = await auditSingleStop(focusPoint({
      role: 'button', tagName: 'BUTTON', isPointerTarget: true,
      obstruction: { sampled: 5, blocked: 5, blockedBy: 'div' },
    }), { checkFocusObscured: false });
    expect(off.focusObscuredIssues).toHaveLength(0);
  });

  it('handles iframe-like focus transitions without crashing', async () => {
    const sequence: FocusPoint[] = [
      focusPoint({ role: 'document', tagName: 'BODY' }),
      focusPoint({ role: 'iframe', tagName: 'IFRAME', name: 'Embedded form' }),
      focusPoint({ role: 'textbox', tagName: 'INPUT', name: 'Inside iframe input' }),
      focusPoint({ role: 'button', tagName: 'BUTTON', name: 'Next' }),
      focusPoint({ role: 'button', tagName: 'BUTTON', name: 'Submit' }),
      focusPoint({ role: 'button', tagName: 'BUTTON', name: 'Confirm' }),
    ];

    let index = 0;
    const result = await runKeyboardFocusAudit({
      maxTabs: 3,
      includeShiftTab: false,
      stopOnCycle: false,
      cycleWindow: 10,
      checkSkipLink: false,
      skipLinkMaxTabs: 3,
      activateSkipLink: false,
      checkFocusTrap: true,
      checkFocusVisibility: true,
      checkFocusJumps: true,
      checkTargetSize: false,
      checkFocusObscured: false,
      jumpScrollThresholdPx: 800,
      screenshotOnIssue: false,
      maxIssueScreenshots: 3,
    }, {
      pressKey: vi.fn(async () => undefined),
      getActiveElementInfo: vi.fn(async () => {
        const point = sequence[index];
        index++;
        return point;
      }),
    });

    expect(result.stops).toHaveLength(3);
  });
});
