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
  page.on('dialog', dialog => modalStates.push({ type: 'dialog', dialog, description: 'Dialog' }));
  const outputFile = async (name: string) => path.join(directory, name);
  const tab = { page, modalStates: () => modalStates, context: { outputFile } };
  context = { currentTabOrDie: () => tab, config: { filePaths: 'absolute' } } as Context;
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

it.each(['navigation', 'modal', 'cancel'])('stops the scenario on %s without issuing later keys', async interruption => {
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
  expect(response.isError()).toBe(true);
  expect(report.steps[2].status).toBe('not-run');
  if (interruption !== 'modal')
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
    { key: 'Tab', expect: [{ selector: '#mixed', focused: true, checked: 'mixed' }] },
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
