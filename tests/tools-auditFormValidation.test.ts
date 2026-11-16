/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Dialog, type Page } from 'playwright';
import tools from '../src/tools/auditFormValidation.js';
import { Response } from '../src/response.js';
import type { Context } from '../src/context.js';

const tool = tools[0];
let browser: Browser;
let page: Page;
let directory: string;
let modalOpen = false;
const scenario = { fields: [{ selector: '#email', value: 'secret-invalid-value' }], submitSelector: '#submit', expectedFeedback: [{ selector: '#error', kind: 'error' }], timeoutMs: 200 };

async function run(args: unknown = scenario, signal?: AbortSignal) {
  const params = tool.schema.inputSchema.parse(args);
  const tab = { page, modalStates: () => modalOpen ? [{ type: 'dialog' }] : [], context: { outputFile: async (name: string) => path.join(directory, name) } };
  const context = { currentTabOrDie: () => tab, config: {} } as Context;
  const response = new Response(context, tool.schema.name, {});
  await tool.handle(context, params, response, signal);
  const report = JSON.parse(await fs.readFile(response.resourceLinks()[0].uri.replace('file://', ''), 'utf8'));
  expect(JSON.stringify(report)).not.toContain('secret-invalid-value');
  expect(response.code()).not.toContain('secret-invalid-value');
  return { report, response };
}

beforeAll(async () => { browser = await chromium.launch(); directory = await fs.mkdtemp(path.join(os.tmpdir(), 'form-audit-')); });
afterAll(async () => {
  await browser?.close();
  if (directory)
    await fs.rm(directory, { recursive: true, force: true });
});
afterEach(async () => { await page?.close(); });

async function fixture(body: string) { modalOpen = false; page = await browser.newPage(); page.on('dialog', () => { modalOpen = true; }); await page.setContent(body); }

describe('audit_form_validation public tool', () => {
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
    { semantics: 'no live region', status: '<p id=status></p>', live: null },
    { semantics: 'aria-live off inside a polite ancestor', status: '<div aria-live=polite><p id=status aria-live=off></p></div>', live: 'off' },
  ])('reports changed exposed unfocused status with $semantics', async ({ status, live }) => {
    await fixture(`<form novalidate><input id=email aria-describedby=error><button id=submit>Submit</button><p id=error></p>${status}</form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault(); error.textContent='Correct email'; document.getElementById('status').textContent='Validation failed';}</script>`);
    const { report } = await run({ ...scenario, expectedFeedback: [...scenario.expectedFeedback, { selector: '#status', kind: 'status' }] });
    expect(report.observed.feedback[1]).toMatchObject({ changed: true, exposed: true, focused: false, live });
    expect(report.findings).toEqual([expect.objectContaining({ check: 'status-not-programmatic', selector: '#status' })]);
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

  it('rejects invalid future-state selectors before filling or submitting', async () => {
    await fixture('<input id=email><button id=submit onclick="window.clicked=true">Submit</button>');
    await expect(run({ ...scenario, expectedFeedback: [{ selector: '[', kind: 'error' }] })).rejects.toThrow();
    expect(await page.locator('#email').inputValue()).toBe('');
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

it('aborts a pending DOM read without leaving a scenario listener', async () => {
  await fixture('<input id=email><button id=submit>Submit</button><p id=error></p>');
  const controller = new AbortController();
  const read = vi.spyOn(page, 'evaluate').mockImplementationOnce(() => new Promise(() => {}));
  const pending = run(scenario, controller.signal);
  const timer = setTimeout(() => controller.abort(), 20);
  try {
    const { report } = await pending;
    expect(report).toMatchObject({ outcome: 'incomplete', incomplete: ['aborted'] });
    expect(page.listenerCount('framenavigated')).toBe(0);
  } finally { clearTimeout(timer); read.mockRestore(); }
});
