/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { collectFocusPoint, type FocusPoint } from '../src/tools/auditKeyboard.js';

type Box = { left: number; top: number; width: number; height: number };

// Buttons placed in a root; each entry of `shadows` is a host whose open shadow root holds that tree.
type Tree = { focused?: Box; buttons?: Box[]; shadows?: Tree[] };

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
    return measureTree({ focused, buttons: neighbors }, maxTargetCandidates);
  }

  async function measureTree(tree: Tree, maxTargetCandidates = 2000): Promise<FocusPoint> {
    await page.setContent('<body style="margin:0"></body>');
    await page.evaluate(tree => {
      const position = ({ left, top, width, height }: Box) => `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;padding:0;border:0`;
      const build = (root: ParentNode, { focused, buttons = [], shadows = [] }: Tree) => {
        for (const [index, place] of [...(focused ? [focused] : []), ...buttons].entries()) {
          const button = document.createElement('button');
          if (focused && index === 0)
            button.id = 'focused';
          button.style.cssText = position(place);
          root.append(button);
        }
        for (const shadow of shadows) {
          const host = document.createElement('div');
          root.append(host);
          build(host.attachShadow({ mode: 'open' }), shadow);
        }
      };
      build(document.body, tree);
    }, tree);
    // Playwright's CSS engine pierces open shadow roots.
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

  it('finds an adjacent neighbour in the same open shadow root', async () => {
    const point = await measureTree({ shadows: [{ focused: box(0, 0, 16, 16), buttons: [box(16, 0, 16, 16)] }] });
    expect(point.boundingBox).toEqual({ x: 0, y: 0, width: 16, height: 16 });
    expect(point.targetSpacing).toBe('crowded');
    expect(point.neighborTargets).toEqual([{ x: 16, y: 0, width: 16, height: 16 }]);
  });

  it('finds neighbours across nested open shadow roots', async () => {
    const nested = (tree: Tree, depth: number): Tree => depth ? { shadows: [nested(tree, depth - 1)] } : tree;
    // The neighbour sits three shadow roots below the focused target in the document.
    const below = await measureTree({ focused: box(0, 0, 16, 16), shadows: [nested({ buttons: [box(16, 0, 16, 16)] }, 2)] });
    expect(below.targetSpacing).toBe('crowded');
    // The focused target is nested in a sibling component of the neighbour's.
    const across = await measureTree({ shadows: [nested({ focused: box(0, 0, 16, 16) }, 1), nested({ buttons: [box(16, 0, 16, 16)] }, 1)] });
    expect(across.targetSpacing).toBe('crowded');
    // Roomy neighbours in nested shadow roots leave the target clear.
    const roomyNested = await measureTree({ shadows: [nested({ focused: box(0, 0, 16, 16), buttons: [box(48, 0, 16, 16)] }, 2)] });
    expect(roomyNested.targetSpacing).toBe('clear');
  });

  it('counts shadow roots against the candidate limit', async () => {
    const components = Array.from({ length: 20 }, (_, index) => ({ buttons: [box(40 + index, 0, 30, 30)] }));
    const truncated = await measureTree({ focused: box(0, 0, 16, 16), shadows: components }, 10);
    expect(truncated.targetSpacing).toBe('inconclusive');
    // Empty shadow roots still cost work.
    const empty = await measureTree({ focused: box(0, 0, 16, 16), shadows: Array.from({ length: 20 }, () => ({})) }, 10);
    expect(empty.targetSpacing).toBe('inconclusive');
    const within = await measureTree({ focused: box(0, 0, 16, 16), shadows: components }, 40);
    expect(within.targetSpacing).toBe('clear');
  });
});
