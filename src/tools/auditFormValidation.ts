/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

import { setTimeout as delay } from 'node:timers/promises';
import type { ElementHandle, Page } from 'playwright';
import { z } from 'zod';
import { defineTabTool } from './tool.js';
import { reserveReportPath, writeJsonReport } from './report.js';
import { readFeedback, readFields, uniqueElement, type FieldEvidence, type FeedbackEvidence } from './formValidationMeasurement.js';
import { assertFocusedEditable, typeIntoFocusedElement } from './keyboardInput.js';
import { scenarioGuard, type Bounded, type ScenarioGuard } from './scenarioGuard.js';

const selector = z.string().trim().min(1).max(500);
const inputSchema = z.object({
  fields: z.array(z.object({
    selector: selector.describe('CSS selector for one enabled text input or textarea in the main frame or an open shadow root.'),
    value: z.string().max(10000).describe('Text to enter; it is not stored in the report.'),
  })).min(1).max(20).describe('Fields to fill, in order.'),
  submitSelector: selector.describe('CSS selector for the single control that submits the form.'),
  expectedFeedback: z.array(z.object({
    selector: selector.describe('CSS selector for the feedback element; must match at most one element and may target a future element.'),
    kind: z.enum(['error', 'status']).describe('Whether the feedback is a field error or a status message.'),
  })).min(1).max(20).describe('Feedback to inspect after submission.'),
  timeoutMs: z.number().int().min(100).max(10000).default(3000).describe('Post-submit observation window in milliseconds; feedback is read at its end. Setup has a 30-second budget in keyboard mode, or this window plus 5 seconds in direct mode.'),
  interactionMode: z.enum(['keyboard', 'direct']).default('keyboard').describe('Keyboard follows Tab order from current focus (at most 50 Tabs per target), replaces text with guarded keystrokes, and submits with Enter. Direct uses fill/click.'),
  reportFile: z.string().optional().describe('Output JSON report file name.'),
});

type ScenarioField = { selector: string; value: string };

function focusedTarget(elements: Element[]) {
  if (elements.length !== 1)
    return null;
  const root = elements[0].getRootNode();
  return elements[0].isConnected && (root instanceof Document || root instanceof ShadowRoot) && root.activeElement === elements[0];
}

async function reachWithTabs(page: Page, selector: string, guard: ScenarioGuard) {
  const locator = page.locator(`css=${selector}`);
  for (let tabs = 0; tabs <= 50; tabs++) {
    const focused = await guard.bounded(() => locator.evaluateAll(focusedTarget));
    if (focused === null)
      break;
    if (focused) {
      const target = await uniqueElement(page, selector, guard);
      if (target)
        return target;
      break;
    }
    if (tabs < 50)
      await guard.bounded(() => page.keyboard.press('Tab'));
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

async function enterFieldsWithKeyboard(page: Page, fields: ScenarioField[], guard: ScenarioGuard) {
  const { bounded } = guard;
  for (const field of fields) {
    const target = await reachWithTabs(page, field.selector, guard);
    try {
      await assertFocusedEditable(target, bounded);
      await bounded(() => page.keyboard.press('ControlOrMeta+A'));
      await assertFocusedEditable(target, bounded);
      await bounded(() => page.keyboard.press('Backspace'));
      await typeIntoFocusedElement(page, target, field.value, bounded);
      await verifyFieldValue(target, field.value, bounded);
    } finally {
      await guard.release(target);
    }
  }
}

async function verifyFieldValues(page: Page, fields: ScenarioField[], guard: ScenarioGuard) {
  for (const field of fields) {
    const target = await uniqueElement(page, field.selector, guard);
    if (!target)
      throw new Error('target-not-reached');
    try {
      await verifyFieldValue(target, field.value, guard.bounded);
    } finally {
      await guard.release(target);
    }
  }
}

async function validateScenario(page: Page, params: z.output<typeof inputSchema>, bounded: Bounded) {
  const selectors = [params.submitSelector, ...[...params.fields, ...params.expectedFeedback].map(target => target.selector)];
  await bounded(() => page.evaluate(selectors => {
    const fragment = document.createDocumentFragment();
    for (const selector of selectors)
      fragment.querySelector(selector);
  }, selectors));
  for (const field of params.fields) {
    const problem = await bounded(() => page.locator(`css=${field.selector}`).evaluateAll((elements, multiline) => {
      if (elements.length !== 1)
        return 'Each field selector must match exactly one element.';
      const element = elements[0];
      if (multiline && !(element instanceof HTMLTextAreaElement))
        return 'Single-line keyboard form values cannot contain CR or LF.';
      const textField = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement && ['text', 'email', 'url', 'tel', 'password', 'search'].includes(element.type);
      if (!textField || element.matches(':disabled') || element.readOnly)
        return 'Fields must be enabled, editable text inputs or textareas.';
      return null;
    }, params.interactionMode === 'keyboard' && /[\r\n]/.test(field.value)));
    if (problem)
      throw new Error(problem);
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
    const hasErrorRoute = field.associatedErrors.length > 0 || focusedSummary;
    if (!field.invalid && !hasErrorRoute)
      findings.push({ check: 'invalid-field-not-identified', selector: field.selector, evidence: 'No native or ARIA invalidity, expected associated error text, or focused error summary was observed. Review error identification in context; this is a semantic gap, not a conformance verdict.' });
    if (!field.nativeValidationPossible && !hasErrorRoute)
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
  exclusive: true,
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
    const page = tab.page;
    const keyboard = params.interactionMode === 'keyboard';
    const guard = scenarioGuard(tab, signal, keyboard ? 30000 : params.timeoutMs + 5000, 1000);
    const { bounded } = guard;
    const incomplete: string[] = [];
    let submitted = false;
    let submitAttempted = false;
    let fields: FieldEvidence[] = [];
    let feedback: FeedbackEvidence[] = [];
    let actionsStarted = false;
    try {
      await validateScenario(page, params, bounded);
      actionsStarted = true;
      if (keyboard) {
        await enterFieldsWithKeyboard(page, params.fields, guard);
      } else {
        for (const field of params.fields)
          await bounded(timeout => page.locator(`css=${field.selector}`).fill(field.value, { timeout }));
      }
      const baseline = await readFeedback(page, params.expectedFeedback, bounded);
      if (baseline.some(point => point.textTruncated))
        incomplete.push('feedback-text-truncated');
      const submitTarget = keyboard ? await reachWithTabs(page, params.submitSelector, guard) : null;
      try {
        await verifyFieldValues(page, params.fields, guard);
        if (submitTarget && !await bounded(() => page.evaluate(focusedTarget, [submitTarget])))
          throw new Error('focus-changed');
        await bounded(timeout => {
          submitAttempted = true;
          return submitTarget ? page.keyboard.press('Enter') : page.locator(`css=${params.submitSelector}`).click({ timeout, noWaitAfter: true });
        });
        submitted = true;
      } finally {
        if (submitTarget)
          await guard.release(submitTarget);
      }
      if (keyboard)
        guard.setBudget(params.timeoutMs + 1000);
      const observationMs = keyboard ? params.timeoutMs : Math.min(params.timeoutMs, Math.max(0, guard.remaining() - 1000));
      if (observationMs < params.timeoutMs)
        incomplete.push('observation-window-truncated');
      await delay(observationMs, undefined, { signal: guard.signal });
      const current = await readFeedback(page, params.expectedFeedback, bounded);
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
      fields = await readFields(page, params, feedback, guard);
    } catch (error) {
      const reason = guard.reason() ?? (error instanceof Error && ['time-budget', 'target-not-reached', 'field-value-mismatch', 'focus-changed'].includes(error.message) ? error.message : undefined);
      if (reason)
        incomplete.push(reason);
      else if (!actionsStarted)
        throw error;
      else
        incomplete.push('scenario-action-or-observation-failed');
    } finally {
      guard.dispose();
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
