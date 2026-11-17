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
import { typeIntoFocusedElement } from './keyboardInput.js';
import { scenarioGuard, type Interruption } from './scenarioGuard.js';

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

const interruptionReasons: Record<Interruption, string> = {
  'aborted': 'The scenario was cancelled.',
  'time-budget': 'The 30-second scenario budget was exhausted.',
  'navigation': 'Main-frame navigation invalidated the scenario.',
  'modal': 'A browser modal interrupted the scenario.',
  'page-closed': 'The page closed during the scenario.',
  'popup': 'A new page interrupted the scenario.',
};

function measureExpectation(elements: Element[], expectation: Expectation): { checks: Check[]; error?: string } {
  if (elements.length > 1)
    return { checks: [], error: 'Selector matches multiple elements.' };
  const { selector, ...states } = expectation;
  const entries = Object.entries(states);
  const element = elements[0];
  if (!element)
    return { checks: entries.map(([property, expected]) => ({ selector, property, passed: property === 'visible' && expected === false })) };

  let focused = document.activeElement;
  while (focused?.shadowRoot?.activeElement)
    focused = focused.shadowRoot.activeElement;
  const disableableElements = [HTMLButtonElement, HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, HTMLOptionElement, HTMLOptGroupElement, HTMLFieldSetElement];
  const readNative = new Map<string, () => string | boolean | null | undefined>([
    ['focused', () => focused === element],
    ['visible', () => element.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true }) && [...element.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)],
    ['text', () => element.textContent?.trim() ?? ''],
    ['value', () => element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement ? element.value : element.getAttribute('aria-valuenow')],
    ['checked', () => {
      if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type))
        return element.indeterminate ? 'mixed' : element.checked;
    }],
    ['selected', () => element instanceof HTMLOptionElement ? element.selected : undefined],
    ['disabled', () => {
      if (disableableElements.some(type => element instanceof type))
        return element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true';
    }],
  ]);
  const ariaBoolean = new Map([['true', true], ['false', false]]);
  const checks: Check[] = [];
  for (const [property, expected] of entries) {
    let actual = readNative.get(property)?.();
    if (actual === undefined) {
      const attribute = element.getAttribute(`aria-${property}`) ?? '';
      actual = attribute === 'mixed' && (property === 'checked' || property === 'pressed') ? 'mixed' : ariaBoolean.get(attribute);
    }
    if (actual === null || actual === undefined)
      return { checks, error: `The ${property} state is absent or unsupported on the selected element.` };
    checks.push({ selector, property, passed: actual === expected });
  }
  return { checks };
}

const auditKeyboardOperation = defineTabTool({
  capability: 'core',
  exclusive: true,
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
    const guard = scenarioGuard(tab, signal, 30_000, 2000);
    const { bounded } = guard;
    const steps = params.steps.map((step, index): StepResult => {
      const action = 'key' in step ? { key: step.key } : { action: 'type' as const, characterCount: [...step.text].length };
      return { step: index + 1, ...action, status: 'not-run', checks: [] };
    });
    let status: 'passed' | 'failed' | 'incomplete' = 'passed';
    let reason: string | null = null;
    let phase = 'Selector validation';
    try {
      for (const selector of new Set(params.steps.flatMap(step => step.expect.map(expectation => expectation.selector))))
        await bounded(() => page.locator(`css=${selector}`).count());
      for (const [index, step] of params.steps.entries()) {
        const current = steps[index];
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
            await guard.release(focused);
          }
        }
        phase = 'Expectation measurement';
        if (params.timeoutMs > 0)
          await delay(params.timeoutMs, undefined, { signal: guard.signal });
        const checks: Check[] = [];
        for (const expectation of step.expect) {
          const measurement = await bounded(() => page.locator(`css=${expectation.selector}`).evaluateAll(measureExpectation, expectation));
          if (measurement.error) {
            reason = measurement.error;
            throw new Error(measurement.error);
          }
          checks.push(...measurement.checks);
        }
        current.checks = checks;
        current.status = checks.every(check => check.passed) ? 'passed' : 'failed';
        if (current.status === 'failed') {
          status = 'failed';
          break;
        }
      }
    } catch {
      status = 'incomplete';
      const interruption = guard.reason();
      reason ??= interruption ? interruptionReasons[interruption] : `${phase} failed or could not be completed within its bound.`;
    } finally {
      guard.dispose();
    }
    const findings = steps.flatMap(step => step.status !== 'failed' ? [] : step.checks.filter(check => !check.passed).map(check => ({
      step: step.step,
      selector: check.selector,
      property: check.property,
      problem: 'The expected keyboard outcome was not observed.',
    })));
    const report = {
      version: 'v1',
      status,
      reason,
      scope: 'Caller-supplied scenario in the main frame and open shadow roots; not a conformance assessment. Page state is not restored.',
      steps,
      findings,
    };
    const resource = await writeJsonReport(response, reportPath, report, {
      name: 'audit-keyboard-operation-report',
      title: 'Keyboard operation scenario report',
      description: 'Expected-outcome checks for a caller-supplied keyboard scenario.',
    });
    response.setStructuredContent({ kind: 'audit_keyboard_operation', ...report, report: resource, reportUri: resource.uri });
    const passedSteps = steps.filter(step => step.status === 'passed').length;
    const summary = [
      `Keyboard scenario: ${status}. ${passedSteps}/${steps.length} steps passed; ${findings.length} finding(s).`,
      'Later steps are not run after a failed or incomplete step.',
      'Page state is not restored; interrupted in-flight keys cannot be undone.',
      'Results cover only this scenario, not conformance.',
      `JSON report: ${resource.path}`,
    ].join(' ');
    if (status === 'incomplete')
      response.addError(`${summary}\n${reason}`);
    else
      response.addResult(summary);
  },
});

export default [auditKeyboardOperation];
