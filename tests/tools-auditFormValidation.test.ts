/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Dialog, type Page } from 'playwright';
import tools from '../src/tools/auditFormValidation.js';
import { Response } from '../src/response.js';
import type { Context } from '../src/context.js';

declare global {
  interface Window {
    cancelAudit: () => void;
  }
}

const tool = tools[0];
let browser: Browser;
let page: Page;
let directory: string;
let tab: EventEmitter & { page: Page; modalStates: () => { type: string }[]; context: { outputFile: (name: string) => Promise<string> } };
const scenario = { interactionMode: 'direct', fields: [{ selector: '#email', value: 'secret-invalid-value' }], submitSelector: '#submit', expectedFeedback: [{ selector: '#error', kind: 'error' }], timeoutMs: 200 };

async function run(args: unknown = scenario, signal?: AbortSignal) {
  const params = tool.schema.inputSchema.parse(args);
  const context = { currentTabOrDie: () => tab, config: {} } as Context;
  const response = new Response(context, tool.schema.name, {});
  await tool.handle(context, params, response, signal);
  const report = JSON.parse(await fs.readFile(fileURLToPath(response.resourceLinks()[0].uri), 'utf8'));
  expect(JSON.stringify(report)).not.toContain('secret-invalid-value');
  expect(response.code()).not.toContain('secret-invalid-value');
  return { report, response };
}

beforeAll(async () => { browser = await chromium.launch(); directory = await fs.mkdtemp(path.join(os.tmpdir(), 'form audit-')); });
afterAll(async () => {
  await browser?.close();
  if (directory)
    await fs.rm(directory, { recursive: true, force: true });
});
afterEach(async () => { await page?.close(); });

async function fixture(body: string) {
  page = await browser.newPage();
  const modalStates: { type: string }[] = [];
  tab = Object.assign(new EventEmitter(), { page, modalStates: () => modalStates, context: { outputFile: async (name: string) => path.join(directory, name) } });
  const setModalState = (type: string) => {
    modalStates.push({ type });
    tab.emit('modalState', modalStates[modalStates.length - 1]);
  };
  page.on('dialog', () => setModalState('dialog'));
  page.on('filechooser', () => setModalState('fileChooser'));
  await page.setContent(body);
}

describe('audit_form_validation public tool', () => {
  it('does not submit a direct fill that synchronously normalizes a requested value', async () => {
    await fixture(`<form novalidate><input id=email oninput="this.value=this.value.toUpperCase()"><button id=submit onclick="window.clicked=true">Submit</button><p id=error></p></form>`);
    const { report } = await run({ ...scenario, interactionMode: 'direct' });
    expect(report).toMatchObject({ outcome: 'incomplete', submitAttempted: false, incomplete: ['field-value-mismatch'] });
    expect(await page.locator('#email').inputValue()).toBe(scenario.fields[0].value.toUpperCase());
    expect(await page.evaluate(() => 'clicked' in window)).toBe(false);
  });

  it('rechecks earlier direct fields after later fills can change them', async () => {
    await fixture(`<form novalidate><input id=email><input id=second oninput="email.value='overwritten'"><button id=submit onclick="window.clicked=true">Submit</button><p id=error></p></form>`);
    const { report } = await run({ ...scenario, interactionMode: 'direct', fields: [...scenario.fields, { selector: '#second', value: 'later value' }] });
    expect(report).toMatchObject({ outcome: 'incomplete', submitAttempted: false, incomplete: ['field-value-mismatch'] });
    expect(await page.locator('#email').inputValue()).toBe('overwritten');
    expect(await page.locator('#second').inputValue()).toBe('later value');
    expect(await page.evaluate(() => 'clicked' in window)).toBe(false);
  });

  it('submits the exact supplied values once and leaves unrelated fields unchanged', async () => {
    await fixture(`<form novalidate><input id=email value=original-email aria-describedby=error><textarea id=message aria-describedby=error>Original message</textarea><input id=unrelated value=untouched><button id=submit>Submit</button><p id=error></p></form><script>
      document.documentElement.dataset.submissions='[]';
      document.querySelector('form').onsubmit=e=>{e.preventDefault(); const submissions=JSON.parse(document.documentElement.dataset.submissions); submissions.push({email:email.value,message:message.value,unrelated:unrelated.value}); document.documentElement.dataset.submissions=JSON.stringify(submissions); error.textContent='Correct the supplied fields';};
    </script>`);
    const { report } = await run({ ...scenario, fields: [...scenario.fields, { selector: '#message', value: 'distinct second value' }] });
    expect(report.outcome).toBe('completed');
    expect(report.findings).toEqual([]);
    expect(await page.evaluate(() => JSON.parse(document.documentElement.dataset.submissions ?? '[]'))).toEqual([
      { email: 'secret-invalid-value', message: 'distinct second value', unrelated: 'untouched' },
    ]);
    expect(await page.locator('#unrelated').inputValue()).toBe('untouched');
  });

  it('records associated errors and changed live-ancestor status without requiring every error to be live', async () => {
    await fixture(`<form novalidate><input id=email aria-describedby=error><button id=submit>Submit</button><p id=error></p><div aria-live=polite><p id=status></p></div></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault(); email.setAttribute('aria-invalid','true'); error.textContent='Correct the email'; document.getElementById('status').textContent='Validation failed';}</script>`);
    const { report } = await run({ ...scenario, expectedFeedback: [...scenario.expectedFeedback, { selector: '#status', kind: 'status' }] });
    expect(report.outcome).toBe('completed');
    expect(report.findings).toEqual([]);
    expect(report.observed.fields[0]).toMatchObject({ invalid: true, associatedErrors: ['#error'] });
    expect(report.observed.feedback[1]).toMatchObject({ changed: true, live: 'polite', exposed: true });
  });

  it('reports missing identification/association and hidden or ineffective feedback', async () => {
    await fixture(`<form novalidate><input id=email aria-describedby=hint><p id=hint>Instructions</p><button id=submit>Submit</button><div aria-live=polite><p id=error aria-live=off></p><p id=status aria-hidden=true></p></div></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault(); error.textContent='Error'; document.getElementById('status').textContent='Failed';}</script>`);
    const { report } = await run({ ...scenario, expectedFeedback: [...scenario.expectedFeedback, { selector: '#status', kind: 'status' }] });
    expect(report.findings.map((f: { check: string }) => f.check)).toEqual(expect.arrayContaining(['invalid-field-not-identified', 'error-not-associated', 'feedback-not-exposed', 'status-not-programmatic']));
    expect(report.observed.feedback[0].live).toBe('off');
  });

  it('accepts native invalidity and browser-managed focus without triggering extra invalid events', async () => {
    await fixture(`<form><input id=email type=email required><button id=submit>Submit</button><p id=error></p></form><script>document.documentElement.dataset.invalidEvents='0'; email.addEventListener('invalid',()=>document.documentElement.dataset.invalidEvents=String(Number(document.documentElement.dataset.invalidEvents)+1));</script>`);
    const { report } = await run();
    expect(report.observed.fields[0]).toMatchObject({ nativeInvalid: true, focused: true });
    expect(report.findings.some((f: { check: string }) => f.check === 'error-not-associated')).toBe(false);
    expect(await page.evaluate(() => Number(document.documentElement.dataset.invalidEvents))).toBe(1);
  });

  it('does not treat aria-errormessage as operative when aria-invalid is false', async () => {
    await fixture(`<form novalidate><input id=email aria-invalid=false aria-errormessage=error><button id=submit>Submit</button><p id=error>Error</p></form><script>document.querySelector('form').onsubmit=e=>e.preventDefault()</script>`);
    const { report } = await run();
    expect(report.observed.fields[0].associatedErrors).toEqual([]);
    expect(report.findings.some((f: { check: string }) => f.check === 'error-not-associated')).toBe(true);
  });

  it('recognizes a newly inserted focused summary as a feedback route', async () => {
    await fixture(`<form novalidate><input id=email><button id=submit>Submit</button></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault(); email.setAttribute('aria-invalid','true'); const p=document.createElement('p'); p.id='error'; p.tabIndex=-1; p.textContent='Email is invalid'; document.body.append(p); p.focus();}</script>`);
    const { report } = await run();
    expect(report.observed.feedback[0]).toMatchObject({ changed: true, focused: true });
    expect(report.findings).toEqual([]);
  });

  it('requires a change, not merely a live attribute on an unchanged status', async () => {
    await fixture(`<form novalidate><input id=email aria-invalid=true aria-describedby=error><button id=submit>Submit</button><p id=error>Error</p><p id=status role=status>Old message</p></form><script>document.querySelector('form').onsubmit=e=>e.preventDefault()</script>`);
    const { report } = await run({ ...scenario, expectedFeedback: [...scenario.expectedFeedback, { selector: '#status', kind: 'status' }] });
    expect(report.findings.map((f: { check: string }) => f.check)).toContain('status-not-programmatic');
  });

  it.each([
    { semantics: 'no recognized live role', status: '<p id=status role=constructor></p>', live: null, programmatic: false },
    { semantics: 'implicit alert role', status: '<p id=status role=alert></p>', live: 'assertive', programmatic: true },
    { semantics: 'implicit log role with normalized spelling', status: '<p id=status role=" LOG "></p>', live: 'polite', programmatic: true },
    { semantics: 'explicit off overriding an alert role and a polite ancestor', status: '<div aria-live=polite><p id=status role=alert aria-live=" OFF "></p></div>', live: 'off', programmatic: false },
    { semantics: 'implicit timer role overriding a polite ancestor', status: '<div aria-live=polite><p id=status role=timer aria-live=invalid></p></div>', live: 'off', programmatic: false },
    { semantics: 'implicit marquee role overriding a polite ancestor', status: '<div aria-live=polite><p id=status role=marquee></p></div>', live: 'off', programmatic: false },
  ])('reports changed exposed unfocused status with $semantics', async ({ status, live, programmatic }) => {
    await fixture(`<form novalidate><input id=email aria-describedby=error><button id=submit>Submit</button><p id=error></p>${status}</form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault(); error.textContent='Correct email'; document.getElementById('status').textContent='Validation failed';}</script>`);
    const { report } = await run({ ...scenario, expectedFeedback: [...scenario.expectedFeedback, { selector: '#status', kind: 'status' }] });
    expect(report.observed.feedback[1]).toMatchObject({ changed: true, exposed: true, focused: false, live });
    expect(report.findings).toEqual(programmatic ? [] : [expect.objectContaining({ check: 'status-not-programmatic', selector: '#status' })]);
  });

  it.each([
    { hiddenBy: 'aria-hidden descendant', attributes: 'aria-hidden=true', visibleText: '', checks: ['feedback-not-exposed', 'status-not-programmatic'] },
    { hiddenBy: 'nested display none descendant', attributes: 'style="display:none"', visibleText: '', checks: ['feedback-not-exposed', 'status-not-programmatic'] },
    { hiddenBy: 'aria-hidden change alongside unchanged visible text', attributes: 'aria-hidden=true', visibleText: 'Existing status', checks: ['status-not-programmatic'] },
  ])('does not count a $hiddenBy as exposed changed feedback', async ({ attributes, visibleText, checks }) => {
    await fixture(`<form novalidate><input id=email aria-describedby=error><button id=submit>Submit</button><p id=error></p><p id=status role=status>${visibleText}<span ${attributes}><span id=hidden></span></span></p></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault(); error.textContent='Correct email'; document.getElementById('hidden').textContent='Validation failed';}</script>`);
    const { report } = await run({ ...scenario, expectedFeedback: [...scenario.expectedFeedback, { selector: '#status', kind: 'status' }] });
    expect(await page.locator('#status').ariaSnapshot()).not.toContain('Validation failed');
    expect(report.outcome).toBe('completed');
    expect.soft(report.findings).toEqual(checks.map(check => expect.objectContaining({ check, selector: '#status' })));
    expect.soft(report.observed.feedback[1]).toMatchObject({ textPresent: !!visibleText, changed: false });
  });

  it('accepts changed screen-reader-only status text without requiring a visible box', async () => {
    await fixture(`<form novalidate><input id=email aria-describedby=error><button id=submit>Submit</button><p id=error></p><p id=status role=status style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0"></p></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault(); error.textContent='Correct email'; document.getElementById('status').textContent='Validation failed';}</script>`);
    const { report } = await run({ ...scenario, expectedFeedback: [...scenario.expectedFeedback, { selector: '#status', kind: 'status' }] });
    expect(await page.locator('#status').ariaSnapshot()).toContain('Validation failed');
    expect(report.outcome).toBe('completed');
    expect(report.observed.feedback[1]).toMatchObject({ textPresent: true, exposed: true, changed: true, live: 'polite' });
    expect(report.findings).toEqual([]);
  });

  it('excludes feedback hidden in closed details across shadow ancestry but keeps the first summary exposed', async () => {
    await fixture(`<div id=host></div><script>
      host.attachShadow({mode:'open'}).innerHTML='<form novalidate><input id=email aria-describedby=error><button id=submit>Submit</button><details><summary>Errors</summary><p id=error></p></details><div id=status role=status><details><summary>Current status</summary><p id=message>Old status</p></details></div></form>';
      host.shadowRoot.querySelector('form').onsubmit=e=>{e.preventDefault(); host.shadowRoot.querySelector('#error').textContent='Correct email'; host.shadowRoot.querySelector('#message').textContent='Validation failed';};
    </script>`);
    const { report } = await run({ ...scenario, fields: [{ selector: '#host #email', value: scenario.fields[0].value }], submitSelector: '#host #submit', expectedFeedback: [{ selector: '#host #error', kind: 'error' }, { selector: '#host #status', kind: 'status' }] });
    expect(await page.locator('#host #error').ariaSnapshot()).not.toContain('Correct email');
    expect(await page.locator('#host #status').ariaSnapshot()).toContain('Current status');
    expect(await page.locator('#host #status').ariaSnapshot()).not.toContain('Validation failed');
    expect(report.observed.feedback).toMatchObject([
      { textPresent: false, exposed: false, changed: false },
      { textPresent: true, exposed: true, changed: false },
    ]);
    expect(report.findings.map((finding: { check: string }) => finding.check)).toEqual(expect.arrayContaining(['feedback-not-exposed', 'status-not-programmatic']));
  });

  it('keeps feedback in shadow content hosted by the first summary exposed', async () => {
    await fixture(`<form novalidate><input id=email><button id=submit>Submit</button></form><details><summary><span id=host></span> Account status</summary><p>Collapsed details content</p></details><script>
      host.attachShadow({mode:'open'}).innerHTML='<p id=feedback role=status></p>';
      document.querySelector('form').onsubmit=e=>{e.preventDefault(); host.shadowRoot.querySelector('#feedback').textContent='Validation failed';};
    </script>`);
    const { report } = await run({ ...scenario, expectedFeedback: [{ selector: '#host #feedback', kind: 'status' }] });
    expect(report.observed.feedback[0]).toMatchObject({ textPresent: true, exposed: true, changed: true, live: 'polite' });
    expect(report.findings.map((finding: { check: string }) => finding.check)).not.toEqual(expect.arrayContaining(['feedback-not-exposed', 'status-not-programmatic']));
  });

  it.each([
    { hiddenBy: 'a display:contents target in closed details', markup: '<details><summary>More</summary><div id=status role=status style="display:contents"></div></details>' },
    { hiddenBy: 'a display:contents target in hidden=until-found content', markup: '<div hidden=until-found><div id=status role=status style="display:contents"></div></div>' },
    { hiddenBy: 'hidden=until-found on the target', markup: '<p id=status role=status hidden=until-found></p>' },
  ])('does not expose feedback hidden by $hiddenBy', async ({ markup }) => {
    await fixture(`<form novalidate><input id=email><button id=submit>Submit</button></form>${markup}<script>document.querySelector('form').onsubmit=e=>{e.preventDefault(); document.getElementById('status').textContent='Validation failed';}</script>`);
    const { report } = await run({ ...scenario, expectedFeedback: [{ selector: '#status', kind: 'status' }] });
    expect(report.observed.feedback[0]).toMatchObject({ present: true, textPresent: false, exposed: false, changed: false });
  });

  it('does not count display:contents text in collapsed details content', async () => {
    await fixture(`<form novalidate><input id=email><button id=submit>Submit</button></form><div id=status role=status><details><summary>Status</summary><span id=hidden style="display:contents"></span></details></div><script>document.querySelector('form').onsubmit=e=>{e.preventDefault(); document.getElementById('hidden').textContent='Validation failed';}</script>`);
    const { report } = await run({ ...scenario, expectedFeedback: [{ selector: '#status', kind: 'status' }] });
    expect(report.observed.feedback[0]).toMatchObject({ textPresent: true, exposed: true, changed: false });
  });

  it('does not count direct text in closed details with no authored summary', async () => {
    await fixture(`<form novalidate><input id=email><button id=submit>Submit</button></form><details id=status role=status></details><script>document.querySelector('form').onsubmit=e=>{e.preventDefault(); document.getElementById('status').textContent='Validation failed';}</script>`);
    const { report } = await run({ ...scenario, expectedFeedback: [{ selector: '#status', kind: 'status' }] });
    expect(await page.locator('#status').textContent()).toBe('Validation failed');
    expect(report.observed.feedback[0]).toMatchObject({ textPresent: false, exposed: true, changed: false });
  });

  it.each([
    '<p id=feedback role=status></p>',
    '<div style="display:contents"><span id=feedback role=status style="display:contents"></span></div>',
  ])('does not expose inactive slot fallback %s', async fallback => {
    await fixture(`<form novalidate><input id=email><button id=submit>Submit</button></form><div id=host><span>Assigned content</span></div><script>
      host.attachShadow({mode:'open'}).innerHTML='<slot>${fallback}</slot>';
      document.querySelector('form').onsubmit=e=>{e.preventDefault(); host.shadowRoot.querySelector('#feedback').textContent='Validation failed';};
    </script>`);
    const { report } = await run({ ...scenario, expectedFeedback: [{ selector: '#host #feedback', kind: 'status' }] });
    expect(await page.locator('#host #feedback').textContent()).toBe('Validation failed');
    expect(await page.locator('#host').ariaSnapshot()).not.toContain('Validation failed');
    expect(report.observed.feedback[0]).toMatchObject({ present: true, textPresent: false, exposed: false, changed: false });
    expect(report.findings).toEqual(expect.arrayContaining(['feedback-not-exposed', 'status-not-programmatic'].map(check => expect.objectContaining({ check, selector: '#host #feedback' }))));
  });

  it('keeps aria-hidden on an intermediate nested slot when sampling its host', async () => {
    await fixture(`<form novalidate><input id=email><button id=submit>Submit</button></form><div id=host role=status></div><script>
      host.attachShadow({mode:'open'}).innerHTML='<slot><slot aria-hidden=true><span id=feedback></span></slot></slot>';
      document.querySelector('form').onsubmit=e=>{e.preventDefault(); host.shadowRoot.querySelector('#feedback').textContent='Validation failed';};
    </script>`);
    const { report } = await run({ ...scenario, expectedFeedback: [{ selector: '#host', kind: 'status' }] });
    expect(await page.locator('#host #feedback').textContent()).toBe('Validation failed');
    expect(report.observed.feedback[0]).toMatchObject({ exposed: true, textPresent: false, changed: false });
  });

  it('reads open-shadow and rendered slot text without counting hidden or unassigned text', async () => {
    await fixture(`<form novalidate><input id=email><button id=submit>Submit</button></form><div id=shadow-status role=status></div><div id=slot-status role=status><span slot=message>Visible assigned</span><span slot=hidden>Old hidden assigned</span><span slot=unassigned>Old unassigned</span></div><div id=fallback-status role=status></div><div id=text-hidden-status role=status>Old hidden text</div><div id=unassigned-host><p id=unassigned-feedback role=status>Old unassigned feedback</p></div><script>
      const shadowStatus=document.getElementById('shadow-status'), slotStatus=document.getElementById('slot-status'), fallbackStatus=document.getElementById('fallback-status'), textHiddenStatus=document.getElementById('text-hidden-status'), unassignedHost=document.getElementById('unassigned-host'), unassignedFeedback=document.getElementById('unassigned-feedback');
      shadowStatus.attachShadow({mode:'open'}).innerHTML='<span>Old shadow message</span>';
      slotStatus.attachShadow({mode:'open'}).innerHTML='<slot name=message>Fallback message</slot><div aria-hidden=true><slot name=hidden>Hidden fallback</slot></div>';
      fallbackStatus.attachShadow({mode:'open'}).innerHTML='<slot>Visible fallback status</slot>';
      textHiddenStatus.attachShadow({mode:'open'}).innerHTML='<div aria-hidden=true><slot></slot></div>';
      unassignedHost.attachShadow({mode:'open'}).innerHTML='<span>Rendered shadow child</span>';
      document.querySelector('form').onsubmit=e=>{e.preventDefault(); shadowStatus.shadowRoot.querySelector('span').textContent='New shadow message'; slotStatus.querySelector('[slot=hidden]').textContent='New hidden assigned'; slotStatus.querySelector('[slot=unassigned]').textContent='New unassigned'; textHiddenStatus.textContent='New hidden text'; unassignedFeedback.textContent='New unassigned feedback';};
    </script>`);
    const { report } = await run({ ...scenario, expectedFeedback: [{ selector: '#shadow-status', kind: 'status' }, { selector: '#slot-status', kind: 'status' }, { selector: '#fallback-status', kind: 'status' }, { selector: '#text-hidden-status', kind: 'status' }, { selector: '#unassigned-host #unassigned-feedback', kind: 'status' }] });
    expect(report.observed.feedback).toMatchObject([
      { textPresent: true, exposed: true, changed: true, live: 'polite' },
      { textPresent: true, exposed: true, changed: false, live: 'polite' },
      { textPresent: true, exposed: true, changed: false, live: 'polite' },
      { textPresent: false, exposed: true, changed: false, live: 'polite' },
      { textPresent: false, exposed: false, changed: false, live: 'polite' },
    ]);
    expect(report.findings.map((finding: { check: string; selector: string }) => [finding.check, finding.selector])).toEqual(expect.arrayContaining([
      ['status-not-programmatic', '#text-hidden-status'],
      ['feedback-not-exposed', '#unassigned-host #unassigned-feedback'],
      ['status-not-programmatic', '#unassigned-host #unassigned-feedback'],
    ]));
  });

  it.each([
    { emptyElements: 9999, truncated: false },
    { emptyElements: 10000, truncated: true },
  ])('bounds rendered-node traversal with $emptyElements empty elements', async ({ emptyElements, truncated }) => {
    await fixture(`<form novalidate><input id=email aria-describedby=error><button id=submit>Submit</button><p id=error></p></form><script>
      document.querySelector('form').onsubmit=e=>{
        e.preventDefault();
        error.append(document.createTextNode('Correct email'));
        for(let i=0;i<${emptyElements};i++) error.append(document.createElement('span'));
      };
    </script>`);
    const { report } = await run();
    expect(report.outcome).toBe(truncated ? 'incomplete' : 'completed');
    expect(report.observed.feedback[0].textTruncated).toBe(truncated);
    expect(report.incomplete).toEqual(truncated ? ['feedback-text-truncated'] : []);
  });

  it.each([
    { length: 10000, truncated: false },
    { length: 10001, truncated: true },
  ])('reports exposed feedback of $length characters without a false clean result', async ({ length, truncated }) => {
    await fixture(`<form novalidate><input id=email aria-describedby=error><button id=submit>Submit</button><p id=error></p></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault(); error.textContent='x'.repeat(${length});}</script>`);
    const { report } = await run();
    expect(await page.locator('#error').evaluate(element => element.textContent?.length)).toBe(length);
    expect(report).toMatchObject({
      outcome: truncated ? 'incomplete' : 'completed',
      incomplete: truncated ? ['feedback-text-truncated'] : [],
      observed: { feedback: [{ selector: '#error', textPresent: true, textTruncated: truncated }] },
      findings: [],
    });
  });

  it('remains incomplete when baseline feedback was truncated even if submitted feedback is short', async () => {
    await fixture(`<form novalidate><input id=email aria-describedby=error><button id=submit>Submit</button><p id=error></p></form><script>error.textContent='x'.repeat(10001); document.querySelector('form').onsubmit=e=>{e.preventDefault(); error.textContent='Correct email';}</script>`);
    const { report } = await run();
    expect(report).toMatchObject({
      outcome: 'incomplete',
      incomplete: ['feedback-text-truncated'],
      observed: { feedback: [{ selector: '#error', changed: true, textPresent: true, textTruncated: false }] },
      findings: [],
    });
  });

  it('recognizes native validation through host-qualified open-shadow selectors', async () => {
    await fixture(`<div id=host></div><script>host.attachShadow({mode:'open'}).innerHTML='<form><input id=email type=email required><button id=submit>Submit</button><p id=error></p></form>';</script>`);
    expect(await page.locator('#host #email').count()).toBe(1);
    expect(await page.locator('#host #submit').count()).toBe(1);
    const { report } = await run({ ...scenario, fields: [{ ...scenario.fields[0], selector: '#host #email' }], submitSelector: '#host #submit', expectedFeedback: [{ selector: '#host #error', kind: 'error' }] });
    expect.soft(report.outcome).toBe('completed');
    expect.soft(report.observed.fields[0]).toMatchObject({ nativeInvalid: true, focused: true, nativeValidationPossible: true });
    expect.soft(report.findings).toEqual([]);
  });

  it('rejects fieldset-disabled fields before changing any earlier field', async () => {
    await fixture('<form><input id=email value=original><fieldset disabled><input id=second></fieldset><button id=submit>Submit</button><p id=error></p></form>');
    expect(await page.locator('#second').isDisabled()).toBe(true);
    await expect.soft(run({ ...scenario, fields: [...scenario.fields, { selector: '#second', value: 'must-not-be-filled' }] })).rejects.toThrow();
    expect.soft(await page.locator('#email').inputValue()).toBe('original');
    expect.soft(await page.locator('#second').inputValue()).toBe('');
  });

  it('exposes feedback whose visible style overrides an ancestor visibility hidden', async () => {
    await fixture(`<form novalidate><input id=email aria-describedby=error><button id=submit>Submit</button><div style="visibility:hidden"><p id=error style="visibility:visible"></p></div></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault(); error.textContent='Correct email';}</script>`);
    const { report } = await run();
    expect(await page.locator('#error').isVisible()).toBe(true);
    expect.soft(report.observed.feedback[0]).toMatchObject({ changed: true, exposed: true });
    expect.soft(report.findings).toEqual([]);
  });

  it('stops on a submission popup without later observations and releases listeners', async () => {
    await fixture(`<form novalidate><input id=email aria-describedby=error><button id=submit>Submit</button><p id=error>Correct email</p></form><script>
      const feedback=document.getElementById('error');
      document.documentElement.dataset.feedbackReadsAfterSubmit='0';
      Object.defineProperty(feedback,'textContent',{get(){if(document.documentElement.dataset.submitted) document.documentElement.dataset.feedbackReadsAfterSubmit=String(Number(document.documentElement.dataset.feedbackReadsAfterSubmit)+1); return 'Correct email';}});
      document.querySelector('form').onsubmit=e=>{e.preventDefault(); document.documentElement.dataset.submitted='yes'; window.open('about:blank');};
    </script>`);
    const listeners = { navigation: page.listenerCount('framenavigated'), popup: page.listenerCount('popup') };
    const popupOpened = page.waitForEvent('popup');
    try {
      const { report } = await run();
      const popup = await popupOpened;
      expect.soft(report).toMatchObject({ outcome: 'incomplete', incomplete: ['popup'], observed: { fields: [], feedback: [] }, findings: [] });
      expect.soft(await page.evaluate(() => Number(document.documentElement.dataset.feedbackReadsAfterSubmit))).toBe(0);
      expect.soft(page.listenerCount('framenavigated')).toBe(listeners.navigation);
      expect.soft(page.listenerCount('popup')).toBe(listeners.popup);
      await popup.close();
    } finally {
      for (const popup of page.context().pages().filter(openPage => openPage !== page))
        await popup.close();
    }
  });

  it.each(['[', '#email >> nth=0'])('rejects non-CSS feedback selector %s before filling or submitting', async selector => {
    await fixture('<input id=email><button id=submit onclick="window.clicked=true">Submit</button>');
    await expect(run({ ...scenario, expectedFeedback: [{ selector, kind: 'error' }] })).rejects.toThrow('is not a valid selector');
    expect(await page.locator('#email').inputValue()).toBe('');
    expect(await page.evaluate(() => 'clicked' in window)).toBe(false);
    expect(tool.schema.inputSchema.safeParse({ ...scenario, fields: [] }).success).toBe(false);
    expect(tool.schema.inputSchema.safeParse({ ...scenario, submitSelector: ' ' }).success).toBe(false);
  });

  it('stops when aborted before actions and leaves no listeners', async () => {
    await fixture('<input id=email><button id=submit>Submit</button><p id=error></p>');
    const controller = new AbortController(); controller.abort();
    const before = page.listenerCount('framenavigated');
    const { report } = await run(scenario, controller.signal);
    expect(report).toMatchObject({ outcome: 'incomplete', incomplete: ['aborted'] });
    expect(await page.locator('#email').inputValue()).toBe('');
    expect(page.listenerCount('framenavigated')).toBe(before);
  });

  it('stops on navigation without reading feedback from the replacement page', async () => {
    await fixture(`<input id=email><button id=submit onclick="location.href='about:blank#next'">Submit</button><p id=error></p>`);
    const { report } = await run();
    expect(report.outcome).toBe('incomplete');
    expect(report.incomplete).toContain('navigation');
  });

  it('keeps the first interruption when cancellation follows a submission modal', async () => {
    await fixture(`<form novalidate><input id=email><button id=submit>Submit</button><p id=error></p></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault(); alert('pause')}</script>`);
    const controller = new AbortController();
    let dialog: Dialog | undefined;
    page.once('dialog', current => { dialog = current; controller.abort(); });
    const { report } = await run(scenario, controller.signal);
    expect(controller.signal.aborted).toBe(true);
    expect(report).toMatchObject({ outcome: 'incomplete', submitAttempted: true, incomplete: ['modal'], observed: { fields: [], feedback: [] } });
    await dialog?.dismiss();
  });

  it.each([
    { change: 'appears 100ms after submission', script: "setTimeout(()=>{error.textContent='Correct email'},100)", feedback: { present: true, textPresent: true, changed: true } },
    { change: 'is removed 50ms after submission', script: "error.textContent='Correct email'; setTimeout(()=>error.remove(),50)", feedback: { present: false, textPresent: false, changed: false } },
  ])('reads feedback at the end of the observation window when it $change', async ({ script, feedback }) => {
    await fixture(`<form novalidate><input id=email aria-describedby=error><button id=submit>Submit</button><p id=error></p></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault(); ${script}}</script>`);
    const { report } = await run({ ...scenario, timeoutMs: 300 });
    expect(report.outcome).toBe('completed');
    expect(report.observed.feedback[0]).toMatchObject(feedback);
  });
});

it('treats a meaningful associated error as identification even without aria-invalid', async () => {
  await fixture(`<form novalidate><input id=email aria-describedby=error><button id=submit>Submit</button><p id=error></p></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault(); error.textContent='Correct the email'}</script>`);
  const { report } = await run();
  expect(report.observed.fields[0]).toMatchObject({ invalid: false, associatedErrors: ['#error'] });
  expect(report.findings).toEqual([]);
});

it('does not write a caller value reflected into an invalid-state attribute', async () => {
  await fixture(`<form novalidate><input id=email><button id=submit>Submit</button><p id=error></p></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault(); email.setAttribute('aria-invalid', email.value); error.textContent=email.value}</script>`);
  await run();
});

it('uses same-root IDREF identity for open-shadow errors, not a document duplicate ID', async () => {
  await fixture(`<p id=error>Unrelated document error</p><div id=host></div><script>host.attachShadow({mode:'open'}).innerHTML='<input id=email aria-invalid=true aria-errormessage=error><button id=submit>Submit</button><p id=localError></p>'; host.shadowRoot.querySelector('#submit').onclick=()=>host.shadowRoot.querySelector('#localError').textContent='Correct email';</script>`);
  const { report } = await run({ ...scenario, expectedFeedback: [{ selector: '#error', kind: 'error' }, { selector: '#localError', kind: 'error' }] });
  expect(report.observed.fields[0].associatedErrors).toEqual([]);
  expect(report.findings.map((f: { check: string }) => f.check)).toContain('error-not-associated');
});

it('accepts operative same-root aria-errormessage for grammar invalidity', async () => {
  await fixture(`<div id=host></div><script>host.attachShadow({mode:'open'}).innerHTML='<input id=email aria-invalid=grammar aria-errormessage=error><button id=submit>Submit</button><p id=error></p>'; host.shadowRoot.querySelector('#submit').onclick=()=>host.shadowRoot.querySelector('#error').textContent='Correct email';</script>`);
  const { report } = await run();
  expect(report.observed.fields[0]).toMatchObject({ invalid: true, associatedErrors: ['#error'] });
  expect(report.findings).toEqual([]);
});

it('bounds an action failure without a later submission or leaked navigation listener', async () => {
  await fixture('<input id=email style="display:none"><button id=submit onclick="window.clicked=true">Submit</button><p id=error></p>');
  const listeners = page.listenerCount('framenavigated');
  const { report } = await run();
  expect(report).toMatchObject({ outcome: 'incomplete', submitAttempted: false });
  expect(await page.evaluate(() => 'clicked' in window)).toBe(false);
  expect(page.listenerCount('framenavigated')).toBe(listeners);
});

it('cancels an observation wait and cleans listeners without subsequent actions', async () => {
  await fixture(`<form novalidate><input id=email><button id=submit>Submit</button><p id=error></p></form><script>document.querySelector('form').onsubmit=e=>e.preventDefault()</script>`);
  const controller = new AbortController();
  const pending = run({ ...scenario, timeoutMs: 3000 }, controller.signal);
  await page.waitForFunction(() => document.activeElement?.id === 'submit');
  controller.abort();
  const { report } = await pending;
  expect(report).toMatchObject({ outcome: 'incomplete', incomplete: ['aborted'] });
  expect(page.listenerCount('framenavigated')).toBe(0);
});


it('stops at a modal raised by filling without later fields or submission', async () => {
  await fixture('<input id=email oninput="alert(\'pause\')"><input id=second><button id=submit onclick="window.clicked=true">Submit</button><p id=error></p>');
  let dialog: Dialog | undefined;
  page.once('dialog', current => { dialog = current; });
  const { report } = await run({ ...scenario, fields: [...scenario.fields, { selector: '#second', value: 'must-not-be-filled' }] });
  expect(report).toMatchObject({ outcome: 'incomplete', submitAttempted: false, incomplete: ['modal'] });
  await dialog?.dismiss();
  expect(await page.locator('#second').inputValue()).toBe('');
  expect(await page.evaluate(() => 'clicked' in window)).toBe(false);
  expect(page.listenerCount('framenavigated')).toBe(0);
});

it('aborts a pending DOM read without waiting for the page or leaving a scenario listener', async () => {
  await fixture('<input id=email><button id=submit onclick="window.clicked=true">Submit</button><p id=error></p>');
  const controller = new AbortController();
  await page.exposeFunction('cancelAudit', () => controller.abort());
  await page.evaluate(() => {
    let reads = 0;
    Object.defineProperty(document.querySelector('#email'), 'readOnly', { get() {
      document.documentElement.dataset.readOnlyReads = String(++reads);
      window.cancelAudit();
      const end = Date.now() + 1500;
      while (Date.now() < end) {}
      return false;
    } });
  });
  const started = Date.now();
  const { report } = await run(scenario, controller.signal);
  expect(Date.now() - started).toBeLessThan(700);
  expect(report).toMatchObject({ outcome: 'incomplete', incomplete: ['aborted'], submitAttempted: false });
  expect(page.listenerCount('framenavigated')).toBe(0);
  expect(await page.evaluate(() => document.documentElement.dataset.readOnlyReads)).toBe('1');
  expect(await page.locator('#email').inputValue()).toBe('');
  expect(await page.evaluate(() => 'clicked' in window)).toBe(false);
});

it('bounds a stalled handle cleanup instead of waiting without limit', async () => {
  await fixture('<form novalidate><input id=email><button id=submit onclick="window.clicked=true">Submit</button><p id=error></p></form>');
  const probe = await page.locator('#email').elementHandle();
  await probe?.dispose();
  const dispose = vi.spyOn(Object.getPrototypeOf(probe), 'dispose').mockImplementation(() => new Promise(() => {}));
  try {
    const { report } = await run({ ...scenario, interactionMode: undefined });
    expect(report).toMatchObject({ outcome: 'incomplete', submitAttempted: false, incomplete: ['scenario-action-or-observation-failed'] });
    expect(await page.evaluate(() => 'clicked' in window)).toBe(false);
  } finally { dispose.mockRestore(); }
}, 10000);

describe('keyboard form scenarios', () => {
  it('uses the default keyboard route from current focus and submits exact replacement values without pointer events', async () => {
    await fixture(`<button id=start>Start</button><form novalidate><input id=email value=old aria-describedby=error><textarea id=message aria-describedby=error>old</textarea><input id=unrelated value=untouched><button id=submit>Submit</button><p id=error></p></form><script>
      document.documentElement.dataset.events='[]';
      for(const type of ['keydown','input','change','blur','pointerdown','mousedown']) document.addEventListener(type,e=>{const events=JSON.parse(document.documentElement.dataset.events); events.push({type,id:e.target.id,key:e.key}); document.documentElement.dataset.events=JSON.stringify(events)},true);
      start.focus();
      document.querySelector('form').onsubmit=e=>{e.preventDefault(); document.documentElement.dataset.values=JSON.stringify([email.value,message.value,unrelated.value]); error.textContent='Correct fields';};
    </script>`);
    const { report } = await run({ ...scenario, interactionMode: undefined, fields: [scenario.fields[0], { selector: '#message', value: 'Unicode 🌱\nnext' }] });
    expect(report.outcome).toBe('completed');
    expect(await page.evaluate(() => JSON.parse(document.documentElement.dataset.values))).toEqual(['secret-invalid-value', 'Unicode 🌱\nnext', 'untouched']);
    const events = await page.evaluate(() => JSON.parse(document.documentElement.dataset.events));
    expect(events[0]).toMatchObject({ type: 'keydown', id: 'start', key: 'Tab' });
    expect(events.filter((event: { type: string }) => ['pointerdown', 'mousedown'].includes(event.type))).toEqual([]);
    for (const id of ['email', 'message'])
      expect(events).toEqual(expect.arrayContaining(['keydown', 'input', 'change', 'blur'].map(type => expect.objectContaining({ type, id }))));
    expect(events).toContainEqual(expect.objectContaining({ type: 'keydown', id: 'submit', key: 'Enter' }));
  });

  it.each([
    { attributes: 'tabindex=-1', script: '', reason: 'target-not-reached' },
    { attributes: 'maxlength=3', script: '', reason: 'field-value-mismatch' },
    { attributes: '', script: "email.addEventListener('input',()=>other.focus())", reason: 'focus-changed' },
  ])('does not submit when a keyboard field cannot retain the scenario ($reason)', async ({ attributes, script, reason }) => {
    await fixture(`<form novalidate><input id=email ${attributes}><input id=other><button id=submit>Submit</button><p id=error></p></form><script>${script}; document.querySelector('form').onsubmit=e=>{e.preventDefault(); document.documentElement.dataset.submitted='yes'};</script>`);
    const { report } = await run({ ...scenario, interactionMode: undefined });
    expect(report).toMatchObject({ outcome: 'incomplete', submitAttempted: false, findings: [], incomplete: [reason] });
    expect(await page.evaluate(() => document.documentElement.dataset.submitted)).toBeUndefined();
    expect(await page.locator('#other').inputValue()).toBe('');
  });

  it.each(['\n', '\r'])('rejects a single-line keyboard field value containing %j before mutating or submitting', async newline => {
    await fixture(`<form novalidate><input id=email value=original><input id=other value=untouched><button id=submit>Submit</button><p id=error></p></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.documentElement.dataset.submitted='yes'};</script>`);
    await expect(run({ ...scenario, interactionMode: 'keyboard', fields: [{ selector: '#other', value: 'changed' }, { selector: '#email', value: `invalid${newline}value` }] })).rejects.toThrow('Single-line keyboard form values cannot contain CR or LF.');
    expect(await page.locator('#email').inputValue()).toBe('original');
    expect(await page.locator('#other').inputValue()).toBe('untouched');
    expect(await page.evaluate(() => document.documentElement.dataset.submitted)).toBeUndefined();
  });

  it('stops when keyboard input opens a modal without typing into later fields', async () => {
    await fixture('<input id=email oninput="if(this.value)alert(\'pause\')"><input id=second><button id=submit>Submit</button><p id=error></p>');
    let dialog: Dialog | undefined;
    page.once('dialog', current => { dialog = current; });
    const { report } = await run({ ...scenario, interactionMode: undefined, fields: [...scenario.fields, { selector: '#second', value: 'later' }] });
    expect(report).toMatchObject({ outcome: 'incomplete', submitAttempted: false, incomplete: ['modal'], findings: [] });
    await dialog?.dismiss();
    expect(await page.locator('#second').inputValue()).toBe('');
  });

  it('stops typing after cancellation without later keys or submission', async () => {
    await fixture('<form novalidate><input id=email><button id=submit>Submit</button><p id=error></p></form>');
    const controller = new AbortController();
    await page.exposeFunction('cancelAudit', () => controller.abort());
    await page.evaluate(() => {
      const input = document.querySelector('input');
      if (input instanceof HTMLInputElement) {
        input.addEventListener('input', () => {
          if (input.value)
            window.cancelAudit();
        });
      }
    });
    const { report } = await run({ ...scenario, interactionMode: undefined }, controller.signal);
    expect(report).toMatchObject({ outcome: 'incomplete', submitAttempted: false, incomplete: ['aborted'], findings: [] });
    const value = await page.locator('#email').inputValue();
    expect(value.length).toBeGreaterThan(0);
    expect(value.length).toBeLessThan(scenario.fields[0].value.length);
    await page.waitForTimeout(50);
    expect(await page.locator('#email').inputValue()).toBe(value);
    expect(page.listenerCount('framenavigated')).toBe(0);
  });

  it('rechecks values after blur before submitting', async () => {
    await fixture(`<form novalidate><input id=email onblur="this.value='changed'"><button id=submit>Submit</button><p id=error></p></form>`);
    const { report } = await run({ ...scenario, interactionMode: undefined });
    expect(report).toMatchObject({ outcome: 'incomplete', submitAttempted: false, incomplete: ['field-value-mismatch'], findings: [] });
  });

  it('resolves a later field after the page rerenders it', async () => {
    await fixture(`<form novalidate><input id=email aria-describedby=error><input id=second aria-describedby=error><button id=submit>Submit</button><p id=error></p></form><script>email.onblur=()=>{second.outerHTML='<input id=second aria-describedby=error>'};document.querySelector('form').onsubmit=e=>{e.preventDefault(); document.documentElement.dataset.values=JSON.stringify([email.value,second.value]);error.textContent='Correct fields'};</script>`);
    const { report } = await run({ ...scenario, interactionMode: undefined, fields: [...scenario.fields, { selector: '#second', value: 'later' }] });
    expect(report.outcome).toBe('completed');
    expect(await page.evaluate(() => JSON.parse(document.documentElement.dataset.values))).toEqual([scenario.fields[0].value, 'later']);
  });

  it('replaces an existing value with empty text in an open shadow root', async () => {
    await fixture(`<div id=host></div><script>host.attachShadow({mode:'open'}).innerHTML='<form novalidate><input id=email value=old aria-describedby=error><button id=submit>Submit</button><p id=error></p></form>'; const root=host.shadowRoot; root.querySelector('form').onsubmit=e=>{e.preventDefault(); document.documentElement.dataset.submitted=root.querySelector('input').value; root.querySelector('#error').textContent='Required'};</script>`);
    const { report } = await run({ ...scenario, interactionMode: undefined, fields: [{ selector: '#host #email', value: '' }], submitSelector: '#host #submit', expectedFeedback: [{ selector: '#host #error', kind: 'error' }] });
    expect(report.outcome).toBe('completed');
    expect(await page.evaluate(() => document.documentElement.dataset.submitted)).toBe('');
  });
});
