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
import { readFeedback, readFields, type FieldEvidence, type FeedbackEvidence } from './formValidationMeasurement.js';
import { assertFocusedEditable, typeIntoFocusedElement } from './keyboardInput.js';

const selector = z.string().trim().min(1).max(500);
const inputSchema = z.object({
  fields: z.array(z.object({ selector, value: z.string().max(10000) })).min(1).max(20),
  submitSelector: selector,
  expectedFeedback: z.array(z.object({ selector, kind: z.enum(['error', 'status']) })).min(1).max(20),
  timeoutMs: z.number().int().min(100).max(10000).default(3000).describe('Post-submit observation window in milliseconds. Keyboard setup/actions have a 30-second budget; direct scenarios retain this window plus 5 seconds. Each operation has a maximum 1-second timeout.'),
  interactionMode: z.enum(['keyboard', 'direct']).default('keyboard').describe('Keyboard follows Tab order from current focus (at most 50 Tabs per target), replaces text with guarded keystrokes, and submits with Enter. Direct uses fill/click.'),
  reportFile: z.string().optional(),
});

type ScenarioField = { selector: string; value: string };
type Bounded = <T>(run: () => Promise<T>) => Promise<T>;

async function resolveTarget(page: Page, selector: string, remaining: () => number, bounded: Bounded) {
  const locator = page.locator(`css=${selector}`);
  if (await bounded(() => locator.count()) !== 1)
    throw new Error('target-not-reached');
  const target = await bounded(() => locator.elementHandle({ timeout: remaining() }));
  if (!target)
    throw new Error('target-not-reached');
  return target;
}

function isFocused(target: ElementHandle<Element>, bounded: Bounded) {
  return bounded(() => target.evaluate(element => {
    const root = element.getRootNode();
    return element.isConnected && (root instanceof Document || root instanceof ShadowRoot) && root.activeElement === element;
  }));
}

async function reachWithTabs(page: Page, selector: string, remaining: () => number, bounded: Bounded) {
  for (let tabs = 0; tabs <= 50; tabs++) {
    const target = await resolveTarget(page, selector, remaining, bounded);
    if (await isFocused(target, bounded))
      return target;
    await target.dispose();
    if (tabs < 50)
      await bounded(() => page.keyboard.press('Tab'));
  }
  throw new Error('target-not-reached');
}

async function verifyFieldValue(target: ElementHandle<Element>, expected: string, bounded: Bounded) {
  const matches = await bounded(() => target.evaluate((element, expected) => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) || !element.isConnected)
      return false;
    return element.value === (element instanceof HTMLTextAreaElement ? expected.replace(/\r\n?/g, '\n') : expected);
  }, expected));
  if (!matches)
    throw new Error('field-value-mismatch');
}

async function enterFieldsWithKeyboard(page: Page, fields: ScenarioField[], remaining: () => number, bounded: Bounded) {
  for (const field of fields) {
    const target = await reachWithTabs(page, field.selector, remaining, bounded);
    try {
      await assertFocusedEditable(target, bounded);
      await bounded(() => page.keyboard.press('ControlOrMeta+A'));
      await assertFocusedEditable(target, bounded);
      await bounded(() => page.keyboard.press('Backspace'));
      await assertFocusedEditable(target, bounded);
      await typeIntoFocusedElement(page, target, field.value, bounded);
      await verifyFieldValue(target, field.value, bounded);
    } finally {
      await target.dispose();
    }
  }
}

async function verifyFieldValues(page: Page, fields: ScenarioField[], remaining: () => number, bounded: Bounded) {
  for (const field of fields) {
    const target = await resolveTarget(page, field.selector, remaining, bounded);
    try {
      await verifyFieldValue(target, field.value, bounded);
    } finally {
      await target.dispose();
    }
  }
}

async function validateScenario(page: Page, params: z.infer<typeof inputSchema>, remaining: () => number, bounded: Bounded) {
  for (const target of [...params.fields, { selector: params.submitSelector }, ...params.expectedFeedback]) {
    const valid = await bounded(() => page.evaluate(css => {
      try { document.querySelector(css); return true; } catch { return false; }
    }, target.selector));
    if (!valid)
      throw new Error('Invalid CSS selector in form audit scenario.');
  }
  for (const field of params.fields) {
    const locator = page.locator(`css=${field.selector}`);
    if (await bounded(() => locator.count()) !== 1)
      throw new Error('Each field selector must match exactly one element.');
    if (params.interactionMode === 'keyboard' && /[\r\n]/.test(field.value)) {
      const isTextArea = await bounded(() => locator.evaluate(element => element instanceof HTMLTextAreaElement));
      if (!isTextArea)
        throw new Error('Single-line keyboard form values cannot contain CR or LF.');
    }
    const editable = await bounded(() => locator.evaluate(element => {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement))
        return false;
      return !element.matches(':disabled') && !element.readOnly && (!(element instanceof HTMLInputElement) || ['text', 'email', 'url', 'tel', 'password', 'search'].includes(element.type));
    }, undefined, { timeout: remaining() }));
    if (!editable)
      throw new Error('Fields must be enabled, editable text inputs or textareas.');
  }
  if (await bounded(() => page.locator(`css=${params.submitSelector}`).count()) !== 1)
    throw new Error('Submit selector must match exactly one element.');
  for (const target of params.expectedFeedback) {
    if (await bounded(() => page.locator(`css=${target.selector}`).count()) > 1)
      throw new Error('Feedback selectors must match at most one element.');
  }
}

function findSemanticGaps(fields: FieldEvidence[], feedback: FeedbackEvidence[]) {
  const findings: { check: string; selector: string; evidence: string }[] = [];
  const focusedSummary = feedback.some(point => point.kind === 'error' && point.exposed && point.textPresent && point.focused);
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
  return findings;
}

const auditFormValidation = defineTabTool({
  capability: 'core',
  schema: {
    name: 'audit_form_validation',
    title: 'Audit explicit form validation scenario',
    description: 'Enter caller-specified invalid text values via keyboard by default (direct fill/click opt-in), then inspect expected errors/status feedback. Mutates and may submit the page; never discovers forms. Main document and open shadow roots only. Does not certify screen reader announcements.',
    inputSchema,
    type: 'destructive',
    idempotent: false,
  },
  handle: async (tab, params, response, signal) => {
    const reportPath = await reserveReportPath(tab.context, response, params.reportFile, 'audit-form-validation');
    let deadline = Date.now() + (params.interactionMode === 'keyboard' ? 30000 : params.timeoutMs + 5000);
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
      requireScenario();
      return rejectOnAbort(() => rejectAfterTimeout(run(), remaining(), 'time-budget'), signal);
    };
    const incomplete: string[] = [];
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
      await validateScenario(tab.page, params, remaining, bounded);
      actionsStarted = true;
      if (params.interactionMode === 'keyboard') {
        await enterFieldsWithKeyboard(tab.page, params.fields, remaining, bounded);
      } else {
        for (const field of params.fields)
          await bounded(() => tab.page.locator(`css=${field.selector}`).fill(field.value, { timeout: remaining() }));
      }
      requireScenario();
      const baseline = await readFeedback(tab.page, params.expectedFeedback, remaining, bounded);
      if (baseline.some(point => point.textTruncated))
        incomplete.push('feedback-text-truncated');
      requireScenario();
      if (params.interactionMode === 'keyboard') {
        const target = await reachWithTabs(tab.page, params.submitSelector, remaining, bounded);
        try {
          await verifyFieldValues(tab.page, params.fields, remaining, bounded);
          if (!await isFocused(target, bounded))
            throw new Error('focus-changed');
          submitAttempted = true;
          await bounded(() => tab.page.keyboard.press('Enter'));
        } finally {
          await target.dispose();
        }
      } else {
        submitAttempted = true;
        await bounded(() => tab.page.locator(`css=${params.submitSelector}`).click({ timeout: remaining(), noWaitAfter: true }));
      }
      submitted = true;
      const requestedObservationDeadline = Date.now() + params.timeoutMs;
      if (params.interactionMode === 'keyboard')
        deadline = requestedObservationDeadline + 1000;
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
      fields.push(...await readFields(tab.page, {
        scenarioFields: params.fields,
        submitSelector: params.submitSelector,
        expectedFeedback: params.expectedFeedback,
        feedback,
        remaining,
        bounded,
      }));
    } catch (error) {
      const reason = interruption();
      if (reason)
        incomplete.push(reason);
      else if (error instanceof Error && ['time-budget', 'aborted', 'target-not-reached', 'field-value-mismatch', 'focus-changed'].includes(error.message))
        incomplete.push(error.message);
      else if (!actionsStarted)
        throw new Error('Form audit preflight or field filling failed; no submission was attempted. Verify CSS selectors and editable fields; single-line keyboard values cannot contain CR or LF.');
      else
        incomplete.push('scenario-action-or-observation-failed');
    } finally {
      tab.page.off('framenavigated', onNavigation);
      tab.page.off('popup', onPopup);
    }
    const report = {
      version: 'v1',
      interactionMode: params.interactionMode,
      outcome: incomplete.length ? 'incomplete' : 'completed',
      submitAttempted,
      submitTriggerCompleted: submitted,
      coverage: 'Caller-designated text fields and feedback in the main frame, including open shadow roots; sampled DOM evidence only.',
      observed: { fields, feedback },
      findings: incomplete.length ? [] : findSemanticGaps(fields, feedback),
      interpretation: 'Findings describe observed semantic gaps in this scenario, not WCAG conformance failures.',
      incomplete,
      manualReview: ['Confirm native browser validation feedback when nativeValidationPossible is true; invalid event cancellation and tooltip rendering are not certified.', 'Verify actual screen reader announcement timing and content; DOM semantics do not certify announcements.', 'Review error wording, correction suggestions, and whether a focused summary identifies each invalid field.', 'Only the explicit scenario was exercised; other fields, interactions, frames, and transient feedback may need testing.'],
    };
    const resource = await writeJsonReport(response, reportPath, report, { name: 'audit-form-validation-report', title: 'Form validation audit', description: 'Observed form error associations, dynamic feedback semantics, and focus evidence; no submitted values or feedback text.' });
    response.setStructuredContent({ kind: 'audit_form_validation', interactionMode: params.interactionMode, report: resource, outcome: report.outcome, summary: { fieldCount: fields.length, feedbackCount: feedback.length, findingCount: report.findings.length, incomplete }, reportUri: resource.uri });
    response.addResult(`Form validation audit: ${report.outcome}. Findings: ${report.findings.length}. Manual screen reader and error suggestion review required.\nJSON report: ${resource.path}`);
  },
});

export default [auditFormValidation];
