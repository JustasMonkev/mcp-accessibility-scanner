/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { collectElementFacts } from '../src/tools/screenReaderMeasurement.js';

describe('screen-reader DOM reads', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('shares reads within a batch, skips irrelevant ancestor geometry, and refreshes the next batch', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <style>main, button, span { overflow: visible; } #first { overflow: hidden; }</style>
        <main id="shared">
          <button id="first">First <span id="detail">detail</span></button>
          <button id="second">Second</button>
        </main>
      `);
      const handles = await page.$$('button, #detail');
      const tracker = await page.evaluateHandle(() => {
        const styles = new Map<Element, number>();
        const rects = new Map<Element, number>();
        const originalStyle = window.getComputedStyle;
        const originalRect = Element.prototype.getBoundingClientRect;
        window.getComputedStyle = (element, pseudoElement) => {
          styles.set(element, (styles.get(element) ?? 0) + 1);
          return originalStyle.call(window, element, pseudoElement);
        };
        Element.prototype.getBoundingClientRect = function(this: Element) {
          rects.set(this, (rects.get(this) ?? 0) + 1);
          return originalRect.call(this);
        };
        return {
          reads: () => ({
            styles: Array.from(styles, ([element, count]) => ({ id: element.id, count })),
            rects: Array.from(rects, ([element, count]) => ({ id: element.id, count })),
          }),
          restore: () => {
            window.getComputedStyle = originalStyle;
            Element.prototype.getBoundingClientRect = originalRect;
          },
        };
      });

      const first = await page.evaluate(collectElementFacts, { elements: handles, measureNames: false });
      expect(first.map(fact => fact.visibleText)).toEqual(['First detail', 'detail', 'Second']);
      expect(first.every(fact => !fact.ariaHidden && !fact.nameMeasured)).toBe(true);
      const reads = await tracker.evaluate(value => value.reads());
      expect(reads.styles.find(read => read.id === 'shared')).toEqual({ id: 'shared', count: 1 });
      expect(reads.styles.every(read => read.count === 1)).toBe(true);
      expect(reads.rects.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: 'detail', count: 1 },
        { id: 'first', count: 1 },
        { id: 'second', count: 1 },
      ]);
      await tracker.evaluate(value => value.restore());
      await tracker.dispose();

      await page.locator('#shared').evaluate(element => {
        element.style.opacity = '0';
      });
      await page.locator('#first').evaluate(element => {
        element.style.width = '200px';
        element.style.boxSizing = 'border-box';
      });
      await page.locator('#detail').evaluate(element => {
        element.textContent = 'Changed';
      });
      const hidden = await page.evaluate(collectElementFacts, { elements: handles, measureNames: false });
      expect(hidden.map(fact => fact.visibleText)).toEqual([null, null, null]);
      expect(hidden[0].rect?.width).toBe(200);
      expect(hidden[0].rect?.width).not.toBe(first[0].rect?.width);

      await page.locator('#shared').evaluate(element => {
        element.style.opacity = '1';
      });
      const visible = await page.evaluate(collectElementFacts, { elements: handles, measureNames: false });
      expect(visible.map(fact => fact.visibleText)).toEqual(['First Changed', 'Changed', 'Second']);
    } finally {
      await page.close();
    }
  });
});
