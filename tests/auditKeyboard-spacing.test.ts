/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { collectFocusPoint, type FocusPoint } from '../src/tools/auditKeyboard.js';

// `html` is the button's inner markup.
type Box = { left: number; top: number; width: number; height: number; css?: string; inert?: boolean; html?: string };

// Buttons placed in a root; each entry of `shadows` is a host whose open shadow root holds that tree.
// `host` styles the shadow host itself, and `spans` adds that many ordinary elements before the buttons.
type Tree = { focused?: Box; buttons?: Box[]; shadows?: Tree[]; host?: { css?: string; inert?: boolean }; spans?: number };

const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height });
const styled = (place: Box, css: string): Box => ({ ...place, css });

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

  async function measureTree(tree: Tree, maxTargetCandidates = 2000, maxSpacingVisits = 50_000, beforeMeasure?: () => Promise<unknown>): Promise<FocusPoint> {
    await page.setContent('<body style="margin:0"></body>');
    await page.evaluate(tree => {
      const position = ({ left, top, width, height, css = '' }: Box) => `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;padding:0;border:0;${css}`;
      const build = (root: ParentNode, { focused, buttons = [], shadows = [], spans = 0 }: Tree) => {
        for (let index = 0; index < spans; index++)
          root.append(document.createElement('span'));
        for (const [index, place] of [...(focused ? [focused] : []), ...buttons].entries()) {
          const button = document.createElement('button');
          if (focused && index === 0)
            button.id = 'focused';
          button.style.cssText = position(place);
          button.inert = !!place.inert;
          button.innerHTML = place.html ?? '';
          root.append(button);
        }
        for (const shadow of shadows) {
          const host = document.createElement('div');
          host.style.cssText = shadow.host?.css ?? '';
          host.inert = !!shadow.host?.inert;
          root.append(host);
          build(host.attachShadow({ mode: 'open' }), shadow);
        }
      };
      build(document.body, tree);
    }, tree);
    // Playwright's CSS engine pierces open shadow roots.
    await page.focus('#focused');
    await beforeMeasure?.();
    const focusState = await page.evaluateHandle(() => ({ identities: new WeakMap<Element, number>(), nextId: 0 }));
    try {
      return await page.evaluate(collectFocusPoint, {
        checkTargetSize: true,
        checkFocusObscured: false,
        minTargetSize: 24,
        maxTargetCandidates,
        maxSpacingVisits,
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

  it('ignores neighbours that cannot take a pointer action', async () => {
    const focused = box(0, 0, 16, 16);
    const neighbor = box(16, 0, 16, 16);
    // A visible neighbour in the same place is the positive control for every case below.
    expect((await measure(focused, [neighbor])).targetSpacing).toBe('crowded');
    expect((await measureTree({ focused, shadows: [{ buttons: [neighbor] }] })).targetSpacing).toBe('crowded');
    // An invisible but clickable neighbour still takes pointer actions.
    expect((await measure(focused, [styled(neighbor, 'opacity:0')])).targetSpacing).toBe('crowded');

    for (const css of ['visibility:hidden', 'visibility:collapse', 'pointer-events:none']) {
      expect((await measure(focused, [styled(neighbor, css)])).targetSpacing, css).toBe('clear');
      expect((await measureTree({ focused, shadows: [{ buttons: [styled(neighbor, css)] }] })).targetSpacing, `shadow ${css}`).toBe('clear');
      // Inherited from the shadow host.
      expect((await measureTree({ focused, shadows: [{ host: { css }, buttons: [neighbor] }] })).targetSpacing, `host ${css}`).toBe('clear');
    }
    expect((await measure(focused, [{ ...neighbor, inert: true }])).targetSpacing).toBe('clear');
    expect((await measureTree({ focused, shadows: [{ host: { inert: true }, buttons: [neighbor] }] })).targetSpacing).toBe('clear');
    // A hidden neighbour does not hide a visible one behind it.
    expect((await measure(focused, [styled(neighbor, 'visibility:hidden'), neighbor])).targetSpacing).toBe('crowded');
    // The focused element follows the same rule: a keyboard-only control is not a pointer target.
    const keyboardOnly = await measure(styled(focused, 'pointer-events:none'), [neighbor]);
    expect(keyboardOnly.isPointerTarget).toBe(false);
    expect(keyboardOnly.targetSpacing).toBeNull();
  });

  describe('controls with pointer-events: none and a descendant that restores it', () => {
    // In Chromium a click on the restored descendant bubbles to and activates the control,
    // while a click on the rest of the control's box falls through to what is beneath it.
    const clickable = (css: string) => `<span style="position:absolute;pointer-events:auto;${css}"></span>`;
    const noneWith = (place: Box, html: string) => ({ ...styled(place, 'pointer-events:none'), html });

    it('still checks the focused control, measured by the clickable descendant', async () => {
      const neighbor = box(16, 0, 16, 16);
      const whole = await measure(noneWith(box(0, 0, 16, 16), clickable('left:0;top:0;width:16px;height:16px')), [neighbor]);
      expect(whole.isPointerTarget).toBe(true);
      expect(whole.targetBox).toEqual({ x: 0, y: 0, width: 16, height: 16 });
      expect(whole.targetSpacing).toBe('crowded');
      expect(whole.neighborTargets).toEqual([{ x: 16, y: 0, width: 16, height: 16 }]);
      // A roomy control is undersized when only a small icon inside it takes the click.
      const icon = await measure(noneWith(box(0, 0, 40, 40), clickable('left:0;top:0;width:10px;height:10px')), [box(10, 0, 16, 16)]);
      expect(icon.isPointerTarget).toBe(true);
      expect(icon.targetBox).toEqual({ x: 0, y: 0, width: 10, height: 10 });
      expect(icon.targetSpacing).toBe('crowded');
      // A clickable descendant that meets the minimum size passes without a spacing search.
      const roomyChild = await measure(noneWith(box(0, 0, 16, 16), clickable('left:0;top:0;width:30px;height:30px')), [box(30, 0, 16, 16)]);
      expect(roomyChild.isPointerTarget).toBe(true);
      expect(roomyChild.targetBox).toEqual({ x: 0, y: 0, width: 30, height: 30 });
      expect(roomyChild.targetSpacing).toBeNull();
      // Elements in the control's open shadow root and slotted content are descendants too.
      const shadowed = await measureTree({ focused: box(0, 0, 16, 16), buttons: [neighbor] }, 2000, 50_000, () => page.evaluate(html => {
        // Buttons cannot host a shadow root, so a custom control takes the focus instead.
        document.getElementById('focused')!.remove();
        const control = document.createElement('div');
        control.setAttribute('role', 'button');
        control.tabIndex = 0;
        control.style.cssText = 'position:absolute;left:0;top:0;width:16px;height:16px;pointer-events:none';
        control.attachShadow({ mode: 'open' }).innerHTML = '<div><slot></slot></div>';
        control.innerHTML = html;
        document.body.append(control);
        control.focus();
      }, clickable('left:0;top:0;width:16px;height:16px')));
      expect(shadowed.targetBox).toEqual({ x: 0, y: 0, width: 16, height: 16 });
      expect(shadowed.targetSpacing).toBe('crowded');
    });

    it('counts a neighbour whose clickable descendant is adjacent to the target', async () => {
      const focused = box(0, 0, 16, 16);
      const crowded = await measure(focused, [noneWith(box(16, 0, 16, 16), clickable('left:0;top:0;width:16px;height:16px'))]);
      expect(crowded.targetSpacing).toBe('crowded');
      expect(crowded.neighborTargets).toEqual([{ x: 16, y: 0, width: 16, height: 16 }]);
      // The clickable descendant decides, even outside the neighbour's own box.
      const overflowing = await measure(focused, [noneWith(box(60, 0, 16, 16), clickable('left:-44px;top:0;width:16px;height:16px'))]);
      expect(overflowing.targetSpacing).toBe('crowded');
      expect(overflowing.neighborTargets).toEqual([{ x: 16, y: 0, width: 16, height: 16 }]);
      // A neighbour whose own box is adjacent but whose clickable descendant is far away does not crowd.
      const far = await measure(focused, [noneWith(box(16, 0, 16, 16), clickable('left:44px;top:0;width:16px;height:16px'))]);
      expect(far.targetSpacing).toBe('clear');
    });

    it('still excludes controls with no descendant that takes a pointer action', async () => {
      const neighbor = box(16, 0, 16, 16);
      const inert = '<span inert style="position:absolute;left:0;top:0;width:16px;height:16px;pointer-events:auto"></span>';
      for (const html of [
        '<span style="position:absolute;left:0;top:0;width:16px;height:16px"></span>',
        clickable('left:0;top:0;width:0;height:0'),
        clickable('left:0;top:0;width:16px;height:16px;visibility:hidden'),
        `<span style="display:none">${clickable('left:0;top:0;width:16px;height:16px')}</span>`,
        inert,
      ]) {
        const keyboardOnly = await measure(noneWith(box(0, 0, 16, 16), html), [neighbor]);
        expect(keyboardOnly.isPointerTarget, html).toBe(false);
        expect(keyboardOnly.targetBox, html).toBeUndefined();
        expect(keyboardOnly.targetSpacing, html).toBeNull();
        expect((await measure(box(0, 0, 16, 16), [noneWith(neighbor, html)])).targetSpacing, html).toBe('clear');
      }
      // A disabled control is not a target even when a descendant takes clicks.
      const disabled = await measureTree({ focused: box(0, 0, 16, 16), buttons: [noneWith(neighbor, clickable('left:0;top:0;width:16px;height:16px'))] }, 2000, 50_000, () => page.evaluate(() => {
        document.querySelector<HTMLButtonElement>('button:not(#focused)')!.disabled = true;
      }));
      expect(disabled.targetSpacing).toBe('clear');
    });

    it('reports a descendant walk cut short by the visit limit as inconclusive', async () => {
      const spans = '<span></span>'.repeat(60) + clickable('left:0;top:0;width:16px;height:16px');
      const focused = await measureTree({ focused: noneWith(box(0, 0, 40, 40), spans) }, 2000, 50);
      expect(focused.isPointerTarget).toBe(true);
      expect(focused.targetBox).toBeNull();
      expect(focused.targetSpacing).toBe('inconclusive');
      const neighbor = await measureTree({ focused: box(0, 0, 16, 16), buttons: [noneWith(box(60, 0, 16, 16), spans)] }, 2000, 50);
      expect(neighbor.targetSpacing).toBe('inconclusive');
      // Within the limit both are measured.
      expect((await measureTree({ focused: noneWith(box(0, 0, 40, 40), spans) }, 2000, 100)).targetBox).toEqual({ x: 0, y: 0, width: 16, height: 16 });
    });
  });

  it('bounds the elements it walks, not only the candidates it finds', async () => {
    // Counts the shadow-host checks the measurement itself makes, ordinary elements included.
    const countShadowRootReads = async (tree: Tree) => {
      const point = await measureTree(tree, 2000, 50_000, () => page.evaluate(() => {
        const state = window as unknown as { shadowRootReads?: number };
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')!;
        const patched = state.shadowRootReads !== undefined;
        state.shadowRootReads = 0;
        if (!patched) {
          Object.defineProperty(Element.prototype, 'shadowRoot', {
            ...descriptor,
            get() {
              state.shadowRootReads!++;
              return descriptor.get!.call(this);
            },
          });
        }
      }));
      return { point, reads: await page.evaluate(() => (window as unknown as { shadowRootReads: number }).shadowRootReads) };
    };
    try {
      const huge = await countShadowRootReads({ focused: box(0, 0, 16, 16), spans: 100_000 });
      expect(huge.point.targetSpacing).toBe('inconclusive');
      // The 50,000-element visit limit, plus a few reads to find the focused element; a full walk reads 100,000+.
      expect(huge.reads).toBeLessThanOrEqual(50_010);
      // Small pages are walked in full: crowding neighbours after ordinary elements and inside shadow roots are found.
      const small = await countShadowRootReads({ spans: 1_000, buttons: [box(48, 0, 16, 16)], shadows: [{ spans: 1_000, focused: box(0, 0, 16, 16) }, { spans: 1_000, buttons: [box(16, 0, 16, 16)] }] });
      expect(small.point.targetSpacing).toBe('crowded');
      expect(small.point.neighborTargets).toEqual([{ x: 16, y: 0, width: 16, height: 16 }]);
      const clear = await measureTree({ spans: 1_000, focused: box(0, 0, 16, 16), shadows: [{ spans: 1_000, buttons: [box(48, 0, 16, 16)] }] });
      expect(clear.targetSpacing).toBe('clear');
      // The visit limit is enforced on its own.
      const limited = await measureTree({ spans: 100, focused: box(0, 0, 16, 16), buttons: [box(16, 0, 16, 16)] }, 2000, 50);
      expect(limited.targetSpacing).toBe('inconclusive');
    } finally {
      await page.close();
      page = await browser.newPage();
    }
  });
});
