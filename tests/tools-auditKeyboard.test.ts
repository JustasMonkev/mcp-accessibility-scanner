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
});
