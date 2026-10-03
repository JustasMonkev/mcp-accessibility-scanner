/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

import { frameConcurrency, frameReadTimeoutMs, injectAxeForNames, withConcurrency, withFrameTimeout } from './axe.js';

import type * as playwright from 'playwright';

/** @public */
export type Rect = { x: number; y: number; width: number; height: number };


/** @public */
export type ElementFacts = {
  tagName: string | null;
  selector: string | null;
  visibleText: string | null;
  href: string | null;
  /**
   * The accessible name the page's accessibility tree computes for the
   * element (see collectElementFacts), or null when it is empty or was not
   * measured; nameMeasured tells those two apart.
   */
  accessibleName: string | null;
  nameMeasured: boolean;
  rect: Rect | null;
  direction: 'ltr' | 'rtl';
  positionFixed: boolean;
  floating: boolean;
  ariaHidden: boolean;
};


type ScreenReaderMeasurementOptions = {
  maxElements: number;
  checkNames: boolean;
  reportProgress?: (progress: { progress: number; total: number; message: string }) => Promise<void>;
};

type ScreenReaderMeasurement = {
  factsByIndex: ReadonlyMap<number, ElementFacts>;
  totalElements: number;
  analyzedElements: number;
  limitations: {
    unresolvedElements: number;
    unmeasuredNames: number;
    truncatedElements: number;
    stoppedAtFrameWorkLimit: number | null;
  };
};

// Refs are resolved and measured in chunks of this size.
const measureChunkSize = 50;

// A stale ref must not cost a full frame read per element.
const refResolutionTimeoutMs = 1000;

// Runs inside the page: no imports, no closures over module scope.
// Names are measured unless the caller says otherwise: an audit that checks
// only reading order skips that work, even when an earlier audit left the
// axe copy in the page.
/** @public */
export function collectElementFacts(
  input: (SVGElement | HTMLElement)[] | { elements: (SVGElement | HTMLElement)[]; measureNames: boolean }
): ElementFacts[] {
  const elements = Array.isArray(input) ? input : input.elements;
  const measureNames = Array.isArray(input) ? true : input.measureNames;
  // innerText counts visually hidden (clipped) labels as visible, which makes
  // icon-only controls look like text. Walk the subtree instead and skip the
  // usual visually-hidden techniques; the cache keeps nested elements linear.
  const textCache = new Map<Element, string>();
  // Conditions that hide an element AND everything beneath it: display:none,
  // full transparency, the sr-only clip patterns, and collapsed boxes that
  // clip. CSS visibility is deliberately not here — a descendant can restore
  // visibility:visible under a hidden ancestor and still be rendered, so it is
  // evaluated per node in sightedText instead.
  // A clip-path inset hides the subtree only when the region it leaves has no
  // area — the sr-only pattern is inset(50%), every edge pulled past the
  // midpoint. A partial inset such as inset(50% 0 0 0) keeps half the box
  // painted, and its computed value still starts with "inset(50%", so the
  // remaining region is computed from the inset components instead of
  // pattern-matching the serialized prefix. Non-numeric components (calc())
  // parse to NaN and fail every comparison, erring on the visible side.
  const insetClipsEverything = (clipPath: string, element: Element, rect: DOMRect, style: CSSStyleDeclaration): boolean => {
    const match = /^inset\(([^)]*)\)(?:\s+([a-z-]+))?/.exec(clipPath);
    if (!match)
      return false;
    const args = match[1].split(' round ')[0].trim().split(/\s+/);
    // clip-path lengths and percentages resolve against the untransformed
    // reference box, not the transformed bounding rect — a rotated element
    // swaps its rect's axes and a pixel inset would be compared against the
    // wrong dimension. The reference box is the geometry-box suffix when one
    // is given (border-box is the default): offsetWidth/offsetHeight for the
    // border box, clientWidth/clientHeight for the padding box (scrollbars
    // shave it — a rare sliver of over-hiding), those minus paddings for the
    // content box, offsets plus margins for the margin box. SVG geometry
    // boxes (fill/stroke/view) have no offset box, and for them — as for SVG
    // elements generally — the bounding rect is the closest stand-in here.
    const px = (value: string) => parseFloat(value) || 0;
    const box = match[2] ?? 'border-box';
    let width = rect.width;
    let height = rect.height;
    if (element instanceof HTMLElement) {
      if (box === 'border-box') {
        width = element.offsetWidth;
        height = element.offsetHeight;
      } else if (box === 'margin-box') {
        width = element.offsetWidth + px(style.marginLeft) + px(style.marginRight);
        height = element.offsetHeight + px(style.marginTop) + px(style.marginBottom);
      } else if (box === 'padding-box') {
        width = element.clientWidth;
        height = element.clientHeight;
      } else if (box === 'content-box') {
        width = element.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
        height = element.clientHeight - px(style.paddingTop) - px(style.paddingBottom);
      }
    }
    // Computed clip-path lengths are resolved to px; only percentages remain.
    const toPx = (value: string, size: number) => value.endsWith('%') ? (parseFloat(value) / 100) * size : parseFloat(value);
    const top = toPx(args[0], height);
    const right = toPx(args[1] ?? args[0], width);
    const bottom = toPx(args[2] ?? args[0], height);
    const left = toPx(args[3] ?? args[1] ?? args[0], width);
    return height - top - bottom <= 0 || width - left - right <= 0;
  };
  // A transform whose linear part is singular in exact arithmetic (scale(0),
  // scaleX(0), an edge-on rotateY(90deg), …) collapses the painted area to a
  // line or point — overflow included — so unlike an ordinary collapsed box
  // it hides the subtree even with overflow: visible; a composed singular
  // matrix stays singular, so no descendant transform can counter it. A
  // merely small determinant is not the same thing: a parent scaled by
  // 0.0001 (det 1e-8) is countered by a descendant scaled by 10000, which
  // renders a full-size label the audit must not prune. The two are told
  // apart relative to the components: float noise on an exact-zero
  // determinant is tiny next to the components' magnitude (Blink serializes
  // cos(90deg) as ~6e-17 beside a sin of exactly 1), while a genuine small
  // determinant sits on the order of its own components squared
  // (scale(0.0001): det 1e-8 against components of 1e-4). Computed
  // transforms serialize as matrix()/matrix3d(); a NaN determinant
  // (unparseable value) fails the comparison and errs on the visible side.
  const transformCollapses = (element: Element, transform: string): boolean => {
    const singular = (a: number, b: number, c: number, d: number) => {
      const det = a * d - b * c;
      const component = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
      return Math.abs(det) <= 1e-12 * component * component;
    };
    const matrix = /^matrix\(([^)]*)\)/.exec(transform);
    if (matrix) {
      const v = matrix[1].split(',').map(parseFloat);
      return singular(v[0], v[1], v[2], v[3]);
    }
    const matrix3d = /^matrix3d\(([^)]*)\)/.exec(transform);
    if (matrix3d) {
      const v = matrix3d[1].split(',').map(parseFloat);
      // Perspective makes the screen projection nonlinear: an edge-on plane
      // that sits off the perspective origin still projects to a quadrilateral
      // with positive area, so the linear-part test is sound only for affine
      // matrices (no perspective components).
      if (v[3] !== 0 || v[7] !== 0 || v[11] !== 0 || v[15] !== 1)
        return false;
      // The determinant of the x/y linear part: scaleZ(0) alone leaves flat
      // content rendered, so only the projected plane matters here.
      if (!singular(v[0], v[1], v[4], v[5]))
        return false;
      // A parent's perspective property is not serialized into this matrix.
      // It can give an otherwise edge-on child positive painted area. A
      // preserve-3d ancestor can likewise let a descendant counter-rotate.
      for (let node = parentInComposedTree(element); node; node = parentInComposedTree(node)) {
        const style = window.getComputedStyle(node);
        if (style.perspective !== 'none' || style.transformStyle === 'preserve-3d')
          return false;
      }
      return true;
    }
    return false;
  };
  // Hiding conditions that ignore box geometry; null means undecided — the
  // geometric checks (clip-path insets, collapsed clipping boxes) still apply.
  const nonGeometricHidden = (element: Element, style: CSSStyleDeclaration): boolean | null => {
    if (style.display === 'none' || style.opacity === '0')
      return true;
    // display:contents generates no box of its own, but its text and children
    // render as if lifted into the parent — a 0x0 rect there hides nothing,
    // and with no box there is nothing for either clip property to clip nor a
    // transform to apply to, so it is settled before those checks.
    if (style.display === 'contents')
      return false;
    if (style.transformStyle !== 'preserve-3d' && transformCollapses(element, style.transform))
      return true;
    // The legacy clip property only applies to absolutely positioned boxes; on
    // a static element it is inert and the content renders normally.
    if ((style.position === 'absolute' || style.position === 'fixed') && style.clip === 'rect(0px, 0px, 0px, 0px)')
      return true;
    return null;
  };
  // A collapsed box hides its subtree only when it also clips (the classic
  // sr-only pattern is 1x1 with overflow:hidden). With visible overflow the
  // content renders outside the box.
  const collapsedClippingBox = (style: CSSStyleDeclaration, rect: DOMRect): boolean =>
    (rect.width <= 1 || rect.height <= 1) && style.overflow !== 'visible';
  const subtreeHidden = (element: Element) => {
    const style = window.getComputedStyle(element);
    const decided = nonGeometricHidden(element, style);
    if (decided !== null)
      return decided;
    const rect = element.getBoundingClientRect();
    if (insetClipsEverything(style.clipPath, element, rect, style))
      return true;
    // Ceiling: during text descent a collapsed clipping box drops its whole
    // subtree, including an out-of-flow descendant whose containing block
    // lies outside the box and therefore escapes the clip. The measured
    // element itself — where the label checks read from — is protected by
    // the containing-block-aware ancestor walk below.
    return collapsedClippingBox(style, rect);
  };
  // visibility: collapse renders exactly like hidden outside table
  // rows/columns (and hides the row either way), so both values count.
  const visibilityHidden = (element: Element) => {
    const visibility = window.getComputedStyle(element).visibility;
    return visibility === 'hidden' || visibility === 'collapse';
  };
  function parentInComposedTree(element: Element): Element | null {
    // A slotted element renders where its assigned <slot> sits, so its
    // flat-tree parent is the slot; parentElement is the light-DOM host and
    // following it would skip a hidden wrapper around the slot inside the
    // shadow tree. (A closed shadow root reports no assignedSlot — there the
    // host is the closest reachable ancestor.)
    if (element.assignedSlot)
      return element.assignedSlot;
    if (element.parentElement)
      return element.parentElement;
    const root = element.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  }
  // Not every subtree-hiding condition surfaces in a descendant's own computed
  // style: opacity is not inherited, and a clipping or collapsed ancestor
  // leaves the descendant's rect untouched. Ancestors of the measured element
  // are walked (through shadow hosts) so a control inside an opacity:0 or
  // sr-only wrapper is not reported as showing text nobody can see.
  //
  // Overflow clips bind only descendants whose containing block sits at or
  // below the clipping box: an absolutely positioned control whose containing
  // block is a positioned wrapper OUTSIDE a collapsed 1px box renders in full
  // despite it. While walking up, track whether the content below rides an
  // out-of-flow position whose containing block has not been reached yet —
  // collapsed-box clips on the nodes in between do not bind it. Containing
  // blocks are approximated as any positioned or transformed ancestor for
  // absolute descendants, but only transformed/projected/filtered ancestors
  // for fixed ones.
  // Every other hiding condition applies regardless: display:none by
  // inheritance, opacity by compositing, clip-path through its stacking
  // context, and a singular transform because a transformed ancestor is the
  // containing block anyway.
  const ancestorSubtreeHidden = (element: Element): boolean => {
    const outOfFlow = (style: CSSStyleDeclaration): 'absolute' | 'fixed' | null =>
      style.position === 'absolute' || style.position === 'fixed' ? style.position : null;
    let escapingPosition = outOfFlow(window.getComputedStyle(element));
    for (let node = parentInComposedTree(element); node; node = parentInComposedTree(node)) {
      const style = window.getComputedStyle(node);
      const decided = nonGeometricHidden(node, style);
      if (decided)
        return true;
      if (decided === null) {
        const rect = node.getBoundingClientRect();
        if (insetClipsEverything(style.clipPath, node, rect, style))
          return true;
        const containingBlock = style.position !== 'static' || style.transform !== 'none';
        const fixedContainingBlock = style.transform !== 'none' || style.perspective !== 'none' || style.filter !== 'none';
        const bindsEscape = escapingPosition === 'fixed' ? fixedContainingBlock : containingBlock;
        if (collapsedClippingBox(style, rect) && (!escapingPosition || bindsEscape))
          return true;
        // A boxless (display:contents) node neither carries nor anchors
        // positioning, so the escape state only moves on box-generating nodes.
        if (outOfFlow(style))
          escapingPosition = outOfFlow(style);
        else if (bindsEscape)
          escapingPosition = null;
      }
    }
    return false;
  };
  // clipState mirrors the ancestor walk's containing-block model during the
  // descent: 'none' collects normally; 'escapable' means a collapsed static
  // clip box is above — its in-flow content is clipped (text suppressed), but
  // an absolutely/fixed positioned descendant whose containing block sits
  // outside the box escapes and collects normally again. Meeting a containing
  // block (positioned or transformed) while suppressed binds everything below
  // it inside the clip, so that branch prunes. A positioned collapsed box (the
  // classic sr-only shape) is its own containing block and prunes outright.
  const sightedText = (element: Element, clipState: 'none' | 'escapable' = 'none'): string => {
    const cached = clipState === 'none' ? textCache.get(element) : undefined;
    if (cached !== undefined)
      return cached;
    let text = '';
    // An element's own text nodes render only while its computed visibility is
    // visible; child elements are walked regardless, because unlike the
    // subtreeHidden conditions, visibility can be restored further down.
    const ownTextVisible = clipState === 'none' && !visibilityHidden(element);
    // A web component renders its visible label in its shadow root; walking only
    // light-DOM children makes such a host look like an icon-only control. The
    // shadow tree replaces the host's light children entirely — light nodes
    // render only where a <slot> assigns them, so slots contribute their
    // assigned nodes (or their own fallback content when nothing is assigned)
    // and unassigned light children contribute nothing.
    const children = element.shadowRoot
      ? element.shadowRoot.childNodes
      : element instanceof HTMLSlotElement
        ? element.assignedNodes({ flatten: true })
        : element.childNodes;
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (ownTextVisible)
          text += child.nodeValue ?? '';
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE)
        continue;
      // SAFETY: ELEMENT_NODE was checked above; childNodes can also contain text and comments.
      const childElement = child as Element;
      const style = window.getComputedStyle(childElement);
      const decided = nonGeometricHidden(childElement, style);
      if (decided)
        continue;
      let childState = clipState;
      if (decided === null) {
        const rect = childElement.getBoundingClientRect();
        if (insetClipsEverything(style.clipPath, childElement, rect, style))
          continue;
        const outOfFlow = style.position === 'absolute' || style.position === 'fixed';
        const containingBlock = style.position !== 'static' || style.transform !== 'none';
        if (clipState === 'escapable') {
          if (outOfFlow)
            childState = 'none';
          else if (containingBlock)
            continue;
        }
        if (childState === 'none' && collapsedClippingBox(style, rect)) {
          if (containingBlock)
            continue;
          childState = 'escapable';
        }
      }
      const childText = sightedText(childElement, childState);
      if (childText)
        text += ` ${childText}`;
    }
    const value = text.replace(/\s+/g, ' ').trim();
    if (clipState === 'none')
      textCache.set(element, value);
    return value;
  };

  // Button-like inputs render their label from `value` and have no child nodes,
  // so without this they look like icon-only controls to every text check.
  const buttonInputTypes = ['submit', 'button', 'reset'];

  // The accessible name comes from the axe-core build the audit installs in
  // the frame under its own global (axeForNamesGlobal in axe.ts; the literal
  // is repeated here because this function is serialized into the page and
  // cannot import it). Playwright's AI snapshot leaves out a
  // name its rendered children carry, and rebuilding one by hand from
  // textContent is not what a screen reader hears: hidden text is skipped,
  // alt text and aria-label on a referenced element count, an input
  // contributes its value. axe's tree is built for the document once per
  // batch and released after, so a page that changed since the last batch is
  // read fresh; the build costs about 40 ms on a 3,600-node article page, a
  // third of a second over the eight batches of a default audit. Without the
  // copy (not installed, or the page removed it) every name is null and the
  // snapshot's own stands.
  const axe = measureNames ? window.__mcpAccessibilityScannerAxe : undefined;
  let measureName = (_element: Element): { accessibleName: string | null; nameMeasured: boolean } => ({ accessibleName: null, nameMeasured: false });
  let ownsAxeTree = false;
  if (typeof axe?.setup === 'function' && typeof axe?.commons?.text?.accessibleText === 'function') {
    try {
      axe.setup(document);
      ownsAxeTree = true;
      measureName = element => {
        try {
          return { accessibleName: axe.commons.text.accessibleText(element).replace(/\s+/g, ' ').trim() || null, nameMeasured: true };
        } catch {
          return { accessibleName: null, nameMeasured: false };
        }
      };
    } catch {
      // A tree the copy already holds belongs to an earlier, interrupted batch; it is neither read nor released here.
    }
  }

  const collect = (element: SVGElement | HTMLElement): ElementFacts => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    // The visibility predicate must include the element itself, not only its
    // descendants: a control hidden with opacity:0 shows no text at all, and
    // treating its child text as visible raises label-in-name mismatches
    // against a label nobody can see. Button-like inputs render no children,
    // so for them visibility:hidden is as final as the subtree conditions.
    const text = subtreeHidden(element) || ancestorSubtreeHidden(element)
      ? ''
      : element instanceof HTMLInputElement && buttonInputTypes.includes(element.type)
        ? (visibilityHidden(element) ? '' : element.value.trim())
        : sightedText(element);
    return {
      tagName: element.tagName.toLowerCase(),
      selector: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${element.classList[0] ? `.${element.classList[0]}` : ''}`,
      visibleText: text ? text.slice(0, 200) : null,
      // The resolved URL, so that "/help" and "https://site/help" are recognised
      // as the same destination rather than reported as ambiguous links.
      href: element instanceof HTMLAnchorElement && element.hasAttribute('href') ? element.href : null,
      ...measureName(element),
      rect: {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
      direction: style.direction === 'rtl' ? 'rtl' : 'ltr',
      positionFixed: style.position === 'fixed',
      floating: style.float !== 'none',
      // Playwright's snapshot still lists aria-hidden elements, but a screen
      // reader never reaches them, so nothing about them is a defect. ARIA
      // enumerated tokens are ASCII case-insensitive, so aria-hidden="TRUE"
      // hides exactly like "true". closest() stops at the shadow boundary,
      // so the composed-tree walker is used instead — a host (or a host's
      // ancestor) carrying aria-hidden removes its whole shadow tree from
      // the accessibility tree too.
      ariaHidden: (() => {
        for (let node: Element | null = element; node; node = parentInComposedTree(node)) {
          if (node.getAttribute('aria-hidden')?.toLowerCase() === 'true')
            return true;
        }
        return false;
      })(),
    };
  };

  try {
    return elements.map(collect);
  } finally {
    if (ownsAxeTree)
      axe!.teardown();
  }
}


type FrameWork = {
  inFlight: number;
  timedOut: number;
  waiters: Set<() => void>;
};

const frameWorkByPage = new WeakMap<playwright.Page, FrameWork>();

function wakeFrameWork(frameWork: FrameWork) {
  for (const wake of [...frameWork.waiters])
    wake();
}

async function reserveFrameWork(frameWork: FrameWork): Promise<boolean> {
  while (frameWork.inFlight >= frameConcurrency) {
    if (frameWork.timedOut >= frameConcurrency)
      return false;
    await new Promise<void>(resolve => {
      const wake = () => {
        frameWork.waiters.delete(wake);
        resolve();
      };
      frameWork.waiters.add(wake);
    });
  }
  frameWork.inFlight++;
  return true;
}


/**
 * Measure snapshot refs for one screen-reader audit. Owns frame resolution,
 * name installation, bounded reads and handle cleanup, including work that
 * settles after this call returns. Overlapping audits share a page's capacity.
 * Partial measurements retain explicit limitations; no measurements is an error.
 */
export async function measureScreenReaderElements(
  page: playwright.Page,
  ariaNodes: readonly { ref: string | null }[],
  options: ScreenReaderMeasurementOptions,
): Promise<ScreenReaderMeasurement> {
  const refIndexes = ariaNodes.map((node, index) => node.ref ? index : -1).filter(index => index >= 0);
  // Snapshot elements can live in child frames, and a handle can only be
  // evaluated by its own frame, so measure one batch per owning frame.
  type Measured = { index: number; handle: playwright.ElementHandle<SVGElement | HTMLElement> };
  const onlyFrame = page.frames().length === 1 ? page.mainFrame() : null;
  const factsByIndex = new Map<number, ElementFacts>();
  // The accessible-name algorithm runs in the page (see collectElementFacts),
  // so a frame gets this server's axe-core build before its first batch,
  // and only when names are checked at all. A frame that refuses it or cannot
  // build the tree is measured without names; one that never answers is left
  // unresolved. The result says which happened. The map holds the settled
  // installation result per frame.
  const axeByFrame = new Map<playwright.Frame, boolean>();
  const unavailableFrames = new Set<playwright.Frame>();
  let unmeasuredNames = 0;
  const analyzedIndexes: number[] = [];
  let resolvedCount = 0;
  let reachable = 0;
  const frameWork = frameWorkByPage.get(page) ?? { inFlight: 0, timedOut: 0, waiters: new Set() };
  frameWorkByPage.set(page, frameWork);
  let frameWorkSaturated = false;

  const runFrameWork = async <T>(
    start: () => Promise<T>,
    fallback: T,
    frame: playwright.Frame,
    onSettled?: (value: T, timedOut: boolean) => void,
  ) => {
    if (!await reserveFrameWork(frameWork)) {
      frameWorkSaturated = true;
      return { value: fallback, timedOut: false, started: false };
    }
    let settled = false;
    let timedOut = false;
    const work = Promise.resolve().then(start).catch(() => fallback).then(value => {
      settled = true;
      frameWork.inFlight--;
      if (timedOut)
        frameWork.timedOut--;
      wakeFrameWork(frameWork);
      onSettled?.(value, timedOut);
      return value;
    });
    const value = await withFrameTimeout(work, fallback, frameReadTimeoutMs(frame));
    if (!settled) {
      timedOut = true;
      frameWork.timedOut++;
      wakeFrameWork(frameWork);
    }
    return { value, timedOut: !settled, started: true };
  };

  const disposeHandles = (handles: readonly playwright.ElementHandle[]) => {
    void Promise.all(handles.map(handle => handle.dispose().catch(() => undefined)));
  };

  // maxElements budgets the elements a screen reader can actually reach: the
  // AI snapshot also refs aria-hidden subtrees, and slicing the raw ref list
  // let those spend the whole budget and leave every visible control below
  // them unmeasured. The ceiling keeps a page made mostly of hidden refs
  // bounded. Refs are resolved a chunk at a time because a ref that went
  // stale costs a full timeout, and one timeout per element serially would
  // stall a large audit for minutes.
  const measureCeiling = Math.min(refIndexes.length, options.maxElements * 2);
  for (let start = 0; start < measureCeiling && reachable < options.maxElements;) {
    // Never take more than the remaining budget, or a maxElements that is not
    // a multiple of the chunk size would analyze a whole extra chunk.
    const size = Math.min(measureChunkSize, options.maxElements - reachable, measureCeiling - start);
    const chunk = refIndexes.slice(start, start + size);
    start += size;
    const handles = await Promise.all(chunk.map(index =>
      page.locator(`aria-ref=${ariaNodes[index].ref}`).elementHandle({ timeout: refResolutionTimeoutMs }).catch(() => null)));
    // The owner lookup is a renderer round-trip too, so a frame that stopped
    // answering since the resolution above would hold the audit here. It is
    // bounded, and since the owner is what the lookup finds, given the larger
    // budget; run together, a frame that stopped answering costs one budget
    // per chunk rather than one per element.
    const owners = onlyFrame
      ? handles.map(handle => handle ? onlyFrame : null)
      : await withConcurrency(handles, async handle => {
        if (!handle)
          return null;
        const lookup = await runFrameWork(
            () => handle.ownerFrame(), null, page.mainFrame(),
            (owner, timedOut) => {
              if (!owner || timedOut)
                disposeHandles([handle]);
            });
        if (!lookup.started)
          disposeHandles([handle]);
        return lookup.started && !lookup.timedOut ? lookup.value : null;
      });
    const byFrame = new Map<playwright.Frame, Measured[]>();
    for (const [position, handle] of handles.entries()) {
      const frame = owners[position];
      if (!handle || !frame)
        continue;
      const batch = byFrame.get(frame);
      if (batch)
        batch.push({ index: chunk[position], handle });
      else
        byFrame.set(frame, [{ index: chunk[position], handle }]);
    }
    await withConcurrency([...byFrame], async ([frame, batch]) => {
      if (frameWorkSaturated || unavailableFrames.has(frame)) {
        disposeHandles(batch.map(entry => entry.handle));
        return;
      }
      let measureNames = options.checkNames;
      if (measureNames) {
        let installed = axeByFrame.get(frame);
        if (installed === undefined) {
          const installation = await runFrameWork(
              () => injectAxeForNames(frame), false, frame,
              (installed, timedOut) => {
                if (timedOut) {
                  axeByFrame.set(frame, installed);
                  unavailableFrames.delete(frame);
                }
              });
          if (!installation.started || installation.timedOut) {
            if (installation.timedOut)
              unavailableFrames.add(frame);
            disposeHandles(batch.map(entry => entry.handle));
            return;
          }
          installed = installation.value;
          axeByFrame.set(frame, installed);
        }
        measureNames = installed;
      }
      // frame.evaluate has no timeout of its own, and a timeout only stops
      // the wait: a timed-out installation is still running in the frame and
      // every later read queues behind it on the same renderer task. Every
      // read is bounded, and timed-out work keeps its pool slot so frozen
      // frames cannot build an unbounded queue behind them.
      const collected = await runFrameWork(
          () => frame.evaluate(collectElementFacts, { elements: batch.map(entry => entry.handle), measureNames }), null, frame,
          (facts, timedOut) => {
            if (facts && timedOut)
              unavailableFrames.delete(frame);
            disposeHandles(batch.map(entry => entry.handle));
          });
      if (!collected.started) {
        disposeHandles(batch.map(entry => entry.handle));
        return;
      }
      if (collected.timedOut) {
        unavailableFrames.add(frame);
        return;
      }
      const facts = collected.value;
      if (facts) {
        // Counted from the measurement itself, not from the installation:
        // the copy can be there and still fail to build its tree.
        if (options.checkNames)
          unmeasuredNames += facts.filter(fact => !fact.nameMeasured).length;
        batch.forEach((entry, position) => factsByIndex.set(entry.index, facts[position]));
        resolvedCount += batch.length;
        reachable += facts.filter(fact => !fact.ariaHidden).length;
      }
    });
    analyzedIndexes.push(...chunk);
    await options.reportProgress?.({
      progress: analyzedIndexes.length,
      total: measureCeiling,
      message: `Measured ${analyzedIndexes.length} accessibility tree elements (${Math.min(reachable, options.maxElements)}/${options.maxElements} screen-reader-reachable)`,
    });
    if (frameWorkSaturated)
      break;
  }

  // A ref goes stale when the page rerenders between ariaSnapshot() and
  // locator resolution. Such elements have no facts, every check skips them,
  // and with nothing resolved at all the audit would otherwise report
  // "Findings: 0" for a page it never actually evaluated.
  const unresolvedCount = analyzedIndexes.length - resolvedCount;
  if (analyzedIndexes.length && !resolvedCount)
    throw new Error(`None of the ${analyzedIndexes.length} accessibility tree elements could be resolved to DOM nodes — the page re-rendered between the snapshot and measurement, or stopped answering, so nothing was evaluated. Wait for the page to settle (or trigger the rerender first) and run audit_screen_reader again.`);
  return {
    factsByIndex,
    totalElements: refIndexes.length,
    analyzedElements: analyzedIndexes.length,
    limitations: {
      unresolvedElements: unresolvedCount,
      unmeasuredNames,
      truncatedElements: refIndexes.length - analyzedIndexes.length,
      stoppedAtFrameWorkLimit: frameWorkSaturated ? frameConcurrency : null,
    },
  };
}
