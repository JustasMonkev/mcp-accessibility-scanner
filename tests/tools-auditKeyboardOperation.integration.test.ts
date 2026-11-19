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

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium } from 'playwright';
import auditKeyboardOperationTools from '../src/tools/auditKeyboardOperation.js';
import { Response } from '../src/response.js';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { Context } from '../src/context.js';
import type { ModalState } from '../src/tools/tool.js';

const tool = auditKeyboardOperationTools[0];
let browser: Browser;
let browserContext: BrowserContext;
let page: Page;
let directory: string;
let context: Context;

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'keyboard-operation-'));
  browserContext = await browser.newContext();
  page = await browserContext.newPage();
  const modalStates: ModalState[] = [];
  const outputFile = async (name: string) => path.join(directory, name);
  const tab = Object.assign(new EventEmitter(), { page, modalStates: () => modalStates, context: { outputFile } });
  const setModalState = (modalState: ModalState) => {
    modalStates.push(modalState);
    tab.emit('modalState', modalState);
  };
  page.on('dialog', dialog => setModalState({ type: 'dialog', dialog, description: 'Dialog' }));
  page.on('filechooser', fileChooser => setModalState({ type: 'fileChooser', fileChooser, description: 'File chooser' }));
  context = { currentTabOrDie: () => tab, takeDownloadErrors: () => [], config: { filePaths: 'absolute' } } as Context;
});
afterEach(async () => {
  await browserContext?.close();
  await fs.rm(directory, { recursive: true, force: true });
});

async function audit(args: unknown, signal?: AbortSignal) {
  const params = tool.schema.inputSchema.parse(args);
  const response = new Response(context, tool.schema.name, params);
  await tool.handle(context, params, response, signal);
  const report = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8'));
  return { report, response };
}

it('operates a button, menu, and native dialog with real keys and verifies focus restoration', async () => {
  await page.setContent(`<button id="toggle" aria-expanded="false">Menu</button>
    <div id="menu" role="menu" hidden><button id="first" role="menuitem" tabindex="-1">One</button><button id="second" role="menuitem" tabindex="-1">Two</button></div>
    <button id="open">Open dialog</button><dialog id="dialog"><button id="close">Close</button></dialog>
    <script>
      const toggle = document.getElementById('toggle'), menu = document.getElementById('menu');
      const first = document.getElementById('first'), second = document.getElementById('second');
      toggle.onclick = () => { menu.hidden = false; toggle.setAttribute('aria-expanded', 'true'); first.focus(); };
      menu.onkeydown = event => {
        if (['ArrowDown', 'Home', 'End', 'Escape'].includes(event.key)) event.preventDefault();
        if (event.key === 'ArrowDown' || event.key === 'End') second.focus();
        if (event.key === 'Home') first.focus();
        if (event.key === 'Escape') { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); }
      };
      document.getElementById('open').onclick = () => document.getElementById('dialog').showModal();
    </script>`);
  const { report, response } = await audit({ reportFile: 'report.json', timeoutMs: 100, steps: [
    { key: 'Tab', expect: [{ selector: '#toggle', focused: true }] },
    { key: 'Enter', expect: [{ selector: '#toggle', expanded: true }, { selector: '#menu', visible: true }, { selector: '#first', focused: true }] },
    { key: 'ArrowDown', expect: [{ selector: '#second', focused: true }] },
    { key: 'Home', expect: [{ selector: '#first', focused: true }] },
    { key: 'End', expect: [{ selector: '#second', focused: true }] },
    { key: 'Escape', expect: [{ selector: '#toggle', focused: true, expanded: false }, { selector: '#menu', visible: false }] },
    { key: 'Tab', expect: [{ selector: '#open', focused: true }] },
    { key: 'Space', expect: [{ selector: '#dialog', visible: true }, { selector: '#close', focused: true }] },
    { key: 'Escape', expect: [{ selector: '#dialog', visible: false }, { selector: '#open', focused: true }] },
    { key: 'Shift+Tab', expect: [{ selector: '#toggle', focused: true }] },
  ] });
  expect(response.isError()).not.toBe(true);
  expect(report.status).toBe('passed');
  expect(report.steps).toHaveLength(10);
  expect(report.steps.every((step: { status: string }) => step.status === 'passed')).toBe(true);
});

it('samples expectations together even if focus changes after the first observation', async () => {
  await page.setContent(`<input id="first" value="one"><button id="second">Two</button><script>
    const first = document.getElementById('first');
    const second = document.getElementById('second');
    Object.defineProperty(first, 'value', {
      get() {
        queueMicrotask(() => second.focus());
        return 'one';
      },
    });
  </script>`);
  const { report } = await audit({ reportFile: 'report.json', timeoutMs: 0, steps: [
    { key: 'Tab', expect: [{ selector: '#first', focused: true, value: 'one' }, { selector: '#second', focused: true }] },
  ] });
  expect(report.status).toBe('failed');
  expect(report.findings).toEqual([expect.objectContaining({ selector: '#second', property: 'focused' })]);
  await expect(page.locator('#second').evaluate(element => element === document.activeElement)).resolves.toBe(true);
});

it('marks selector matches that change across the observation incomplete', async () => {
  await page.setContent(`<input id="trigger"><button id="other">Other</button><script>
    Object.defineProperty(document.getElementById('trigger'), 'value', {
      get() {
        queueMicrotask(() => document.getElementById('other').classList.add('appeared'));
        return 'one';
      },
    });
  </script>`);
  const { report } = await audit({ reportFile: 'report.json', timeoutMs: 0, steps: [
    { key: 'Tab', expect: [{ selector: '#trigger', value: 'one' }, { selector: '.appeared', visible: false }] },
  ] });
  expect(report.status).toBe('incomplete');
  expect(report.reason).toBe('A selector changed matches during expectation measurement.');
});

it('does not pass a transient focus state that is lost before the observation window ends', async () => {
  await page.setContent(`<button id="start">Start</button><button id="next">Next</button><script>
    document.addEventListener('keydown', event => {
      if (event.key === 'Tab' && event.target.id === 'start')
        setTimeout(() => document.getElementById('start').focus(), 10);
    });
  </script>`);
  const { report } = await audit({ reportFile: 'report.json', timeoutMs: 80, steps: [
    { key: 'Tab', expect: [{ selector: '#start', focused: true }] },
    { key: 'Tab', expect: [{ selector: '#next', focused: true }] },
  ] });
  expect(report.status).toBe('failed');
  expect(report.steps.map((step: { status: string }) => step.status)).toEqual(['passed', 'failed']);
  expect(report.findings).toEqual([expect.objectContaining({ step: 2, selector: '#next', property: 'focused' })]);
});

it('observes a legitimate asynchronous expected state within the supplied window', async () => {
  await page.setContent(`<button id="toggle" aria-expanded="false">Toggle</button><script>
    document.getElementById('toggle').addEventListener('click', () => {
      setTimeout(() => document.getElementById('toggle').setAttribute('aria-expanded', 'true'), 10);
    });
  </script>`);
  const { report } = await audit({ reportFile: 'report.json', timeoutMs: 80, steps: [
    { key: 'Tab', expect: [{ selector: '#toggle', focused: true }] },
    { key: 'Enter', expect: [{ selector: '#toggle', expanded: true }] },
  ] });
  expect(report.status).toBe('passed');
  expect(report.steps.every((step: { status: string }) => step.status === 'passed')).toBe(true);
});

it.each([true, false])('measures an initially absent progress state at the deadline (becomes available: %s)', async becomesAvailable => {
  await page.setContent(`<button id="start">Start</button><div id="progress" role="progressbar"></div><script>
    document.getElementById('start').onclick = () => {
      if (${becomesAvailable})
        setTimeout(() => document.getElementById('progress').setAttribute('aria-valuenow', '100'), 10);
    };
  </script>`);
  const { report } = await audit({ reportFile: 'report.json', timeoutMs: 80, steps: [
    { key: 'Tab', expect: [{ selector: '#start', focused: true }] },
    { key: 'Enter', expect: [{ selector: '#progress', value: '100' }] },
    { key: 'Space', expect: [{ selector: '#start', focused: true }] },
  ] });
  expect(report.status).toBe(becomesAvailable ? 'passed' : 'incomplete');
  expect(report.steps[1].status).toBe(becomesAvailable ? 'passed' : 'incomplete');
  expect(report.steps[2].status).toBe(becomesAvailable ? 'passed' : 'not-run');
});

it('types and edits the focused field through keyboard events without reporting the supplied text', async () => {
  await page.setContent(`<input id="field"><script>
    window.events = [];
    for (const type of ['keydown', 'beforeinput', 'input', 'keyup'])
      document.getElementById('field').addEventListener(type, event => window.events.push({ type, key: event.key, trusted: event.isTrusted, inputType: event.inputType }));
  </script>`);
  const { report, response } = await audit({ reportFile: 'report.json', timeoutMs: 0, steps: [
    { key: 'Tab', expect: [{ selector: '#field', focused: true }] },
    { text: 'secret', expect: [{ selector: '#field', value: 'secret' }] },
    { key: 'Backspace', expect: [{ selector: '#field', value: 'secre' }] },
    { key: 'ControlOrMeta+A', expect: [{ selector: '#field', focused: true }] },
    { key: 'Delete', expect: [{ selector: '#field', value: '' }] },
    { text: 'ok', expect: [{ selector: '#field', value: 'ok' }] },
  ] });
  expect(report.status).toBe('passed');
  expect(report.steps[1]).toEqual({ step: 2, action: 'type', characterCount: 6, status: 'passed', checks: [{ selector: '#field', property: 'value', passed: true }] });
  expect(report.steps[0]).toEqual({ step: 1, key: 'Tab', status: 'passed', checks: [{ selector: '#field', property: 'focused', passed: true }] });
  expect(await page.evaluate('window.events')).toEqual(expect.arrayContaining([
    { type: 'keydown', key: 's', trusted: true },
    { type: 'beforeinput', trusted: true, inputType: 'insertText' },
    { type: 'input', trusted: true, inputType: 'insertText' },
    { type: 'keyup', key: 's', trusted: true },
    { type: 'input', trusted: true, inputType: 'deleteContentBackward' },
    { type: 'input', trusted: true, inputType: 'deleteContentForward' },
  ]));
  expect(JSON.stringify(report)).not.toContain('secret');
  expect(JSON.stringify(response.serialize())).not.toContain('secret');
});

it.each(['focus-theft', 'replacement', 'readonly', 'disabled'])('stops typing into the original identity on %s', async interruption => {
  const change = {
    'focus-theft': "document.getElementById('other').focus()",
    'replacement': 'const replacement = field.cloneNode(); field.replaceWith(replacement); replacement.focus()',
    'readonly': 'field.readOnly = true',
    'disabled': 'field.disabled = true',
  }[interruption];
  await page.setContent(`<input id="field"><input id="other"><script>
    const field = document.getElementById('field');
    field.addEventListener('input', () => { document.body.dataset.typed = field.value; ${change}; }, { once: true });
  </script>`);
  const { report, response } = await audit({ reportFile: 'report.json', timeoutMs: 0, steps: [
    { key: 'Tab', expect: [{ selector: '#field', focused: true }] },
    { text: 'secret', expect: [{ selector: '#field', value: 'secret' }] },
    { key: 'Tab', expect: [{ selector: '#other', focused: true }] },
  ] });
  expect(report.status).toBe('incomplete');
  expect(response.isError()).toBe(true);
  expect(report.steps.map((step: { status: string }) => step.status)).toEqual(['passed', 'incomplete', 'not-run']);
  expect(await page.locator('body').getAttribute('data-typed')).toBe('s');
  expect(await page.locator('#field').inputValue()).toBe('s');
  expect(await page.locator('#other').inputValue()).toBe('');
  expect(JSON.stringify(report)).not.toContain('secret');
  expect(JSON.stringify(response.serialize())).not.toContain('secret');
});

it.each(['cancel', 'modal'])('stops text input on %s before later characters or steps', async interruption => {
  await page.setContent('<input id="field"><input id="other">');
  const controller = new AbortController();
  await page.exposeFunction('cancelTyping', () => controller.abort());
  await page.evaluate(`document.querySelector('#field').addEventListener('input', () => { ${interruption === 'modal' ? "alert('stop')" : 'void window.cancelTyping()'}; }, { once: true });`);
  const { report, response } = await audit({ reportFile: 'report.json', timeoutMs: 0, steps: [
    { key: 'Tab', expect: [{ selector: '#field', focused: true }] },
    { text: 'secret', expect: [{ selector: '#field', value: 'secret' }] },
    { key: 'Tab', expect: [{ selector: '#other', focused: true }] },
  ] }, controller.signal);
  expect(report.status).toBe('incomplete');
  expect(report.reason).toBe(interruption === 'modal' ? 'A browser modal interrupted the scenario.' : 'The scenario was cancelled.');
  expect(response.isError()).toBe(true);
  expect(report.steps[2].status).toBe('not-run');
  if (interruption === 'modal') {
    const modal = context.currentTabOrDie().modalStates().find(state => state.type === 'dialog');
    await modal?.dialog.dismiss();
  }
  expect(await page.locator('#field').inputValue()).toBe('s');
  expect(await page.locator('#other').inputValue()).toBe('');
});

it.each(['body', 'button', 'readonly', 'iframe'])('does not redirect text from unsupported %s focus', async target => {
  await page.setContent('<button id="button">Start</button><input id="readonly" readonly><input id="other"><iframe srcdoc="<input id=inner>"></iframe>');
  if (target === 'iframe')
    await page.frameLocator('iframe').locator('input').focus();
  else if (target !== 'body')
    await page.locator(`#${target}`).focus();
  const { report, response } = await audit({ reportFile: 'report.json', timeoutMs: 0, steps: [
    { text: 'secret', expect: [{ selector: '#other', value: 'secret' }] },
    { key: 'Tab', expect: [{ selector: '#other', focused: true }] },
  ] });
  expect(report.status).toBe('incomplete');
  expect(response.isError()).toBe(true);
  expect(report.steps[1].status).toBe('not-run');
  expect(await page.locator('#other').inputValue()).toBe('');
  expect(await page.frameLocator('iframe').locator('input').inputValue()).toBe('');
});

it('types Unicode and newline input into a textarea in an open shadow root', async () => {
  await page.setContent(`<div id="host"></div><script>
    document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<textarea id="field"></textarea>';
  </script>`);
  const { report } = await audit({ reportFile: 'report.json', timeoutMs: 0, steps: [
    { key: 'Tab', expect: [{ selector: '#field', focused: true }] },
    { text: 'a\r\n🙂é', expect: [{ selector: '#field', value: 'a\n🙂é' }] },
  ] });
  expect(report.status).toBe('passed');
  expect(await page.locator('#field').inputValue()).toBe('a\n🙂é');
  expect(report.steps[1].characterCount).toBe(5);
});

it('types into the focused contenteditable without selecting a different node', async () => {
  await page.setContent('<div id="field" contenteditable></div>');
  const { report } = await audit({ reportFile: 'report.json', timeoutMs: 0, steps: [
    { key: 'Tab', expect: [{ selector: '#field', focused: true }] },
    { text: 'editable', expect: [{ selector: '#field', text: 'editable' }] },
  ] });
  expect(report.status).toBe('passed');
  expect(await page.locator('#field').textContent()).toBe('editable');
});

it.each([
  { broken: 'button', expectation: { selector: '#start', expanded: true } },
  { broken: 'menu', expectation: { selector: '#menu', visible: true } },
  { broken: 'dialog', expectation: { selector: '#dialog', visible: true } },
  { broken: 'focus', expectation: { selector: '#next', focused: true } },
])('finds a broken $broken outcome and does not execute later keys', async ({ expectation }) => {
  await page.setContent(`<button id="start" aria-expanded="false">Start</button><div id="menu" hidden>Menu</div><dialog id="dialog">Dialog</dialog><button id="next">Next</button>
    <script>window.keyCount = 0; document.addEventListener('keydown', () => window.keyCount++);</script>`);
  const { report, response } = await audit({ reportFile: 'report.json', timeoutMs: 20, steps: [
    { key: 'Tab', expect: [{ selector: '#start', focused: true }] },
    { key: 'Enter', expect: [expectation] },
    { key: 'Tab', expect: [{ selector: '#next', focused: true }] },
  ] });
  expect(response.isError()).not.toBe(true);
  expect(report.status).toBe('failed');
  expect(report.findings).toHaveLength(1);
  expect(report.steps.map((step: { status: string }) => step.status)).toEqual(['passed', 'failed', 'not-run']);
  expect(await page.evaluate('window.keyCount')).toBe(2);
});

it.each([
  { container: 'closed details', visible: false, markup: '<details><summary>More</summary><p id="content">Collapsed</p></details>' },
  { container: 'hidden=until-found', visible: false, markup: '<div hidden="until-found"><p id="content">Collapsed</p></div>' },
  { container: 'open details', visible: true, markup: '<details open><summary>More</summary><p id="content">Expanded</p></details>' },
])('measures content in $container as visible: $visible', async ({ visible, markup }) => {
  await page.setContent(`<button id="start">Start</button>${markup}`);
  const { report } = await audit({ reportFile: 'report.json', timeoutMs: 0, steps: [
    { key: 'Tab', expect: [{ selector: '#start', focused: true }, { selector: '#content', visible }] },
  ] });
  expect(report.status).toBe('passed');
  expect(report.steps[0].checks).toEqual([
    { selector: '#start', property: 'focused', passed: true },
    { selector: '#content', property: 'visible', passed: true },
  ]);
});

it('measures native and ARIA state, dynamic future targets, exact text, and values without storing secret values', async () => {
  await page.setContent(`<input id="check" type="checkbox"><input id="range" type="range" min="0" max="2" value="0"><button id="create">Create</button>
    <script>document.getElementById('create').onclick = () => { const result = document.createElement('div'); result.id = 'future'; result.textContent = 'sensitive result'; document.body.append(result); };</script>`);
  const { report } = await audit({ reportFile: 'report.json', timeoutMs: 20, steps: [
    { key: 'Tab', expect: [{ selector: '#check', checked: false, disabled: false }] },
    { key: 'Space', expect: [{ selector: '#check', checked: true }] },
    { key: 'Tab', expect: [{ selector: '#range', focused: true }] },
    { key: 'ArrowRight', expect: [{ selector: '#range', value: '1' }] },
    { key: 'Tab', expect: [{ selector: '#create', focused: true }] },
    { key: 'Enter', expect: [{ selector: '#future', visible: true, text: 'sensitive result' }] },
  ] });
  expect(report.status).toBe('passed');
  expect(JSON.stringify(report)).not.toContain('sensitive result');
});

it.each([
  { property: 'text', expectation: { selector: '#result', text: 'complete' } },
  { property: 'value', expectation: { selector: '#value', value: 'expected value' } },
])('reports an exact $property mismatch and does not execute later keys', async ({ property, expectation }) => {
  await page.setContent(`<button id=start>Start</button><p id=result>Action complete</p><input id=value value="actual value"><button id=next>Next</button>
    <script>document.documentElement.dataset.keyCount='0'; document.addEventListener('keydown',()=>document.documentElement.dataset.keyCount=String(Number(document.documentElement.dataset.keyCount)+1));</script>`);
  const { report } = await audit({ reportFile: 'report.json', timeoutMs: 0, steps: [
    { key: 'Tab', expect: [{ selector: '#start', focused: true }] },
    { key: 'Enter', expect: [expectation] },
    { key: 'Tab', expect: [{ selector: '#value', focused: true }] },
  ] });
  expect(report.status).toBe('failed');
  expect(report.findings).toEqual([expect.objectContaining({ step: 2, selector: expectation.selector, property })]);
  expect(report.steps.map((step: { status: string }) => step.status)).toEqual(['passed', 'failed', 'not-run']);
  expect(await page.evaluate(() => Number(document.documentElement.dataset.keyCount))).toBe(2);
});

it('rejects malformed and unbounded input before actions', async () => {
  await page.setContent('<button>Start</button>');
  for (const args of [
    { steps: [] },
    { steps: [{ text: '', expect: [{ selector: 'input', focused: true }] }] },
    { steps: [{ text: 'x'.repeat(501), expect: [{ selector: 'input', focused: true }] }] },
    { steps: [{ key: 'Tab', text: 'x', expect: [{ selector: 'input', focused: true }] }] },
    { steps: [{ key: 'Control+a', expect: [{ selector: 'button', focused: true }] }] },
    { steps: [{ key: 'Enter', expect: [{ selector: 'button' }] }] },
    { steps: [{ key: 'Tab', expect: [{ selector: 'button', typo: true }] }] },
    { timeoutMs: 1001, steps: [{ key: 'Tab', expect: [{ selector: 'button', focused: true }] }] },
  ])
    expect(tool.schema.inputSchema.safeParse(args).success).toBe(false);
  expect(await page.locator('button').evaluate(element => element === document.activeElement)).toBe(false);
});

it('validates every selector before executing the first key', async () => {
  await page.setContent('<button>Start</button>');
  const { report, response } = await audit({ reportFile: 'report.json', steps: [
    { key: 'Tab', expect: [{ selector: 'button', focused: true }] },
    { key: 'Enter', expect: [{ selector: '[', visible: true }] },
  ] });
  expect(report.status).toBe('incomplete');
  expect(response.isError()).toBe(true);
  expect(report.steps.every((step: { status: string }) => step.status === 'not-run')).toBe(true);
  expect(await page.locator('button').evaluate(element => element === document.activeElement)).toBe(false);
});

it.each(['ambiguous', 'unsupported'])('marks %s measurements incomplete instead of passing or filing a defect', async kind => {
  await page.setContent('<button id="one">Start</button><button>Next</button>');
  const { report, response } = await audit({ reportFile: 'report.json', timeoutMs: 0, steps: [
    { key: 'Tab', expect: [kind === 'ambiguous' ? { selector: 'button', focused: true } : { selector: '#one', checked: false }] },
    { key: 'Enter', expect: [{ selector: '#one', focused: true }] },
  ] });
  expect(report.status).toBe('incomplete');
  expect(response.isError()).toBe(true);
  expect(report.findings).toEqual([]);
  expect(report.steps.map((step: { status: string }) => step.status)).toEqual(['incomplete', 'not-run']);
});

it.each([
  { interruption: 'navigation', reason: 'Main-frame navigation invalidated the scenario.' },
  { interruption: 'modal', reason: 'A browser modal interrupted the scenario.' },
  { interruption: 'cancel', reason: 'The scenario was cancelled.' },
])('stops the scenario on $interruption without issuing later keys', async ({ interruption, reason }) => {
  await page.setContent(`<button id="start">Start</button><button id="next">Next</button><script>
    document.getElementById('start').onclick = () => { ${interruption === 'navigation' ? "location.hash = 'changed'" : interruption === 'modal' ? "alert('stop')" : "document.body.dataset.started = 'yes'"} };
    window.keyCount = 0; document.addEventListener('keydown', () => window.keyCount++);
  </script>`);
  const controller = new AbortController();
  if (interruption === 'cancel') {
    await page.exposeFunction('cancelAudit', () => controller.abort());
    await page.evaluate("document.getElementById('start').addEventListener('click', () => window.cancelAudit())");
  }
  const { report, response } = await audit({ reportFile: 'report.json', timeoutMs: 300, steps: [
    { key: 'Tab', expect: [{ selector: '#start', focused: true }] },
    { key: 'Enter', expect: [{ selector: '#next', focused: true }] },
    { key: 'Tab', expect: [{ selector: '#next', focused: true }] },
  ] }, controller.signal);
  expect(report.status).toBe('incomplete');
  expect(report.reason).toBe(reason);
  expect(response.isError()).toBe(true);
  expect(report.steps[2].status).toBe('not-run');
  if (interruption !== 'modal')
    expect(await page.evaluate('window.keyCount')).toBe(2);
});

it('stops the scenario when a key opens a file chooser', async () => {
  await page.setContent(`<button id="start">Upload</button><input id="file" type="file" hidden><button id="next">Next</button><script>
    document.getElementById('start').onclick = () => document.getElementById('file').click();
    window.keyCount = 0; document.addEventListener('keydown', () => window.keyCount++);
  </script>`);
  const { report, response } = await audit({ reportFile: 'report.json', timeoutMs: 300, steps: [
    { key: 'Tab', expect: [{ selector: '#start', focused: true }] },
    { key: 'Enter', expect: [{ selector: '#start', focused: true }] },
    { key: 'Tab', expect: [{ selector: '#next', focused: true }] },
  ] });
  expect(report.status).toBe('incomplete');
  expect(report.reason).toBe('A browser modal interrupted the scenario.');
  expect(response.isError()).toBe(true);
  expect(report.steps.map((step: { status: string }) => step.status)).toEqual(['passed', 'incomplete', 'not-run']);
  expect(await page.evaluate('window.keyCount')).toBe(2);
});

it('waits for an explicitly expected asynchronous outcome without storing the observed text', async () => {
  await page.setContent(`<button id="start">Start</button><script>
    document.getElementById('start').onclick = () => setTimeout(() => {
      const result = document.createElement('div'); result.id = 'later'; result.textContent = 'done'; document.body.append(result);
    }, 40);
  </script>`);
  const { report } = await audit({ reportFile: 'report.json', timeoutMs: 300, steps: [
    { key: 'Tab', expect: [{ selector: '#start', focused: true }] },
    { key: 'Enter', expect: [{ selector: '#later', visible: true, text: 'done' }] },
  ] });
  expect(report.status).toBe('passed');
  expect(await page.locator('#later').textContent()).toBe('done');
});

it('reads focus inside open shadow roots and ARIA mixed/pressed/selected states', async () => {
  await page.setContent(`<div id="host"></div><script>
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<button id="mixed" role="checkbox" aria-checked="mixed">Mixed</button><button id="pressed" aria-pressed="false">Toggle</button><button id="selected" role="tab" aria-selected="false">Tab</button>';
    root.getElementById('pressed').onclick = event => event.target.setAttribute('aria-pressed', 'true');
  </script>`);
  const { report } = await audit({ reportFile: 'report.json', timeoutMs: 0, steps: [
    { key: 'Tab', expect: [{ selector: '#host #mixed:visible', focused: true, checked: 'mixed' }] },
    { key: 'Tab', expect: [{ selector: '#pressed', focused: true, pressed: false }] },
    { key: 'Space', expect: [{ selector: '#pressed', pressed: true }] },
    { key: 'Tab', expect: [{ selector: '#selected', focused: true, selected: false }] },
  ] });
  expect(report.status).toBe('passed');
});

it('honors cancellation before any key and releases page event listeners', async () => {
  await page.setContent('<button>Start</button>');
  const listeners = page.listenerCount('framenavigated');
  const controller = new AbortController();
  controller.abort();
  const { report, response } = await audit({ reportFile: 'report.json', steps: [
    { key: 'Tab', expect: [{ selector: 'button', focused: true }] },
  ] }, controller.signal);
  expect(report.status).toBe('incomplete');
  expect(response.isError()).toBe(true);
  expect(report.steps[0].status).toBe('not-run');
  expect(await page.locator('button').evaluate(element => element === document.activeElement)).toBe(false);
  expect(page.listenerCount('framenavigated')).toBe(listeners);
});
