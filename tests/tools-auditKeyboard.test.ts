import { describe, expect, it, vi } from 'vitest';
import { runKeyboardFocusAudit, type FocusPoint } from '../src/tools/auditKeyboard.js';

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
    scrollX: 0,
    scrollY: 0,
    ...overrides,
  };
}

describe('runKeyboardFocusAudit', () => {
  it('detects skip links, focus cycles, visibility issues, and scroll jumps', async () => {
    const sequence: FocusPoint[] = [
      focusPoint({ role: 'document', tagName: 'BODY' }),
      focusPoint({ role: 'link', name: 'Skip to content', text: 'Skip to content', tagName: 'A', href: '#main' }),
      focusPoint({ role: 'link', name: 'Skip to content', text: 'Skip to content', tagName: 'A', href: '#main' }),
      focusPoint({ role: 'button', name: 'Menu', tagName: 'BUTTON', id: 'menu', hasVisibleIndicator: false }),
      focusPoint({ role: 'button', name: 'Menu', tagName: 'BUTTON', id: 'menu', hasVisibleIndicator: false }),
      focusPoint({ role: 'button', name: 'Search', tagName: 'BUTTON', id: 'search', scrollY: 1200 }),
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
