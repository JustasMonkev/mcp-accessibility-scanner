/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

import { setTimeout as delay } from 'node:timers/promises';
import type { ElementHandle, Frame, Page } from 'playwright';
import { z } from 'zod';
import { defineTabTool } from './tool.js';
import { reserveReportPath, writeJsonReport } from './report.js';
import { rejectAfterTimeout, rejectOnAbort } from '../utils/timeout.js';

const selector = z.string().trim().min(1).max(500);
const inputSchema = z.object({
  fields: z.array(z.object({ selector, value: z.string().max(10000) })).min(1).max(20),
  submitSelector: selector,
  expectedFeedback: z.array(z.object({ selector, kind: z.enum(['error', 'status']) })).min(1).max(20),
  timeoutMs: z.number().int().min(100).max(10000).default(3000).describe('Post-click observation window in milliseconds. The entire scenario is bounded by this window plus 5 seconds; each action is awaited with a maximum 1-second timeout.'),
  reportFile: z.string().optional(),
});

type FieldEvidence = { selector: string; ariaInvalid: string | null; nativeInvalid: boolean; invalid: boolean; focused: boolean; nativeValidationPossible: boolean; associatedErrors: string[] };
type FeedbackEvidence = { selector: string; kind: 'error' | 'status'; present: boolean; textPresent: boolean; exposed: boolean; focused: boolean; live: string | null; changed: boolean; textTruncated: boolean };

async function readFeedback(page: Page, targets: { selector: string }[], remaining: () => number, bounded: <T>(run: () => Promise<T>) => Promise<T>) {
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

const auditFormValidation = defineTabTool({
  capability: 'core',
  schema: {
    name: 'audit_form_validation',
    title: 'Audit explicit form validation scenario',
    description: 'Fill caller-specified invalid text values and click the explicit submit target, then inspect expected errors/status feedback. Mutates and may submit the page; never discovers forms. Main document and open shadow roots only. Does not certify screen reader announcements.',
    inputSchema,
    type: 'destructive',
    idempotent: false,
  },
  handle: async (tab, params, response, signal) => {
    const reportPath = await reserveReportPath(tab.context, response, params.reportFile, 'audit-form-validation');
    const deadline = Date.now() + params.timeoutMs + 5000;
    let navigated = false;
    let popupOpened = false;
    const onPopup = () => { popupOpened = true; };
    const onNavigation = (frame: Frame) => {
      if (frame === tab.page.mainFrame())
        navigated = true;
    };
    const interruption = () => {
      if (signal?.aborted)
        return 'aborted';
      if (tab.modalStates().length)
        return 'modal';
      if (navigated)
        return 'navigation';
      if (popupOpened)
        return 'popup';
      if (tab.page.isClosed())
        return 'page-closed';
      return null;
    };
    const remaining = () => Math.max(1, Math.min(1000, deadline - Date.now()));
    const bounded = <T>(run: () => Promise<T>) => {
      const reason = interruption();
      if (reason)
        throw new Error(reason);
      return rejectOnAbort(() => rejectAfterTimeout(run(), remaining(), 'time-budget'), signal);
    };
    const incomplete: string[] = [];
    const findings: { check: string; selector: string; evidence: string }[] = [];
    let submitted = false;
    let submitAttempted = false;
    const fields: FieldEvidence[] = [];
    let feedback: FeedbackEvidence[] = [];
    let actionsStarted = false;
    tab.page.on('framenavigated', onNavigation);
    tab.page.on('popup', onPopup);
    const requireScenario = () => {
      const reason = interruption();
      if (reason)
        throw new Error(reason);
      if (Date.now() >= deadline)
        throw new Error('time-budget');
    };
    try {
      requireScenario();
      for (const target of [...params.fields, { selector: params.submitSelector }, ...params.expectedFeedback]) {
        requireScenario();
        const valid = await bounded(() => tab.page.evaluate(css => {
          try { document.querySelector(css); return true; } catch { return false; }
        }, target.selector));
        if (!valid)
          throw new Error('Invalid CSS selector in form audit scenario.');
      }
      for (const field of params.fields) {
        requireScenario();
        const locator = tab.page.locator(`css=${field.selector}`);
        if (await bounded(() => locator.count()) !== 1)
          throw new Error('Each field selector must match exactly one element.');
        const editable = await bounded(() => locator.evaluate(element => {
          if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement))
            return false;
          return !element.matches(':disabled') && !element.readOnly && (!(element instanceof HTMLInputElement) || ['text', 'email', 'url', 'tel', 'password', 'search'].includes(element.type));
        }, undefined, { timeout: remaining() }));
        if (!editable)
          throw new Error('Fields must be enabled, editable text inputs or textareas.');
      }
      if (await bounded(() => tab.page.locator(`css=${params.submitSelector}`).count()) !== 1)
        throw new Error('Submit selector must match exactly one element.');
      for (const target of params.expectedFeedback) {
        if (await bounded(() => tab.page.locator(`css=${target.selector}`).count()) > 1)
          throw new Error('Feedback selectors must match at most one element.');
      }
      for (const field of params.fields) {
        requireScenario();
        actionsStarted = true;
        await tab.page.locator(`css=${field.selector}`).fill(field.value, { timeout: remaining() });
      }
      requireScenario();
      const baseline = await readFeedback(tab.page, params.expectedFeedback, remaining, bounded);
      if (baseline.some(point => point.textTruncated))
        incomplete.push('feedback-text-truncated');
      requireScenario();
      submitAttempted = true;
      await tab.page.locator(`css=${params.submitSelector}`).click({ timeout: remaining(), noWaitAfter: true });
      submitted = true;
      const requestedObservationDeadline = Date.now() + params.timeoutMs;
      const observationDeadline = Math.min(requestedObservationDeadline, deadline - 1000);
      if (observationDeadline < requestedObservationDeadline)
        incomplete.push('observation-window-truncated');
      for (let sample = 0; sample <= 200; sample++) {
        requireScenario();
        const current = await readFeedback(tab.page, params.expectedFeedback, remaining, bounded);
        if (current.some(point => point.textTruncated) && !incomplete.includes('feedback-text-truncated'))
          incomplete.push('feedback-text-truncated');
        feedback = current.map((point, index) => ({
          selector: params.expectedFeedback[index].selector,
          kind: params.expectedFeedback[index].kind,
          present: point.present,
          textPresent: point.text.trim().length > 0,
          exposed: point.exposed,
          focused: point.focused,
          live: point.live,
          textTruncated: point.textTruncated,
          changed: point.present && (point.text !== baseline[index].text || point.exposed !== baseline[index].exposed || !baseline[index].present),
        }));
        if (Date.now() >= observationDeadline)
          break;
        await delay(Math.min(50, observationDeadline - Date.now()), undefined, { signal });
      }
      requireScenario();
      const errorTargets = params.expectedFeedback.filter(target => target.kind === 'error');
      const focusedSummary = feedback.some(point => point.kind === 'error' && point.exposed && point.textPresent && point.focused);
      for (const field of params.fields) {
        requireScenario();
        const targets: (ElementHandle<Element> | null)[] = [];
        let submitTarget: ElementHandle<Element> | null = null;
        try {
          const submitLocator = tab.page.locator(`css=${params.submitSelector}`);
          if (await bounded(() => submitLocator.count()) === 1)
            submitTarget = await bounded(() => submitLocator.elementHandle({ timeout: remaining() }));
          for (const target of errorTargets) {
            const locator = tab.page.locator(`css=${target.selector}`);
            targets.push(await bounded(() => locator.count()) === 1 ? await bounded(() => locator.elementHandle({ timeout: remaining() })) : null);
          }
          const evidence = await bounded(() => tab.page.locator(`css=${field.selector}`).evaluate((element, { expectedTargets, submitTarget }) => {
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
      requireScenario();
      for (const field of fields) {
        if (!field.invalid && !field.associatedErrors.length && !focusedSummary)
          findings.push({ check: 'invalid-field-not-identified', selector: field.selector, evidence: 'No native or ARIA invalidity, expected associated error text, or focused error summary was observed. Review error identification in context; this is a semantic gap, not a conformance verdict.' });
        if (!field.nativeValidationPossible && !field.associatedErrors.length && !focusedSummary)
          findings.push({ check: 'error-not-associated', selector: field.selector, evidence: 'No association to a caller-designated error, focused error summary, or possible browser-managed native validation route.' });
      }
      const nativeOnly = fields.every(field => field.nativeValidationPossible);
      for (const point of feedback) {
        if (point.kind === 'error' && nativeOnly)
          continue;
        if (!point.present || !point.textPresent || !point.exposed)
          findings.push({ check: 'feedback-not-exposed', selector: point.selector, evidence: 'Expected feedback was absent, empty, hidden, or aria-hidden at the end of observation.' });
        if (point.kind === 'status' && !(point.exposed && point.textPresent && (point.focused || point.changed && (point.live === 'polite' || point.live === 'assertive'))))
          findings.push({ check: 'status-not-programmatic', selector: point.selector, evidence: 'No focused status or changed, exposed feedback in an effective live region was observed.' });
      }
    } catch (error) {
      const reason = interruption();
      if (reason)
        incomplete.push(reason);
      else if (error instanceof Error && ['time-budget', 'aborted'].includes(error.message))
        incomplete.push(error.message);
      else if (!actionsStarted)
        throw new Error('Form audit preflight or field filling failed; no submission was attempted. Verify CSS selectors and editable fields.');
      else
        incomplete.push('scenario-action-or-observation-failed');
    } finally {
      tab.page.off('framenavigated', onNavigation);
      tab.page.off('popup', onPopup);
    }
    const report = {
      version: 'v1',
      outcome: incomplete.length ? 'incomplete' : 'completed',
      submitAttempted,
      submitTriggerCompleted: submitted,
      coverage: 'Caller-designated text fields and feedback in the main frame, including open shadow roots; sampled DOM evidence only.',
      observed: { fields, feedback },
      findings: incomplete.length ? [] : findings,
      interpretation: 'Findings describe observed semantic gaps in this scenario, not WCAG conformance failures.',
      incomplete,
      manualReview: ['Confirm native browser validation feedback when nativeValidationPossible is true; invalid event cancellation and tooltip rendering are not certified.', 'Verify actual screen reader announcement timing and content; DOM semantics do not certify announcements.', 'Review error wording, correction suggestions, and whether a focused summary identifies each invalid field.', 'Only the explicit scenario was exercised; other fields, interactions, frames, and transient feedback may need testing.'],
    };
    const resource = await writeJsonReport(response, reportPath, report, { name: 'audit-form-validation-report', title: 'Form validation audit', description: 'Observed form error associations, dynamic feedback semantics, and focus evidence; no submitted values or feedback text.' });
    response.setStructuredContent({ kind: 'audit_form_validation', report: resource, outcome: report.outcome, summary: { fieldCount: fields.length, feedbackCount: feedback.length, findingCount: report.findings.length, incomplete }, reportUri: resource.uri });
    response.addResult(`Form validation audit: ${report.outcome}. Findings: ${report.findings.length}. Manual screen reader and error suggestion review required.\nJSON report: ${resource.path}`);
  },
});

export default [auditFormValidation];
