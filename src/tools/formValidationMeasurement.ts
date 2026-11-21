/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

import type { ElementHandle, Page } from 'playwright';
import axe from 'axe-core';
import type { Bounded, ScenarioGuard } from './scenarioGuard.js';

export type FieldEvidence = { selector: string; ariaInvalid: string | null; nativeInvalid: boolean; invalid: boolean; focused: boolean; nativeValidationPossible: boolean; associatedErrors: string[] };
export type FeedbackEvidence = { selector: string; kind: 'error' | 'status'; present: boolean; textPresent: boolean; exposed: boolean; focused: boolean; live: string | null; baselineLive: string | null; changed: boolean; textTruncated: boolean };

export async function uniqueElement(page: Page, selector: string, guard: ScenarioGuard) {
  const locator = page.locator(`css=${selector}`);
  if (await guard.bounded(() => locator.count()) !== 1)
    return null;
  return guard.bounded(timeout => locator.elementHandle({ timeout, signal: guard.signal }));
}

const concreteAriaRoles = Object.entries(axe.utils.getStandards().ariaRoles)
  .filter(([, role]) => role.type !== 'abstract')
  .map(([name]) => name);

export function createFeedbackReader(page: Page) {
  return page.evaluateHandle(concreteAriaRoles => {
    function parentElementAcrossShadow(node: Element) {
      const root = node.getRootNode();
      return node.assignedSlot ?? node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    }
    function hiddenFromAccessibility(node: Element) {
      return node.getAttribute('aria-hidden')?.toLowerCase() === 'true' || node.hasAttribute('inert');
    }
    function hidesContent(node: Element, child: Element | null) {
      if (getComputedStyle(node).contentVisibility === 'hidden')
        return true;
      return node instanceof HTMLDetailsElement && !node.open && (!child || node.querySelector(':scope > summary') !== child);
    }
    function isRendered(node: Element, visibilityProperty: boolean): boolean {
      const style = getComputedStyle(node);
      if (style.display !== 'contents')
        return node.checkVisibility({ visibilityProperty, checkVisibilityCSS: visibilityProperty });
      if (visibilityProperty && style.visibility !== 'visible')
        return false;
      if (!node.assignedSlot && node.parentElement?.shadowRoot)
        return false;
      if (node.parentElement instanceof HTMLSlotElement && node.parentElement.assignedNodes().length)
        return false;
      const parent = parentElementAcrossShadow(node);
      return !parent || !hidesContent(parent, node) && isRendered(parent, false);
    }
    function isAccessible(element: Element) {
      for (let node: Element | null = element; node; node = parentElementAcrossShadow(node)) {
        if (hiddenFromAccessibility(node))
          return false;
      }
      return true;
    }
    function isExposed(node: Element, accessible: boolean) {
      return accessible && isRendered(node, true) && getComputedStyle(node).contentVisibility !== 'hidden';
    }
    const liveByRole = new Map([
      ['alert', 'assertive'], ['status', 'polite'], ['log', 'polite'], ['timer', 'off'], ['marquee', 'off'],
    ]);
    function liveValue(node: Element) {
      const explicit = node.getAttribute('aria-live')?.trim().toLowerCase() ?? '';
      const role = node.getAttribute('role')?.toLowerCase().split(/[\t\n\f\r ]+/).find(token => concreteAriaRoles.includes(token));
      return ['off', 'polite', 'assertive'].includes(explicit) ? explicit : liveByRole.get(role ?? '');
    }
    const initialOwners: ({ owner: Element | null; live: string | null } | undefined)[] = [];
    const candidateOwners = new WeakMap<Element, string>();
    function rememberCandidates(elements: Element[]) {
      for (const element of elements) {
        const live = liveValue(element);
        if (live !== undefined && isExposed(element, isAccessible(element)))
          candidateOwners.set(element, live);
      }
    }
    function read(elements: Element[], index: number, stage: 'baseline' | 'current') {
      if (elements.length > 1)
        return null;
      const element = elements[0];
      if (!element)
        return { present: false, text: '', exposed: false, focused: false, live: null, baselineLive: null, textTruncated: false };
      const accessible = isAccessible(element);
      const exposed = isExposed(element, accessible);
      function renderedChildren(node: Element): ArrayLike<Node> {
        if (node.shadowRoot)
          return node.shadowRoot.childNodes;
        const assigned = node instanceof HTMLSlotElement ? node.assignedNodes() : undefined;
        return assigned?.length ? assigned : node.childNodes;
      }
      const sampleLimit = 10_000;
      let text = '';
      let visitedNodes = 0;
      const frameFor = (node: Element, accessible: boolean) => ({
        accessible,
        children: renderedChildren(node),
        textExposed: accessible && isRendered(node, true) && !hidesContent(node, null),
        index: 0,
      });
      const stack = [frameFor(element, accessible)];
      while (stack.length) {
        const frame = stack[stack.length - 1];
        if (frame.index >= frame.children.length) {
          stack.pop();
          continue;
        }
        const node = frame.children[frame.index++];
        if (++visitedNodes > sampleLimit)
          break;
        if (node instanceof Element)
          stack.push(frameFor(node, frame.accessible && !hiddenFromAccessibility(node)));
        if (node.nodeType === Node.TEXT_NODE && frame.textExposed) {
          text += (node.nodeValue ?? '').slice(0, sampleLimit + 1 - text.length);
          if (text.length > sampleLimit)
            break;
        }
      }
      const textTruncated = visitedNodes > sampleLimit || text.length > sampleLimit;
      let live: string | undefined;
      let owner: Element | null = null;
      for (let node: Element | null = element; node; node = parentElementAcrossShadow(node)) {
        live = liveValue(node);
        if (live !== undefined) {
          owner = isExposed(node, isAccessible(node)) ? node : null;
          break;
        }
      }
      if (stage === 'baseline')
        initialOwners[index] = { owner, live: live ?? null };
      const initial = initialOwners[index];
      let baselineLive: string | null = null;
      if (owner && initial?.owner === owner)
        baselineLive = initial.live;
      else if (owner && !initial)
        baselineLive = candidateOwners.get(owner) ?? null;
      const root = element.getRootNode();
      const active = root instanceof Document || root instanceof ShadowRoot ? root.activeElement : null;
      return { present: true, text: text.slice(0, sampleLimit), textTruncated, exposed, focused: !!active && element.contains(active), live: live ?? null, baselineLive };
    }
    return { read, rememberCandidates };
  }, concreteAriaRoles);
}

export async function readFeedback(
  page: Page,
  targets: { selector: string }[],
  bounded: Bounded,
  reader: Awaited<ReturnType<typeof createFeedbackReader>>,
  stage: 'baseline' | 'current',
) {
  const result = [];
  for (const [index, target] of targets.entries()) {
    const point = await bounded(() => page.locator(`css=${target.selector}`).evaluateAll(
      (elements, { reader, index, stage }) => reader.read(elements, index, stage), { reader, index, stage }));
    if (!point)
      throw new Error('Feedback selector became ambiguous.');
    result.push(point);
  }
  if (stage === 'baseline' && result.some(point => !point.present))
    await bounded(() => page.locator('[role], [aria-live]').evaluateAll((elements, reader) => reader.rememberCandidates(elements), reader));
  return result;
}

export async function readFields(page: Page, scenario: { fields: { selector: string }[]; submitSelector: string }, feedback: FeedbackEvidence[], guard: ScenarioGuard) {
  const selectorsWithText = new Set(feedback.values().filter(point => point.textPresent).map(point => point.selector));
  const errorSelectors = feedback.values()
    .filter(point => point.kind === 'error' && selectorsWithText.has(point.selector))
    .map(point => point.selector).toArray();
  const handles: (ElementHandle<Element> | null)[] = [];
  try {
    for (const selector of [scenario.submitSelector, ...errorSelectors])
      handles.push(await uniqueElement(page, selector, guard));
    const [submitTarget, ...expectedTargets] = handles;
    const fields: FieldEvidence[] = [];
    for (const field of scenario.fields) {
      const { associated, ...evidence } = await guard.bounded(timeout => page.locator(`css=${field.selector}`).evaluate((element, { expectedTargets, submitTarget }) => {
        const root = element.getRootNode();
        const active = root instanceof Document || root instanceof ShadowRoot ? root.activeElement : null;
        const rawAriaInvalid = element.getAttribute('aria-invalid')?.trim().toLowerCase() ?? null;
        const ariaInvalid = rawAriaInvalid === null || ['', 'false', 'true', 'grammar', 'spelling'].includes(rawAriaInvalid) ? rawAriaInvalid : 'other';
        const ariaIdentified = ariaInvalid !== null && ariaInvalid !== 'false' && ariaInvalid !== '';
        const ids = [element.getAttribute('aria-describedby') ?? '', ...(ariaIdentified ? [element.getAttribute('aria-errormessage') ?? ''] : [])].join(' ').split(/\s+/);
        const associated = expectedTargets.map(target => !!target?.id && ids.includes(target.id) && (root instanceof Document || root instanceof ShadowRoot) && root.getElementById(target.id) === target);
        const nativeField = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element : null;
        const nativeInvalid = !!nativeField?.willValidate && !nativeField.validity.valid;
        const nativeSubmit = submitTarget instanceof HTMLButtonElement || submitTarget instanceof HTMLInputElement ? submitTarget : null;
        const form = nativeField?.form;
        const submitsForm = nativeSubmit?.type === 'submit' || nativeSubmit?.type === 'image';
        const nativeValidationPossible = nativeInvalid && !!form && !form.noValidate && submitsForm && !nativeSubmit.formNoValidate && nativeSubmit.form === form;
        return { ariaInvalid, nativeInvalid, invalid: nativeInvalid || ariaIdentified, focused: active === element, associated, nativeValidationPossible };
      }, { expectedTargets, submitTarget }, { timeout }));
      const associatedErrors = errorSelectors.filter((_, index) => associated[index]);
      fields.push({ selector: field.selector, ...evidence, associatedErrors });
    }
    return fields;
  } finally {
    await guard.release(...handles);
  }
}
