/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

import type { ElementHandle, Page } from 'playwright';
import { rejectAfterTimeout } from '../utils/timeout.js';

export type FieldEvidence = { selector: string; ariaInvalid: string | null; nativeInvalid: boolean; invalid: boolean; focused: boolean; nativeValidationPossible: boolean; associatedErrors: string[] };
export type FeedbackEvidence = { selector: string; kind: 'error' | 'status'; present: boolean; textPresent: boolean; exposed: boolean; focused: boolean; live: string | null; changed: boolean; textTruncated: boolean };

export async function readFeedback(page: Page, targets: { selector: string }[], remaining: () => number, bounded: <T>(run: () => Promise<T>) => Promise<T>) {
  const result = [];
  for (const target of targets) {
    const locator = page.locator(`css=${target.selector}`);
    const count = await bounded(() => locator.count());
    if (count > 1)
      throw new Error('Feedback selector became ambiguous.');
    if (!count) { result.push({ present: false, text: '', exposed: false, focused: false, live: null, textTruncated: false }); continue; }
    result.push(await bounded(() => locator.evaluate(element => {
      function parentElementAcrossShadow(node: Element) {
        const root = node.getRootNode();
        return node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
      }
      function isExposed(target: Element) {
        const targetStyle = getComputedStyle(target);
        if (targetStyle.visibility === 'hidden' || targetStyle.visibility === 'collapse')
          return false;
        for (let node: Element | null = target; node; node = parentElementAcrossShadow(node)) {
          if (node.getAttribute('aria-hidden')?.toLowerCase() === 'true' || node.hasAttribute('inert') || getComputedStyle(node).display === 'none')
            return false;
        }
        return true;
      }
      const exposed = isExposed(element);
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let text = '';
      let visitedTextNodes = 0;
      let textTruncated = false;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (++visitedTextNodes > 10000) {
          textTruncated = true;
          break;
        }
        if (!node.parentElement || !isExposed(node.parentElement))
          continue;
        const content = node.textContent ?? '';
        const remainingText = 10000 - text.length;
        text += content.slice(0, remainingText);
        if (content.length > remainingText) {
          textTruncated = true;
          break;
        }
      }
      let live: string | null = null;
      for (let node: Element | null = element; node; node = parentElementAcrossShadow(node)) {
        if (live === null) {
          const explicit = node.getAttribute('aria-live')?.trim().toLowerCase();
          const role = node.getAttribute('role')?.trim().toLowerCase();
          if (explicit === 'off' || explicit === 'polite' || explicit === 'assertive')
            live = explicit;
          else if (role === 'alert')
            live = 'assertive';
          else if (role === 'status' || role === 'log')
            live = 'polite';
          else if (role === 'timer' || role === 'marquee')
            live = 'off';
        }
      }
      const root = element.getRootNode();
      const active = root instanceof Document || root instanceof ShadowRoot ? root.activeElement : null;
      return { present: true, text, textTruncated, exposed, focused: !!active && (active === element || element.contains(active)), live };
    }, undefined, { timeout: remaining() })));
  }
  return result;
}

export async function readFields(page: Page, {
  scenarioFields,
  submitSelector,
  expectedFeedback,
  feedback,
  remaining,
  bounded,
}: {
  scenarioFields: { selector: string }[];
  submitSelector: string;
  expectedFeedback: { selector: string; kind: 'error' | 'status' }[];
  feedback: FeedbackEvidence[];
  remaining: () => number;
  bounded: <T>(run: () => Promise<T>) => Promise<T>;
}) {
  const fields: FieldEvidence[] = [];
  const errorTargets = expectedFeedback.filter(target => target.kind === 'error');
  for (const field of scenarioFields) {
    const targets: (ElementHandle<Element> | null)[] = [];
    let submitTarget: ElementHandle<Element> | null = null;
    try {
      const submitLocator = page.locator(`css=${submitSelector}`);
      if (await bounded(() => submitLocator.count()) === 1)
        submitTarget = await bounded(() => submitLocator.elementHandle({ timeout: remaining() }));
      for (const target of errorTargets) {
        const locator = page.locator(`css=${target.selector}`);
        targets.push(await bounded(() => locator.count()) === 1 ? await bounded(() => locator.elementHandle({ timeout: remaining() })) : null);
      }
      const evidence = await bounded(() => page.locator(`css=${field.selector}`).evaluate((element, { expectedTargets, submitTarget }) => {
        const root = element.getRootNode();
        const active = root instanceof Document || root instanceof ShadowRoot ? root.activeElement : null;
        const rawAriaInvalid = element.getAttribute('aria-invalid')?.trim().toLowerCase() ?? null;
        const ariaInvalid = rawAriaInvalid === null || ['', 'false', 'true', 'grammar', 'spelling'].includes(rawAriaInvalid) ? rawAriaInvalid : 'other';
        const nativeInvalid = (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.willValidate && !element.validity.valid;
        const ariaIdentified = ariaInvalid !== null && ariaInvalid !== 'false' && ariaInvalid !== '';
        const ids = [element.getAttribute('aria-describedby') ?? '', ...(ariaIdentified ? [element.getAttribute('aria-errormessage') ?? ''] : [])].join(' ').split(/\s+/);
        const associated = expectedTargets.map(target => !!target && target.getRootNode() === root && !!target.id && ids.includes(target.id) && (root instanceof Document || root instanceof ShadowRoot) && root.getElementById(target.id) === target);
        const nativeField = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element : null;
        const nativeSubmit = submitTarget instanceof HTMLButtonElement || submitTarget instanceof HTMLInputElement ? submitTarget : null;
        const nativeValidationPossible = nativeInvalid && !!nativeField?.form && !nativeField.form.noValidate && !!nativeSubmit && nativeSubmit.type === 'submit' && !nativeSubmit.formNoValidate && nativeSubmit.form === nativeField.form;
        return { ariaInvalid, nativeInvalid, invalid: nativeInvalid || ariaIdentified, focused: active === element, associated, nativeValidationPossible };
      }, { expectedTargets: targets, submitTarget }, { timeout: remaining() }));
      fields.push({ selector: field.selector, ariaInvalid: evidence.ariaInvalid, nativeInvalid: evidence.nativeInvalid, invalid: evidence.invalid, focused: evidence.focused, nativeValidationPossible: evidence.nativeValidationPossible, associatedErrors: errorTargets.filter((_, index) => evidence.associated[index] && feedback.find(point => point.selector === errorTargets[index].selector)?.textPresent).map(target => target.selector) });
    } finally {
      await rejectAfterTimeout(Promise.all([...targets, submitTarget].map(target => target?.dispose())), remaining(), 'Handle cleanup timed out.');
    }
  }
  return fields;
}
