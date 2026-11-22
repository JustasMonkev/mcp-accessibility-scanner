/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { collectFocusPoint, type FocusPoint } from '../src/tools/auditKeyboard.js';

type Box = { left: number; top: number; width: number; height: number };

const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height });

const roomy = Array.from({ length: 40 }, (_, index) => box(40 + index % 4, 0, 30, 30));

// Replays the production in-page measurement against fixed geometry: every control is an
// absolutely positioned button, and `#focused` is the stop being measured.
describe('audit_keyboard SC 2.5.8 spacing measurement', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser?.close();
  });

  async function measure(focused: Box, neighbors: Box[], maxTargetCandidates = 2000): Promise<FocusPoint> {
    const position = ({ left, top, width, height }: Box) => `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;padding:0;border:0`;
    await page.setContent(`<body style="margin:0">
      <button id="focused" style="${position(focused)}"></button>
      ${neighbors.map(neighbor => `<button style="${position(neighbor)}"></button>`).join('')}
    </body>`);
    await page.focus('#focused');
    const focusState = await page.evaluateHandle(() => ({ identities: new WeakMap<Element, number>(), nextId: 0 }));
    try {
      return await page.evaluate(collectFocusPoint, {
        checkTargetSize: true,
        checkFocusObscured: false,
        minTargetSize: 24,
        maxTargetCandidates,
        maxTextLength: 200,
        focusState,
        documentId: 1,
      });
    } finally {
      await focusState.dispose();
    }
  }

  it.each([
    { name: 'isolated', neighbors: [], spacing: 'clear' },
    { name: 'undersized neighbour with overlapping circles', neighbors: [box(20, 0, 16, 16)], spacing: 'crowded' },
    { name: 'undersized neighbour 48px away', neighbors: [box(48, 0, 16, 16)], spacing: 'clear' },
    { name: 'large neighbour box inside the circle', neighbors: [box(12, 0, 80, 40)], spacing: 'crowded' },
    { name: 'undersized strip box inside the circle', neighbors: [box(12, 0, 100, 10)], spacing: 'crowded' },
    { name: 'undersized strip clear of the circle', neighbors: [box(30, 0, 100, 10)], spacing: 'clear' },
  ])('measures $name as $spacing', async ({ neighbors, spacing }) => {
    const point = await measure(box(0, 0, 16, 16), neighbors);
    expect(point.targetSpacing).toBe(spacing);
    expect(point.neighborTargets).toHaveLength(spacing === 'crowded' ? 1 : 0);
  });

  it('keeps the asymmetric strip relation: the long strip itself is clear', async () => {
    const point = await measure(box(12, 0, 100, 10), [box(0, 0, 10, 10)]);
    expect(point.targetSpacing).toBe('clear');
  });

  it('does not measure spacing for a target that meets the minimum size', async () => {
    const point = await measure(box(0, 0, 24, 24), [box(24, 0, 24, 24)]);
    expect(point.targetSpacing).toBeNull();
  });

  it('finds the crowding neighbour regardless of its DOM position', async () => {
    const crowding = box(20, 0, 16, 16);
    const first = await measure(box(0, 0, 16, 16), [crowding, ...roomy]);
    const last = await measure(box(0, 0, 16, 16), [...roomy, crowding]);
    expect(first.targetSpacing).toBe('crowded');
    expect(last.targetSpacing).toBe('crowded');
    expect(last.neighborTargets).toEqual(first.neighborTargets);
  });

  it('reports a search cut short by the candidate limit as inconclusive', async () => {
    const truncated = await measure(box(0, 0, 16, 16), roomy, 10);
    expect(truncated.targetSpacing).toBe('inconclusive');
    expect(truncated.neighborTargets).toEqual([]);

    // A crowding neighbour found within the limit is still decisive.
    const decided = await measure(box(0, 0, 16, 16), [box(20, 0, 16, 16), ...roomy], 10);
    expect(decided.targetSpacing).toBe('crowded');
  });
});
