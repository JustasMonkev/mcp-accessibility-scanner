/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * In-page measurement for the WCAG 1.4.12 Text Spacing stress test.
 *
 * Everything in this module that runs in the page (`measureTextSpacing`,
 * `applyTextSpacing`, `removeTextSpacing`) must stay self-contained: Playwright
 * serializes the function source, so it cannot reach module-level helpers.
 */

/** The four user overrides WCAG 1.4.12 requires content to survive. */
export const textSpacingOverrides = {
  lineHeight: 1.5,
  letterSpacingEm: 0.12,
  wordSpacingEm: 0.16,
  paragraphSpacingEm: 2,
} as const;

/** Every constructed stylesheet this tool adopts starts with a layer whose name has this prefix. */
export const textSpacingLayerPrefix = 'mcp-text-spacing-';

type TextSpacingRect = { x: number; y: number; width: number; height: number };

export type TextSpacingClipper = {
  selector: string;
  overflowX: string;
  overflowY: string;
  width: string;
  height: string;
  maxWidth: string;
  maxHeight: string;
  whiteSpace: string;
  textOverflow: string;
  lineClamp: string;
};

export type TextSpacingClip = {
  selector: string;
  text: string;
  fontSizePx: number;
  hiddenPercentBefore: number;
  hiddenPercentAfter: number;
  textBoxBefore: TextSpacingRect;
  textBoxAfter: TextSpacingRect;
  clippedBy: TextSpacingClipper | null;
};

export type TextSpacingOverlap = {
  selector: string;
  text: string;
  otherSelector: string;
  otherText: string;
  overlap: TextSpacingRect;
};

export type TextSpacingBlocked = {
  selector: string;
  text: string;
  properties: string[];
  inlineImportant: string[];
};

export type TextSpacingFrameMeasurement = {
  candidates: number;
  measured: number;
  truncated: number;
  stale: number;
  overlapLinesTruncated: number;
  clipped: TextSpacingClip[];
  overlaps: TextSpacingOverlap[];
  blocked: TextSpacingBlocked[];
};

export type TextSpacingMeasureArgs = {
  layerName: string;
  maxElements: number;
  /** Text lines per element compared for overlap; clipping always uses every line. */
  maxOverlapLines: number;
  overrides: typeof textSpacingOverrides;
};

/** Runs in the page: measure, apply the overrides, re-measure, and always remove them again. */
export async function measureTextSpacing(args: TextSpacingMeasureArgs): Promise<TextSpacingFrameMeasurement> {
  const { layerName, maxElements, maxOverlapLines, overrides } = args;
  const XHTML = 'http://www.w3.org/1999/xhtml';
  const skippedTags = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION', 'OPTGROUP', 'DATALIST',
    'IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'CANVAS', 'VIDEO', 'AUDIO', 'HEAD', 'TITLE',
  ]);
  type Box = { left: number; top: number; right: number; bottom: number };
  // loss*: overflow hidden/clip loses content on that axis; paint*: any non-visible overflow
  // (including scrollable auto/scroll) bounds what is painted, which is what can overlap.
  type Region = { element: Element; box: Box; lossX: boolean; lossY: boolean; paintX: boolean; paintY: boolean };
  type Phase = { lines: Box[]; visibleLines: Box[]; area: number; hidden: number; regions: Region[] };

  // --- Collect visible text elements in document order, through open shadow roots. ---
  const roots: (Document | ShadowRoot)[] = [document];
  const candidates: HTMLElement[] = [];
  const paragraphs: HTMLElement[] = [];
  let candidateCount = 0;
  const composedParent = (element: Element): Element | null => {
    if (element.assignedSlot)
      return element.assignedSlot;
    if (element.parentElement)
      return element.parentElement;
    const parent = element.parentNode;
    return parent instanceof ShadowRoot ? parent.host : null;
  };
  const hasOwnText = (element: Element) => {
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE && /\S/.test(child.nodeValue ?? ''))
        return true;
    }
    return false;
  };
  // `checkVisibilityProperty` is false for ancestors of a display: contents element: its own
  // (inherited) visibility decides whether its text paints, not the visibility of the box it renders in.
  const isVisible = (element: Element, checkVisibilityProperty = true): boolean => {
    const style = getComputedStyle(element);
    if (style.display === 'contents') {
      // No box of its own, so checkVisibility() is false, but its text renders in the parent's box.
      if (style.visibility !== 'visible')
        return false;
      const parent = composedParent(element);
      return !parent || isVisible(parent, false);
    }
    if (typeof element.checkVisibility === 'function')
      return element.checkVisibility({ opacityProperty: true, visibilityProperty: checkVisibilityProperty, contentVisibilityAuto: true });
    return (!checkVisibilityProperty || style.visibility !== 'hidden') && style.display !== 'none';
  };
  const collect = (root: Document | ShadowRoot) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: node => {
        const element = node as Element;
        if (element.namespaceURI !== XHTML || skippedTags.has(element.tagName))
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node as HTMLElement;
      if (element.localName === 'p' && isVisible(element))
        paragraphs.push(element);
      if (hasOwnText(element) && isVisible(element)) {
        candidateCount++;
        if (candidates.length < maxElements)
          candidates.push(element);
      }
      if (element.shadowRoot) {
        roots.push(element.shadowRoot);
        collect(element.shadowRoot);
      }
    }
  };
  collect(document);

  // --- Geometry helpers. ---
  const htmlOverflowVisible = () => {
    const style = getComputedStyle(document.documentElement);
    return style.overflowX === 'visible' && style.overflowY === 'visible';
  };
  const clips = (value: string) => value === 'hidden' || value === 'clip';
  const scrolls = (value: string) => value === 'auto' || value === 'scroll';
  // Reset per phase: the overrides change both computed styles and geometry.
  let regionCache = new Map<Element, Region | null>();
  let bodyPropagates = htmlOverflowVisible();
  const regionOf = (current: Element): Region | null => {
    if (regionCache.has(current))
      return regionCache.get(current)!;
    let region: Region | null = null;
    // The root element's overflow, and the body's when the root does not set one,
    // propagates to the viewport and does not clip the element itself.
    if (current !== document.documentElement && !(current === document.body && bodyPropagates)) {
      const style = getComputedStyle(current);
      const paintContained = /\b(paint|strict|content)\b/.test(style.contain);
      const lossX = paintContained || clips(style.overflowX);
      const lossY = paintContained || clips(style.overflowY);
      const paintX = lossX || scrolls(style.overflowX);
      const paintY = lossY || scrolls(style.overflowY);
      // A display: contents element has no box, so its overflow clips nothing.
      if ((paintX || paintY) && style.display !== 'contents') {
        const rect = current.getBoundingClientRect();
        const html = current as HTMLElement;
        const scaleX = html.offsetWidth ? rect.width / html.offsetWidth : 1;
        const scaleY = html.offsetHeight ? rect.height / html.offsetHeight : 1;
        const left = rect.left + current.clientLeft * scaleX;
        const top = rect.top + current.clientTop * scaleY;
        region = {
          element: current,
          box: { left, top, right: left + current.clientWidth * scaleX, bottom: top + current.clientHeight * scaleY },
          lossX,
          lossY,
          paintX,
          paintY,
        };
      }
    }
    regionCache.set(current, region);
    return region;
  };
  // Ancestors that become the containing block of fixed (and therefore also absolute) descendants.
  const containsFixed = (style: CSSStyleDeclaration) => style.display !== 'contents' && (
    style.transform !== 'none' || style.translate !== 'none' || style.rotate !== 'none' || style.scale !== 'none'
    || style.perspective !== 'none' || style.filter !== 'none' || (style.backdropFilter ?? 'none') !== 'none'
    || /\b(layout|paint|strict|content)\b/.test(style.contain) || /\b(transform|translate|rotate|scale|perspective|filter)\b/.test(style.willChange));
  const containsAbsolute = (style: CSSStyleDeclaration) => (style.display !== 'contents' && style.position !== 'static') || containsFixed(style);
  // Overflow clips a box only when the box's containing-block chain passes through it: an
  // absolutely positioned box escapes overflow: hidden ancestors below its positioned containing block.
  const clippingRegions = (element: HTMLElement): Region[] => {
    const regions: Region[] = [];
    for (let current: Element | null = element; current;) {
      const region = regionOf(current);
      if (region)
        regions.push(region);
      const style = getComputedStyle(current);
      const position = style.display === 'contents' ? 'static' : style.position;
      let next = composedParent(current);
      if (position === 'absolute' || position === 'fixed') {
        const contains = position === 'absolute' ? containsAbsolute : containsFixed;
        while (next && !contains(getComputedStyle(next)))
          next = composedParent(next);
      }
      current = next;
    }
    return regions;
  };
  const startPhase = () => {
    regionCache = new Map();
    bodyPropagates = htmlOverflowVisible();
  };
  const lineBoxes = (element: HTMLElement): Box[] => {
    const boxes: Box[] = [];
    const range = document.createRange();
    for (const child of element.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE || !/\S/.test(child.nodeValue ?? ''))
        continue;
      range.selectNodeContents(child);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0.5 && rect.height > 0.5)
          boxes.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
      }
    }
    return boxes;
  };
  const area = (box: Box) => Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top);
  // mode 'loss': content the user cannot reach (hidden/clip); mode 'paint': content actually painted.
  const clipTo = (box: Box, regions: Region[], mode: 'loss' | 'paint' = 'loss'): Box => {
    let { left, top, right, bottom } = box;
    for (const region of regions) {
      if (mode === 'loss' ? region.lossX : region.paintX) {
        left = Math.max(left, region.box.left);
        right = Math.min(right, region.box.right);
      }
      if (mode === 'loss' ? region.lossY : region.paintY) {
        top = Math.max(top, region.box.top);
        bottom = Math.min(bottom, region.box.bottom);
      }
    }
    return { left, top, right: Math.max(left, right), bottom: Math.max(top, bottom) };
  };
  const measurePhase = (element: HTMLElement): Phase => {
    const lines = lineBoxes(element);
    const regions = clippingRegions(element);
    let total = 0;
    let visible = 0;
    const visibleLines: Box[] = [];
    for (const line of lines) {
      total += area(line);
      visible += area(clipTo(line, regions, 'loss'));
      // Overlap uses painted geometry: lines scrolled out of a scrollport are reachable, not lost,
      // but they are not painted over the content outside the scroll container either.
      const painted = clipTo(line, regions, 'paint');
      if (area(painted) > 0)
        visibleLines.push(painted);
    }
    return { lines, visibleLines, area: total, hidden: Math.max(0, total - visible), regions };
  };
  const union = (boxes: Box[]): TextSpacingRect => {
    if (!boxes.length)
      return { x: 0, y: 0, width: 0, height: 0 };
    const left = Math.min(...boxes.map(box => box.left));
    const top = Math.min(...boxes.map(box => box.top));
    const right = Math.max(...boxes.map(box => box.right));
    const bottom = Math.max(...boxes.map(box => box.bottom));
    const round = (value: number) => Math.round(value * 10) / 10;
    return { x: round(left), y: round(top), width: round(right - left), height: round(bottom - top) };
  };

  // --- Selectors and text samples. ---
  const selectorCache = new Map<Element, string>();
  const segmentSelector = (element: Element): string => {
    const root = element.getRootNode() as Document | ShadowRoot;
    const parts: string[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) {
      const tag = current.localName;
      if (current.id && root.querySelectorAll(`#${CSS.escape(current.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      const parent = current.parentElement;
      const siblings = parent ? Array.from(parent.children).filter(child => child.localName === tag) : [];
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})` : tag);
      if (!parent || current === document.body)
        break;
    }
    return parts.join(' > ');
  };
  const selectorFor = (element: Element): string => {
    const cached = selectorCache.get(element);
    if (cached !== undefined)
      return cached;
    const root = element.getRootNode();
    const own = segmentSelector(element);
    const selector = root instanceof ShadowRoot ? `${selectorFor(root.host)} >>> ${own}` : own;
    selectorCache.set(element, selector);
    return selector;
  };
  const textSample = (element: Element) => {
    let text = '';
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE)
        text += child.nodeValue ?? '';
    }
    text = text.replace(/\s+/g, ' ').trim() || (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  };

  // --- Overlap detection between different elements' visible text lines. ---
  const overlapPairs = (phases: (Phase | null)[]): Map<string, Box> => {
    const entries = phases
        .map((phase, index) => ({ index, lines: (phase?.visibleLines ?? []).slice(0, maxOverlapLines) }))
        .filter(entry => entry.lines.length)
        .map(entry => ({ ...entry, top: Math.min(...entry.lines.map(line => line.top)), bottom: Math.max(...entry.lines.map(line => line.bottom)) }))
        .sort((a, b) => a.top - b.top);
    const pairs = new Map<string, Box>();
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length && entries[j].top < entries[i].bottom; j++) {
        let best: Box | null = null;
        for (const a of entries[i].lines) {
          for (const b of entries[j].lines) {
            const box = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
            const width = box.right - box.left;
            const height = box.bottom - box.top;
            const minLineHeight = Math.min(a.bottom - a.top, b.bottom - b.top);
            if (width >= 2 && height >= Math.max(1, minLineHeight * 0.3) && (!best || area(box) > area(best)))
              best = box;
          }
        }
        if (best) {
          const [first, second] = entries[i].index < entries[j].index ? [entries[i].index, entries[j].index] : [entries[j].index, entries[i].index];
          pairs.set(`${first}:${second}`, best);
        }
      }
    }
    return pairs;
  };

  const waitForLayout = () => new Promise<void>(resolve => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    // Background tabs throttle animation frames; layout itself is synchronous on read.
    setTimeout(finish, 150);
  });

  // --- Baseline. ---
  startPhase();
  const before = candidates.map(element => measurePhase(element));

  // --- Apply the overrides in a cascade layer: layered !important beats unlayered !important author rules. ---
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`@layer ${layerName} {
    * { line-height: ${overrides.lineHeight} !important; letter-spacing: ${overrides.letterSpacingEm}em !important; word-spacing: ${overrides.wordSpacingEm}em !important; }
    p { margin-bottom: ${overrides.paragraphSpacingEm}em !important; }
  }`);
  const adopted = roots;
  try {
    for (const root of adopted)
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    await waitForLayout();
    startPhase();

    const after: (Phase | null)[] = [];
    let stale = 0;
    for (const element of candidates) {
      if (!element.isConnected) {
        stale++;
        after.push(null);
        continue;
      }
      after.push(measurePhase(element));
    }

    // --- Verify the overrides actually took effect. ---
    const blocked: TextSpacingBlocked[] = [];
    const blockedByElement = new Map<HTMLElement, TextSpacingBlocked>();
    const recordBlocked = (element: HTMLElement, property: string) => {
      let entry = blockedByElement.get(element);
      if (!entry) {
        entry = { selector: selectorFor(element), text: textSample(element), properties: [], inlineImportant: [] };
        blockedByElement.set(element, entry);
        blocked.push(entry);
      }
      entry.properties.push(property);
      if (element.style.getPropertyPriority(property) === 'important')
        entry.inlineImportant.push(property);
    };
    candidates.forEach((element, index) => {
      if (!after[index])
        return;
      const style = getComputedStyle(element);
      const fontSize = parseFloat(style.fontSize);
      if (!(fontSize > 0))
        return;
      const px = (value: string) => value === 'normal' ? 0 : parseFloat(value);
      const failed: string[] = [];
      if (!(px(style.letterSpacing) >= fontSize * overrides.letterSpacingEm - 0.1))
        failed.push('letter-spacing');
      if (!(px(style.wordSpacing) >= fontSize * overrides.wordSpacingEm - 0.1))
        failed.push('word-spacing');
      if (style.lineHeight === 'normal' || !(parseFloat(style.lineHeight) >= fontSize * overrides.lineHeight - 0.5))
        failed.push('line-height');
      for (const property of failed)
        recordBlocked(element, property);
    });
    // Paragraph spacing is verified on every rendered paragraph, including ones whose
    // text sits only in child elements (<p><span>...</span></p>).
    for (const paragraph of paragraphs) {
      if (!paragraph.isConnected)
        continue;
      const style = getComputedStyle(paragraph);
      const fontSize = parseFloat(style.fontSize);
      if (fontSize > 0 && !(parseFloat(style.marginBottom) >= fontSize * overrides.paragraphSpacingEm - 0.5))
        recordBlocked(paragraph, 'margin-bottom');
    }

    // --- Newly clipped text. ---
    const clipped: TextSpacingClip[] = [];
    candidates.forEach((element, index) => {
      const base = before[index];
      const next = after[index];
      if (!next || !base.area || !next.area)
        return;
      const fractionBefore = base.hidden / base.area;
      const fractionAfter = next.hidden / next.area;
      const fontSize = parseFloat(getComputedStyle(element).fontSize) || 16;
      // Report only content the overrides newly hid: at least 2% more of the text and a quarter glyph of area.
      if (fractionAfter - fractionBefore < 0.02 || next.hidden - base.hidden < fontSize * fontSize * 0.25)
        return;
      let worst: Region | null = null;
      let worstHidden = 0;
      for (const region of next.regions) {
        let hidden = 0;
        for (const line of next.lines)
          hidden += area(line) - area(clipTo(line, [region]));
        if (hidden > worstHidden) {
          worstHidden = hidden;
          worst = region;
        }
      }
      let clippedBy: TextSpacingClipper | null = null;
      if (worst) {
        const style = getComputedStyle(worst.element);
        // getComputedStyle resolves `auto` sizes to pixels; the Typed OM keeps the computed
        // `auto`, so the fix text only blames a height or width the author actually set.
        const typedSize = (property: 'width' | 'height') => {
          try {
            const value = (worst!.element as HTMLElement).computedStyleMap?.().get(property)?.toString();
            if (value)
              return value;
          } catch {}
          return style[property];
        };
        clippedBy = {
          selector: selectorFor(worst.element),
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          width: typedSize('width'),
          height: typedSize('height'),
          maxWidth: style.maxWidth,
          maxHeight: style.maxHeight,
          whiteSpace: style.whiteSpace,
          textOverflow: style.textOverflow,
          lineClamp: style.getPropertyValue('-webkit-line-clamp') || 'none',
        };
      }
      clipped.push({
        selector: selectorFor(element),
        text: textSample(element),
        fontSizePx: Math.round(fontSize * 10) / 10,
        hiddenPercentBefore: Math.round(fractionBefore * 1000) / 10,
        hiddenPercentAfter: Math.round(fractionAfter * 1000) / 10,
        textBoxBefore: union(base.lines),
        textBoxAfter: union(next.lines),
        clippedBy,
      });
    });

    // --- Newly overlapping text. ---
    const baselineOverlaps = overlapPairs(before);
    const overlaps: TextSpacingOverlap[] = [];
    for (const [key, box] of overlapPairs(after)) {
      if (baselineOverlaps.has(key))
        continue;
      const [first, second] = key.split(':').map(Number);
      overlaps.push({
        selector: selectorFor(candidates[first]),
        text: textSample(candidates[first]),
        otherSelector: selectorFor(candidates[second]),
        otherText: textSample(candidates[second]),
        overlap: union([box]),
      });
    }

    return {
      candidates: candidateCount,
      measured: candidates.length - stale,
      truncated: candidateCount - candidates.length,
      stale,
      overlapLinesTruncated: after.filter(phase => phase && phase.visibleLines.length > maxOverlapLines).length,
      clipped,
      overlaps,
      blocked,
    };
  } finally {
    for (const root of adopted)
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter(entry => entry !== sheet);
  }
}

/** Runs in the page: adopt the overrides (used for the evidence screenshot). Returns the number of roots styled. */
export function applyTextSpacing(args: { layerName: string; overrides: typeof textSpacingOverrides }): number {
  const { layerName, overrides } = args;
  const roots: (Document | ShadowRoot)[] = [document];
  const visit = (root: Document | ShadowRoot) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const shadow = (node as Element).shadowRoot;
      if (shadow) {
        roots.push(shadow);
        visit(shadow);
      }
    }
  };
  visit(document);
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`@layer ${layerName} {
    * { line-height: ${overrides.lineHeight} !important; letter-spacing: ${overrides.letterSpacingEm}em !important; word-spacing: ${overrides.wordSpacingEm}em !important; }
    p { margin-bottom: ${overrides.paragraphSpacingEm}em !important; }
  }`);
  for (const root of roots)
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  return roots.length;
}

/** Runs in the page: drop every stylesheet this tool adopted (identified by its layer-name prefix). Returns how many were removed. */
export function removeTextSpacing(layerPrefix: string): number {
  let removed = 0;
  const isOurs = (sheet: CSSStyleSheet) => {
    try {
      const first = sheet.cssRules[0];
      return typeof CSSLayerBlockRule !== 'undefined' && first instanceof CSSLayerBlockRule && first.name.startsWith(layerPrefix);
    } catch {
      return false;
    }
  };
  const strip = (root: Document | ShadowRoot) => {
    const kept = root.adoptedStyleSheets.filter(sheet => !isOurs(sheet));
    if (kept.length !== root.adoptedStyleSheets.length) {
      removed += root.adoptedStyleSheets.length - kept.length;
      root.adoptedStyleSheets = kept;
    }
  };
  const visit = (root: Document | ShadowRoot) => {
    strip(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const shadow = (node as Element).shadowRoot;
      if (shadow)
        visit(shadow);
    }
  };
  visit(document);
  return removed;
}
