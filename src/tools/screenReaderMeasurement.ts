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
  needsName?: (nodeIndex: number) => boolean;
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

const measureChunkSize = 200;

const refResolutionTimeoutMs = 1000;

type CollectElementFactsInput =
  | (SVGElement | HTMLElement)[]
  | {
    elements: (SVGElement | HTMLElement)[];
    measureNames: boolean;
    measureNameMask?: boolean[];
  };

type ReadElementFactsInput =
  | playwright.ElementHandle<SVGElement | HTMLElement>[]
  | {
    elements: playwright.ElementHandle<SVGElement | HTMLElement>[];
    measureNames: boolean;
    measureNameMask?: boolean[];
  };

function collectSerializedElementFacts(input: CollectElementFactsInput): string {
  const elements = Array.isArray(input) ? input : input.elements;
  const measureNames = Array.isArray(input) ? true : input.measureNames;
  const measureNameMask = Array.isArray(input) ? undefined : input.measureNameMask;
  const memoize = <V>(compute: (element: Element) => V) => {
    const cache = new Map<Element, V>();
    return (element: Element): V => {
      if (!cache.has(element))
        cache.set(element, compute(element));
      return cache.get(element)!;
    };
  };
  const getStyle = memoize(element => window.getComputedStyle(element));
  const getRect = memoize(element => element.getBoundingClientRect());
  const textCache = new Map<Element, string>();
  const ariaHiddenCache = new Map<Element, boolean>();
  const ancestorHiddenCache = {
    none: new Map<Element, boolean>(),
    absolute: new Map<Element, boolean>(),
    fixed: new Map<Element, boolean>(),
  };
  const referenceBoxSize = (element: Element, style: CSSStyleDeclaration, box: string): { width: number, height: number } => {
    const px = (value: string) => parseFloat(value) || 0;
    if (!(element instanceof HTMLElement))
      return getRect(element);
    switch (box) {
      case 'border-box':
        return { width: element.offsetWidth, height: element.offsetHeight };
      case 'margin-box':
        return {
          width: element.offsetWidth + px(style.marginLeft) + px(style.marginRight),
          height: element.offsetHeight + px(style.marginTop) + px(style.marginBottom),
        };
      case 'padding-box':
        return { width: element.clientWidth, height: element.clientHeight };
      case 'content-box':
        return {
          width: element.clientWidth - px(style.paddingLeft) - px(style.paddingRight),
          height: element.clientHeight - px(style.paddingTop) - px(style.paddingBottom),
        };
      default:
        return getRect(element);
    }
  };
  const insetClipsEverything = (clipPath: string, element: Element, style: CSSStyleDeclaration): boolean => {
    if (clipPath === 'none' || !clipPath.startsWith('inset('))
      return false;
    const match = /^inset\(([^)]*)\)(?:\s+([a-z-]+))?/.exec(clipPath);
    if (!match)
      return false;
    const args = match[1].split(' round ')[0].trim().split(/\s+/);
    const { width, height } = referenceBoxSize(element, style, match[2] ?? 'border-box');
    const toPx = (value: string, size: number) => value.endsWith('%') ? (parseFloat(value) / 100) * size : parseFloat(value);
    const top = toPx(args[0], height);
    const right = toPx(args[1] ?? args[0], width);
    const bottom = toPx(args[2] ?? args[0], height);
    const left = toPx(args[3] ?? args[1] ?? args[0], width);
    return height - top - bottom <= 0 || width - left - right <= 0;
  };
  const transformCollapses = (element: Element, transform: string): boolean => {
    if (transform === 'none')
      return false;
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
      if (v[3] !== 0 || v[7] !== 0 || v[11] !== 0 || v[15] !== 1)
        return false;
      if (!singular(v[0], v[1], v[4], v[5]))
        return false;
      for (let node = parentInComposedTree(element); node; node = parentInComposedTree(node)) {
        const style = getStyle(node);
        if (style.perspective !== 'none' || style.transformStyle === 'preserve-3d')
          return false;
      }
      return true;
    }
    return false;
  };
  const nonGeometricHidden = (element: Element, style: CSSStyleDeclaration): boolean | null => {
    if (style.display === 'none' || style.opacity === '0')
      return true;
    if (style.display === 'contents')
      return false;
    if (style.transformStyle !== 'preserve-3d' && transformCollapses(element, style.transform))
      return true;
    if ((style.position === 'absolute' || style.position === 'fixed') && style.clip === 'rect(0px, 0px, 0px, 0px)')
      return true;
    return null;
  };
  const collapsedClippingBox = (style: CSSStyleDeclaration, element: Element): boolean => {
    if (style.overflow === 'visible')
      return false;
    const rect = getRect(element);
    return rect.width <= 1 || rect.height <= 1;
  };
  const subtreeHidden = (element: Element) => {
    const style = getStyle(element);
    const decided = nonGeometricHidden(element, style);
    if (decided !== null)
      return decided;
    if (insetClipsEverything(style.clipPath, element, style))
      return true;
    return collapsedClippingBox(style, element);
  };
  const visibilityHidden = (element: Element) => {
    const visibility = getStyle(element).visibility;
    return visibility === 'hidden' || visibility === 'collapse';
  };
  function parentInComposedTree(element: Element): Element | null {
    if (element.assignedSlot)
      return element.assignedSlot;
    if (element.parentElement)
      return element.parentElement;
    const root = element.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  }
  const ancestorSubtreeHidden = (element: Element): boolean => {
    const outOfFlow = (style: CSSStyleDeclaration): 'absolute' | 'fixed' | null =>
      style.position === 'absolute' || style.position === 'fixed' ? style.position : null;
    let escapingPosition = outOfFlow(getStyle(element));
    const trail: [Map<Element, boolean>, Element][] = [];
    let hidden = false;
    for (let node = parentInComposedTree(element); node; node = parentInComposedTree(node)) {
      const stateMap = ancestorHiddenCache[escapingPosition ?? 'none'];
      const cached = stateMap.get(node);
      if (cached !== undefined) {
        hidden = cached;
        break;
      }
      trail.push([stateMap, node]);
      const style = getStyle(node);
      const decided = nonGeometricHidden(node, style);
      if (decided) {
        hidden = true;
        break;
      }
      if (decided === null) {
        if (insetClipsEverything(style.clipPath, node, style)) {
          hidden = true;
          break;
        }
        const containingBlock = style.position !== 'static' || style.transform !== 'none';
        const fixedContainingBlock = style.transform !== 'none' || style.perspective !== 'none' || style.filter !== 'none';
        const bindsEscape = escapingPosition === 'fixed' ? fixedContainingBlock : containingBlock;
        if (collapsedClippingBox(style, node) && (!escapingPosition || bindsEscape)) {
          hidden = true;
          break;
        }
        const nodeOutOfFlow = outOfFlow(style);
        if (nodeOutOfFlow)
          escapingPosition = nodeOutOfFlow;
        else if (bindsEscape)
          escapingPosition = null;
      }
    }
    for (const [stateMap, visited] of trail)
      stateMap.set(visited, hidden);
    return hidden;
  };
  const renderedChildren = (element: Element): ArrayLike<Node> & Iterable<Node> => {
    if (element.shadowRoot)
      return element.shadowRoot.childNodes;
    if (element instanceof HTMLSlotElement)
      return element.assignedNodes({ flatten: true });
    return element.childNodes;
  };
  const sightedText = (element: Element, clipState: 'none' | 'escapable' = 'none'): string => {
    const cached = clipState === 'none' ? textCache.get(element) : undefined;
    if (cached !== undefined)
      return cached;
    let text = '';
    const ownTextVisible = clipState === 'none' && !visibilityHidden(element);
    for (const child of renderedChildren(element)) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (ownTextVisible)
          text += child.nodeValue ?? '';
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE)
        continue;
      const childElement = child as Element;
      const style = getStyle(childElement);
      const decided = nonGeometricHidden(childElement, style);
      if (decided)
        continue;
      let childState = clipState;
      if (decided === null) {
        if (insetClipsEverything(style.clipPath, childElement, style))
          continue;
        const outOfFlow = style.position === 'absolute' || style.position === 'fixed';
        const containingBlock = style.position !== 'static' || style.transform !== 'none';
        if (clipState === 'escapable') {
          if (outOfFlow)
            childState = 'none';
          else if (containingBlock)
            continue;
        }
        if (childState === 'none' && collapsedClippingBox(style, childElement)) {
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

  const buttonInputTypes = ['submit', 'button', 'reset'];
  const isAriaHiddenInComposedTree = (element: Element): boolean => {
    const trail: Element[] = [];
    let hidden = false;
    for (let node: Element | null = element; node; node = parentInComposedTree(node)) {
      const cached = ariaHiddenCache.get(node);
      if (cached !== undefined) {
        hidden = cached;
        break;
      }
      trail.push(node);
      if (node.getAttribute('aria-hidden')?.toLowerCase() === 'true') {
        hidden = true;
        break;
      }
    }
    for (const visited of trail)
      ariaHiddenCache.set(visited, hidden);
    return hidden;
  };
  const visibleTextOf = (element: SVGElement | HTMLElement): string => {
    if (subtreeHidden(element) || ancestorSubtreeHidden(element))
      return '';
    if (element instanceof HTMLInputElement && buttonInputTypes.includes(element.type))
      return visibilityHidden(element) ? '' : element.value.trim();
    return sightedText(element);
  };

  const shouldMeasureAnyName = measureNames && (!measureNameMask || measureNameMask.some(Boolean));
  const axe = shouldMeasureAnyName ? window.__mcpAccessibilityScannerAxe : undefined;
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
    } catch {}
  }

  const collect = (element: SVGElement | HTMLElement, index: number): ElementFacts => {
    const rect = getRect(element);
    const style = getStyle(element);
    const text = visibleTextOf(element);
    const nameResult = measureNames && (!measureNameMask || measureNameMask[index])
      ? measureName(element)
      : { accessibleName: null, nameMeasured: false };
    return {
      tagName: element.tagName.toLowerCase(),
      selector: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${element.classList[0] ? `.${element.classList[0]}` : ''}`,
      visibleText: text ? text.slice(0, 200) : null,
      href: element instanceof HTMLAnchorElement && element.hasAttribute('href') ? element.href : null,
      ...nameResult,
      rect: {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
      direction: style.direction === 'rtl' ? 'rtl' : 'ltr',
      positionFixed: style.position === 'fixed',
      floating: style.float !== 'none',
      ariaHidden: isAriaHiddenInComposedTree(element),
    };
  };

  try {
    return JSON.stringify(elements.map(collect));
  } finally {
    if (ownsAxeTree)
      axe!.teardown();
  }
}

/** @public */
export async function readElementFacts(
  target: Pick<playwright.Frame, 'evaluate'>,
  input: ReadElementFactsInput,
): Promise<ElementFacts[]> {
  return JSON.parse(await target.evaluate(collectSerializedElementFacts, input)) as ElementFacts[];
}

function framePrefixOf(ref: string): string | null {
  const match = /^(f\d+)?e\d+$/.exec(ref);
  return match ? (match[1] ?? '') : null;
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

export async function measureScreenReaderElements(
  page: playwright.Page,
  ariaNodes: readonly { ref: string | null }[],
  options: ScreenReaderMeasurementOptions,
): Promise<ScreenReaderMeasurement> {
  const refIndexes = ariaNodes.flatMap((node, index) => node.ref ? [index] : []);
  type Measured = { index: number; handle: playwright.ElementHandle<SVGElement | HTMLElement> };
  const onlyFrame = page.frames().length === 1 ? page.mainFrame() : null;
  const factsByIndex = new Map<number, ElementFacts>();
  const ownerFrameByPrefix = new Map<string, playwright.Frame>();
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

  const resolveRefHandle = async (ref: string): Promise<playwright.ElementHandle<SVGElement | HTMLElement> | null> => {
    const pending = page.$(`aria-ref=${ref}`).catch(() => null);
    const handle = await withFrameTimeout(pending, null, refResolutionTimeoutMs);
    if (!handle)
      void pending.then(late => late?.dispose().catch(() => undefined));
    return handle;
  };

  const resolveRefHandles = (chunk: number[]) => Promise.all(chunk.map(index => resolveRefHandle(ariaNodes[index].ref!)));

  const ownerFramesOf = async (chunk: number[], handles: (playwright.ElementHandle<SVGElement | HTMLElement> | null)[]) => {
    if (onlyFrame)
      return handles.map(handle => handle ? onlyFrame : null);
    const owners: (playwright.Frame | null)[] = new Array<playwright.Frame | null>(handles.length).fill(null);
    const uncachedByPrefix = new Map<string, number[]>();
    const unprefixedPositions: number[] = [];

    for (let position = 0; position < handles.length; position++) {
      const handle = handles[position];
      if (!handle)
        continue;
      const prefix = framePrefixOf(ariaNodes[chunk[position]].ref!);
      if (prefix === null) {
        unprefixedPositions.push(position);
        continue;
      }
      const cached = ownerFrameByPrefix.get(prefix);
      if (cached) {
        if (!cached.isDetached?.()) {
          owners[position] = cached;
          continue;
        }
        ownerFrameByPrefix.delete(prefix);
      }
      const group = uncachedByPrefix.get(prefix);
      if (group)
        group.push(position);
      else
        uncachedByPrefix.set(prefix, [position]);
    }

    const lookupOwnerFrame = async (handle: playwright.ElementHandle<SVGElement | HTMLElement>) => {
      const lookup = await runFrameWork(
          () => handle.ownerFrame(), null, page.mainFrame(),
          (owner, timedOut) => {
            if (!owner || timedOut)
              disposeHandles([handle]);
          });
      if (!lookup.started)
        disposeHandles([handle]);
      return lookup;
    };

    const resolveSingleHandle = async (position: number) => {
      const lookup = await lookupOwnerFrame(handles[position]!);
      if (lookup.started && !lookup.timedOut)
        owners[position] = lookup.value;
    };

    const resolvePrefixGroup = async (prefix: string, positions: number[]) => {
      for (let index = 0; index < positions.length; index++) {
        const lookup = await lookupOwnerFrame(handles[positions[index]]!);
        if (!lookup.started || lookup.timedOut) {
          disposeHandles(positions.slice(index + 1).map(pos => handles[pos]!));
          return;
        }
        if (lookup.value) {
          ownerFrameByPrefix.set(prefix, lookup.value);
          for (let rest = index; rest < positions.length; rest++)
            owners[positions[rest]] = lookup.value;
          return;
        }
      }
    };

    const tasks: (() => Promise<void>)[] = [
      ...[...uncachedByPrefix.entries()].map(([prefix, positions]) => () => resolvePrefixGroup(prefix, positions)),
      ...unprefixedPositions.map(position => () => resolveSingleHandle(position)),
    ];
    await withConcurrency(tasks, task => task());
    return owners;
  };

  const groupByFrame = (chunk: number[], handles: (playwright.ElementHandle<SVGElement | HTMLElement> | null)[], owners: (playwright.Frame | null)[]) => {
    const byFrame = new Map<playwright.Frame, Measured[]>();
    for (const [position, handle] of handles.entries()) {
      const frame = owners[position];
      if (!handle || !frame)
        continue;
      const batch = byFrame.get(frame) ?? [];
      batch.push({ index: chunk[position], handle });
      byFrame.set(frame, batch);
    }
    return byFrame;
  };

  const ensureAxeForNames = async (frame: playwright.Frame): Promise<boolean | undefined> => {
    const known = axeByFrame.get(frame);
    if (known !== undefined)
      return known;
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
      return undefined;
    }
    axeByFrame.set(frame, installation.value);
    return installation.value;
  };

  const measureFrameBatch = async ([frame, batch]: [playwright.Frame, Measured[]]) => {
    const batchHandles = batch.map(entry => entry.handle);
    if (frameWorkSaturated || unavailableFrames.has(frame)) {
      disposeHandles(batchHandles);
      return;
    }
    const nameMask = options.checkNames
      ? batch.map(entry => options.needsName ? options.needsName(entry.index) : true)
      : undefined;
    const batchNeedsNames = !!nameMask?.some(Boolean);
    const measureNames = batchNeedsNames ? await ensureAxeForNames(frame) : false;
    if (measureNames === undefined) {
      disposeHandles(batchHandles);
      return;
    }
    const input = measureNames && nameMask
      ? { elements: batchHandles, measureNames, measureNameMask: nameMask }
      : { elements: batchHandles, measureNames };
    const collected = await runFrameWork(
        () => readElementFacts(frame, input), null, frame,
        (facts, timedOut) => {
          if (facts && timedOut)
            unavailableFrames.delete(frame);
          disposeHandles(batchHandles);
        });
    if (!collected.started) {
      disposeHandles(batchHandles);
      return;
    }
    if (collected.timedOut) {
      unavailableFrames.add(frame);
      return;
    }
    const facts = collected.value;
    if (!facts)
      return;
    if (batchNeedsNames && nameMask)
      unmeasuredNames += facts.filter((fact, position) => nameMask[position] && !fact.nameMeasured).length;
    batch.forEach((entry, position) => factsByIndex.set(entry.index, facts[position]));
    resolvedCount += batch.length;
    reachable += facts.filter(fact => !fact.ariaHidden).length;
  };

  const measureCeiling = Math.min(refIndexes.length, options.maxElements * 2);
  for (let start = 0; start < measureCeiling && reachable < options.maxElements;) {
    const size = Math.min(measureChunkSize, options.maxElements - reachable, measureCeiling - start);
    const chunk = refIndexes.slice(start, start + size);
    start += size;
    const handles = await resolveRefHandles(chunk);
    const owners = await ownerFramesOf(chunk, handles);
    await withConcurrency([...groupByFrame(chunk, handles, owners)], measureFrameBatch);
    analyzedIndexes.push(...chunk);
    await options.reportProgress?.({
      progress: analyzedIndexes.length,
      total: measureCeiling,
      message: `Measured ${analyzedIndexes.length} accessibility tree elements (${Math.min(reachable, options.maxElements)}/${options.maxElements} screen-reader-reachable)`,
    });
    if (frameWorkSaturated)
      break;
  }

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
