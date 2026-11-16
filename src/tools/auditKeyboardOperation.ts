/**
 * Copyright (c) MCP Accessibility Scanner contributors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { defineTabTool } from './tool.js';
import { reserveReportPath, writeJsonReport } from './report.js';
import { rejectAfterTimeout, rejectOnAbort } from '../utils/timeout.js';
import { typeIntoFocusedElement } from './keyboardInput.js';
import type { Frame } from 'playwright';

const expectationSchema = z.strictObject({
  selector: z.string().min(1).max(500).describe('CSS selector in the main frame, including open shadow roots; must resolve to at most one element. May target a future element.'),
  focused: z.boolean().optional(),
  visible: z.boolean().optional(),
  text: z.string().max(500).optional().describe('Exact trimmed textContent; observed text is not stored in the report.'),
  value: z.string().max(500).optional().describe('Exact native form value or aria-valuenow; observed values are not stored.'),
  expanded: z.boolean().optional(),
  checked: z.union([z.boolean(), z.literal('mixed')]).optional(),
  selected: z.boolean().optional(),
  pressed: z.union([z.boolean(), z.literal('mixed')]).optional(),
  disabled: z.boolean().optional(),
}).refine(expectation => Object.keys(expectation).length > 1, 'Supply at least one expected outcome.');

const auditKeyboardOperationSchema = z.strictObject({
  steps: z.array(z.union([z.strictObject({
    key: z.enum(['Tab', 'Shift+Tab', 'Enter', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape', 'Home', 'End', 'Backspace', 'Delete', 'ControlOrMeta+A']),
    expect: z.array(expectationSchema).min(1).max(10),
  }), z.strictObject({
    text: z.string().min(1).max(500).describe('Type into the currently focused editable in the main frame or an open shadow root. CRLF and CR become Enter; Unicode input may not produce physical key events. Stops if the original editable loses focus or becomes unavailable.'),
    expect: z.array(expectationSchema).min(1).max(10),
  })])).min(1).max(20).describe('Explicit key or text scenario from the current focus. Stops on the first failed or incomplete step; later steps are not run.'),
  timeoutMs: z.number().int().min(0).max(1000).default(300).describe('Observation window for each step\'s expected outcomes, in milliseconds; outcomes are measured at its end. Zero measures immediately.'),
  reportFile: z.string().optional().describe('Output JSON report file name.'),
});

type Expectation = z.output<typeof expectationSchema>;
type Check = { selector: string; property: string; passed: boolean };
type StepResult = { step: number; status: 'not-run' | 'passed' | 'failed' | 'incomplete'; checks: Check[] } & ({ key: string } | { action: 'type'; characterCount: number });

function measureExpectation(elements: Element[], expectation: Expectation): { checks: Check[]; error?: string } {
  if (elements.length > 1)
    return { checks: [], error: 'Selector matches multiple elements.' };
  const element = elements[0];
  let focused = document.activeElement;
  while (focused?.shadowRoot?.activeElement)
    focused = focused.shadowRoot.activeElement;
  const checks: Check[] = [];
  for (const [property, expected] of Object.entries(expectation)) {
    if (property === 'selector')
      continue;
    if (!element) {
      checks.push({ selector: expectation.selector, property, passed: property === 'visible' && expected === false });
      continue;
    }
    let actual: string | boolean | null | undefined;
    if (property === 'focused') {
      actual = focused === element;
    } else if (property === 'visible') {
      const style = getComputedStyle(element);
      actual = style.visibility !== 'hidden' && style.visibility !== 'collapse' && [...element.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
    } else if (property === 'text') {
      actual = element.textContent?.trim() ?? '';
    } else if (property === 'value') {
      actual = element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement ? element.value : element.getAttribute('aria-valuenow');
    } else if (property === 'checked' && element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) {
      actual = element.indeterminate ? 'mixed' : element.checked;
    } else if (property === 'selected' && element instanceof HTMLOptionElement) {
      actual = element.selected;
    } else if (property === 'disabled' && (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement || element instanceof HTMLOptionElement || element instanceof HTMLOptGroupElement || element instanceof HTMLFieldSetElement)) {
      actual = element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true';
    } else {
      const attribute = element.getAttribute(`aria-${property}`);
      actual = null;
      if (attribute === 'true' || attribute === 'false')
        actual = attribute === 'true';
      else if (attribute === 'mixed' && (property === 'checked' || property === 'pressed'))
        actual = 'mixed';
    }
    if (actual === null || actual === undefined)
      return { checks, error: `The ${property} state is absent or unsupported on the selected element.` };
    checks.push({ selector: expectation.selector, property, passed: actual === expected });
  }
  return { checks };
}

const auditKeyboardOperation = defineTabTool({
  capability: 'core',
  schema: {
    name: 'audit_keyboard_operation',
    title: 'Audit keyboard operation',
    description: 'Run a bounded caller-supplied keyboard scenario from current focus using real keys and text input, then verify explicit focus, visibility, text, value, or native/ARIA state outcomes. Text requires one continuously focused editable; supplied text is not reported. Main frame and open shadow roots only; 30-second scenario budget. May activate controls, submit forms, or change data; never restores state. Stops on failure, cancellation, navigation, popup, or browser modal. Interrupted in-flight keys cannot be undone. Results cover only the supplied scenario, not WCAG conformance.',
    inputSchema: auditKeyboardOperationSchema,
    type: 'destructive',
    idempotent: false,
  },
  handle: async (tab, params, response, signal) => {
    const reportPath = await reserveReportPath(tab.context, response, params.reportFile, 'audit-keyboard-operation');
    const page = tab.page;
    const interruption = new AbortController();
    const operationSignal = signal ? AbortSignal.any([signal, interruption.signal]) : interruption.signal;
    let reason: string | null = null;
    const stop = (message: string) => {
      reason ??= message;
      interruption.abort(new Error(message));
    };
    const budgetTimer = setTimeout(() => stop('The 30-second scenario budget was exhausted.'), 30_000);
    budgetTimer.unref?.();
    const onNavigation = (frame: Frame) => {
      if (frame === page.mainFrame())
        stop('Main-frame navigation invalidated the scenario.');
    };
    const onModal = () => stop('A browser modal interrupted the scenario.');
    const onClose = () => stop('The page closed during the scenario.');
    const onPopup = () => stop('A new page interrupted the scenario.');
    page.on('framenavigated', onNavigation);
    page.on('dialog', onModal);
    page.on('filechooser', onModal);
    page.on('close', onClose);
    page.on('popup', onPopup);
    const steps = params.steps.map((step, index): StepResult => ({ step: index + 1, ...('key' in step ? { key: step.key } : { action: 'type', characterCount: [...step.text].length }), status: 'not-run', checks: [] }));
    let status: 'passed' | 'failed' | 'incomplete' = 'passed';
    let phase = 'Selector validation';
    let current: StepResult | undefined;
    const checkInterrupted = () => {
      operationSignal.throwIfAborted();
      if (tab.modalStates().length)
        throw new Error('A browser modal interrupted the scenario.');
    };
    const bounded = async <T>(run: () => Promise<T>) => {
      checkInterrupted();
      const result = await rejectOnAbort(() => rejectAfterTimeout(run(), 2000, 'Operation timed out.'), operationSignal);
      checkInterrupted();
      return result;
    };
    try {
      checkInterrupted();
      for (const selector of new Set(params.steps.flatMap(step => step.expect.map(expectation => expectation.selector))))
        await bounded(() => page.locator(`css=${selector}`).count());
      for (const [index, step] of params.steps.entries()) {
        checkInterrupted();
        current = steps[index];
        current.status = 'incomplete';
        phase = 'Keyboard action';
        if ('key' in step) {
          await bounded(() => page.keyboard.press(step.key));
        } else {
          const focused = await bounded(() => page.evaluateHandle(() => {
            let element = document.activeElement;
            while (element?.shadowRoot?.activeElement)
              element = element.shadowRoot.activeElement;
            return element;
          }));
          try {
            const target = focused.asElement();
            if (!target)
              throw new Error('No editable target is focused.');
            await typeIntoFocusedElement(page, target, step.text, bounded);
          } finally {
            await rejectAfterTimeout(focused.dispose(), 2000, 'Handle cleanup timed out.');
          }
        }
        phase = 'Expectation measurement';
        if (params.timeoutMs > 0)
          await delay(params.timeoutMs, undefined, { signal: operationSignal });
        checkInterrupted();
        const checks: Check[] = [];
        for (const expectation of step.expect) {
          checkInterrupted();
          const measurement = await bounded(() => page.locator(`css=${expectation.selector}`).evaluateAll(measureExpectation, expectation));
          checkInterrupted();
          if (measurement.error) {
            reason = measurement.error;
            throw new Error(measurement.error);
          }
          checks.push(...measurement.checks);
        }
        current.checks = checks;
        checkInterrupted();
        current.status = current.checks.every(check => check.passed) ? 'passed' : 'failed';
        if (current.status === 'failed') {
          status = 'failed';
          break;
        }
      }
    } catch {
      status = 'incomplete';
      reason ??= signal?.aborted ? 'The scenario was cancelled.' : `${phase} failed or could not be completed within its bound.`;
      if (current)
        current.status = 'incomplete';
    } finally {
      clearTimeout(budgetTimer);
      page.off('framenavigated', onNavigation);
      page.off('dialog', onModal);
      page.off('filechooser', onModal);
      page.off('close', onClose);
      page.off('popup', onPopup);
    }
    const findings = steps.flatMap(step => step.status === 'failed' ? step.checks.filter(check => !check.passed).map(check => ({ step: step.step, selector: check.selector, property: check.property, problem: 'The expected keyboard outcome was not observed.' })) : []);
    const report = { version: 'v1', status, reason, scope: 'Caller-supplied scenario in the main frame and open shadow roots; not a conformance assessment. Page state is not restored.', steps, findings };
    const resource = await writeJsonReport(response, reportPath, report, {
      name: 'audit-keyboard-operation-report',
      title: 'Keyboard operation scenario report',
      description: 'Expected-outcome checks for a caller-supplied keyboard scenario.',
    });
    response.setStructuredContent({ kind: 'audit_keyboard_operation', ...report, report: resource, reportUri: resource.uri });
    const summary = `Keyboard scenario: ${status}. ${steps.filter(step => step.status === 'passed').length}/${steps.length} steps passed; ${findings.length} finding(s). Later steps are not run after a failed or incomplete step. Page state is not restored; interrupted in-flight keys cannot be undone. Results cover only this scenario, not conformance. JSON report: ${resource.path}`;
    if (status === 'incomplete')
      response.addError(`${summary}\n${reason}`);
    else
      response.addResult(summary);
  },
});

export default [auditKeyboardOperation];
