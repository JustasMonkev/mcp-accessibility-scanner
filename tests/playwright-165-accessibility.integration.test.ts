/**
 * Copyright (c) Microsoft Corporation.
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
import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';
import * as playwright from 'playwright';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { resolveConfig } from '../src/config.js';
import { parseAriaSnapshot } from '../src/tools/auditScreenReader.js';

const browserName = process.env.MCP_TEST_BROWSER_NAME || 'chromium';
if (browserName !== 'chromium' && browserName !== 'firefox' && browserName !== 'webkit')
  throw new Error(`Unsupported MCP_TEST_BROWSER_NAME: ${browserName}`);
const browserType = playwright[browserName];
const channel = process.env.MCP_TEST_BROWSER_CHANNEL;
if (channel && browserName !== 'chromium')
  throw new Error('MCP_TEST_BROWSER_CHANNEL requires chromium');
const require = createRequire(import.meta.url);
let browser: playwright.Browser | undefined;
let backend: BrowserServerBackend | undefined;
let directory: string | undefined;

afterEach(async () => {
  try {
    backend?.serverClosed();
    await browser?.close();
  } finally {
    if (directory)
      await fs.rm(directory, { recursive: true, force: true });
    browser = backend = directory = undefined;
  }
});

async function setup(defaultTimeout = 5000) {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-pw165-a11y-'));
  const launched = await browserType.launch({ channel });
  browser = launched;
  const context = await launched.newContext();
  const page = await context.newPage();
  backend = new BrowserServerBackend(await resolveConfig({
    outputDir: directory, capabilities: ['verify'],
    timeouts: { navigationTimeout: 3000, defaultTimeout, settle: 0 },
  }), { createContext: async () => ({ browserContext: context, close: () => context.close() }) });
  await backend.initialize({ notifyToolListChanged: async () => {} }, { name: 'pw165-a11y', version: '1' });
  await ok('browser_snapshot');
  process.stdout.write(JSON.stringify({ browserName, channel: channel || 'bundled', browserVersion: launched.version(),
    playwright: require('playwright/package.json').version, playwrightCore: require('playwright-core/package.json').version }) + '\n');
  return page;
}

async function call(name: string, args = {}) {
  const result = await backend!.callTool(name, args);
  return { ...result, text: result.content.filter(item => item.type === 'text').map(item => item.text).join('\n') };
}

async function ok(name: string, args = {}) {
  const result = await call(name, args);
  expect(result.isError, result.text).not.toBe(true);
  return result.text;
}

function ref(snapshot: string, role: string, name: string) {
  const node = parseAriaSnapshot(snapshot).find(node => node.role === role && node.name === name);
  expect(node?.ref, snapshot).toBeTruthy();
  return node!.ref!;
}

it('keeps identifying container names and audits distilled control names (#325)', async () => {
  const page = await setup();
  await page.setContent(`<nav aria-labelledby="nav-name"><h2 id="nav-name">Account navigation</h2><a href="/docs"><strong>Docs</strong></a></nav>
    <dialog open aria-labelledby="dialog-name"><h2 id="dialog-name">Account settings</h2><button>Save</button></dialog>
    <table aria-labelledby="table-name"><caption id="table-name">Account balances</caption><tr><th>Customer</th><th>Balance</th></tr><tr><td>Ada</td><td>42</td></tr></table>
    <a href="/empty"><svg aria-hidden="true"></svg></a>`);
  const snapshot = await ok('browser_snapshot');
  const nodes = parseAriaSnapshot(snapshot);
  for (const [role, name] of [['navigation', 'Account navigation'], ['dialog', 'Account settings'], ['table', 'Account balances'], ['columnheader', 'Customer'], ['columnheader', 'Balance']])
    expect(nodes.some(node => node.role === role && node.name === name), snapshot).toBe(true);
  expect(nodes.filter(node => node.role === 'link').map(node => node.name), snapshot).toEqual([null, null]);
  await page.setContent('<a href="/docs"><strong>Docs</strong></a><button>Save</button><a href="/empty"><svg aria-hidden="true"></svg></a>');
  const audit = await ok('audit_screen_reader', { checkReadingOrder: false, reportFile: 'screen-reader.json' });
  const report = JSON.parse(await fs.readFile(path.join(directory!, 'screen-reader.json'), 'utf8'));
  expect(report.elements.unresolved, audit).toBe(0);
  expect(report.elements.unmeasuredNames, audit).toBe(0);
  expect(report.findings.map((finding: { check: string, role: string }) => [finding.check, finding.role])).toEqual([['missing-accessible-name', 'link']]);
  process.stdout.write(JSON.stringify({ case: 'container-names-and-distilled-audit', snapshot, report }) + '\n');
});

it('excludes unrendered light-DOM and closed-details text with slotted/open controls (#257)', async () => {
  const page = await setup();
  await page.setContent(`<div id="unslotted" role="button">Light</div>
    <div id="slotted" role="button">Slotted</div>
    <details id="closed"><summary>Closed section</summary>Hidden detail text</details>
    <details open><summary>Open section</summary>Rendered detail text</details>`);
  await page.evaluate(() => {
    document.querySelector('#unslotted')!.attachShadow({ mode: 'open' }).innerHTML = 'Shadow';
    document.querySelector('#slotted')!.attachShadow({ mode: 'open' }).innerHTML = '<slot></slot> suffix';
  });
  const snapshot = await ok('browser_snapshot');
  expect(snapshot).toContain('button "Shadow"');
  expect(snapshot).toContain('button "Slotted suffix"');
  expect(snapshot).not.toContain('Light');
  expect(snapshot).not.toContain('Hidden detail text');
  expect(snapshot).toContain('Closed section');
  expect(snapshot).toContain('Rendered detail text');
  for (const name of ['Shadow', 'Slotted suffix']) {
    expect(await ok('browser_find', { text: name })).toContain(`button "${name}"`);
    await ok('browser_verify_element_visible', { role: 'button', accessibleName: name });
  }
  expect(await ok('browser_find', { text: 'Light' })).toContain('No matches found');
  expect((await call('browser_verify_element_visible', { role: 'button', accessibleName: 'LightShadow' })).isError).toBe(true);
  await page.locator('#closed').evaluate(element => element.setAttribute('open', ''));
  expect(await ok('browser_snapshot')).toContain('Hidden detail text');
});

it('uses reflected label references, including shadow labels and nonempty attribute precedence (#293)', async () => {
  const page = await setup();
  await page.setContent(`<span id="before">Before label</span><span id="after">Reflected label</span>
    <div id="group" role="group" aria-labelledby="before"><button>Group action</button></div>
    <div id="host"></div>`);
  await ok('browser_verify_element_visible', { role: 'group', accessibleName: 'Before label' });
  const support = await page.evaluate(() => 'ariaLabelledByElements' in document.querySelector('#group')!);
  expect(support, `${browserName} must support reflected ARIA label references`).toBe(true);
  const attribute = await page.evaluate(() => {
    const group = document.querySelector('#group')!;
    group.ariaLabelledByElements = [document.querySelector('#after')!];
    const shadow = document.querySelector('#host')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<span id="label">Shadow label</span><div role="group"><button>Shadow action</button></div>';
    shadow.querySelector('[role=group]')!.ariaLabelledByElements = [shadow.querySelector('#label')!];
    return group.getAttribute('aria-labelledby');
  });
  expect(attribute).toBe('');
  const snapshot = await ok('browser_snapshot');
  for (const name of ['Reflected label', 'Shadow label']) {
    expect(snapshot).toContain(`group "${name}"`);
    expect(await ok('browser_find', { text: name })).toContain(`group "${name}"`);
    await ok('browser_verify_element_visible', { role: 'group', accessibleName: name });
  }
  expect((await call('browser_verify_element_visible', { role: 'group', accessibleName: 'Before label' })).isError).toBe(true);
  await page.locator('#group').evaluate(element => element.setAttribute('aria-labelledby', 'before'));
  await ok('browser_verify_element_visible', { role: 'group', accessibleName: 'Before label' });
});

it('stitches iframe fallback text identically and keeps child refs usable (#296, #298)', async () => {
  const page = await setup();
  const snapshots: string[] = [];
  for (const fallback of ['', 'Your browser does not support frames']) {
    await page.setContent(`<iframe title="Child frame" srcdoc="<button onclick='this.textContent=&quot;Child clicked&quot;'>Child action</button>">${fallback}</iframe>`);
    await page.frameLocator('iframe').getByRole('button', { name: 'Child action' }).waitFor({ timeout: 10000 });
    const snapshot = await ok('browser_snapshot');
    snapshots.push(snapshot.replace(/\[ref=[^\]]+\]/g, '[ref]'));
    expect(snapshot).not.toContain('Your browser does not support frames');
    const child = ref(snapshot, 'button', 'Child action');
    expect(await ok('browser_find', { text: 'Child action' })).toContain('Child action');
    expect(await ok('browser_click', { element: 'Child action', ref: child })).toContain('Child clicked');
    expect(await page.frameLocator('iframe').getByRole('button').textContent()).toBe('Child clicked');
  }
  expect(snapshots[1]).toBe(snapshots[0]);
  await page.setContent('<iframe title="Empty frame" srcdoc="">Your browser does not support frames</iframe>');
  await page.frameLocator('iframe').locator('body').waitFor({ state: 'attached', timeout: 10000 });
  const empty = await ok('browser_snapshot');
  // Upstream clears fallback text only when a nonempty child tree is stitched.
  expect(empty).toMatch(/- iframe \[ref=[^\]]+\]: Your browser does not support frames/);
  expect(empty).not.toContain('Child action');
  process.stdout.write(JSON.stringify({ case: 'empty-frame-control', snapshot: empty }) + '\n');
});

it.each([
  { tool: 'browser_click', role: 'button', name: 'Action', args: {} },
  { tool: 'browser_type', role: 'textbox', name: 'Text', args: { text: 'changed' } },
  { tool: 'browser_select_option', role: 'combobox', name: 'Choice', args: { values: ['new'] } },
])('rejects $tool on newly inert content and recovers after removal (#325)', async ({ tool, role, name, args }) => {
  const page = await setup(1000);
  await page.setContent(`<section id="content"><button onclick="this.textContent='Clicked'">Action</button>
    <input aria-label="Text"><select aria-label="Choice"><option value="old">Old</option><option value="new">New</option></select></section>`);
  const snapshot = await ok('browser_snapshot');
  const target = ref(snapshot, role, name);
  await page.evaluate(() => document.querySelector('#content')!.setAttribute('inert', ''));
  const started = Date.now();
  const result = await call(tool, { element: name, ref: target, ...args });
  expect(result.isError, result.text).toBe(true);
  expect(result.text).toContain('Timeout 1000ms exceeded');
  expect(result.text).toMatch(/inert/i);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(await page.locator('button').textContent()).toBe('Action');
  expect(await page.locator('input').inputValue()).toBe('');
  expect(await page.locator('select').inputValue()).toBe('old');
  process.stdout.write(JSON.stringify({ case: 'inert-action', tool, error: result.text }) + '\n');
  await page.evaluate(() => document.querySelector('#content')!.removeAttribute('inert'));
  const recovered = await ok('browser_snapshot');
  await ok(tool, { element: name, ref: ref(recovered, role, name), ...args });
  if (tool === 'browser_click')
    expect(await page.locator('button').textContent()).toBe('Clicked');
  if (tool === 'browser_type')
    expect(await page.locator('input').inputValue()).toBe('changed');
  if (tool === 'browser_select_option')
    expect(await page.locator('select').inputValue()).toBe('new');
});

it('audits keyboard focus inside a modal without entering inert background content (#325)', async () => {
  const page = await setup();
  await page.setContent('<button>Background action</button><dialog><input aria-label="Modal field"><button>Modal save</button></dialog>');
  await page.locator('dialog').evaluate(element => {
    if (!(element instanceof HTMLDialogElement))
      throw new Error('Expected dialog fixture');
    element.showModal();
  });
  const audit = await ok('audit_keyboard', { maxTabs: 6, checkSkipLink: false, reportFile: 'keyboard.json' });
  const report = JSON.parse(await fs.readFile(path.join(directory!, 'keyboard.json'), 'utf8'));
  expect(report.stops.length, audit).toBeGreaterThan(0);
  const names = report.stops.map((stop: { name: string | null }) => stop.name).filter(Boolean);
  expect(names).toContain('Modal save');
  expect(names).not.toContain('Background action');
  process.stdout.write(JSON.stringify({ case: 'modal-keyboard-audit', report }) + '\n');
});

it('matches mixed-case ARIA roles and states with lowercase controls (#303)', async () => {
  const page = await setup();
  await page.setContent(`<div role="Button" aria-label="Mixed action" aria-pressed="True" aria-expanded="True">Mixed action</div>
    <div role="button" aria-label="Lower action" aria-pressed="true" aria-expanded="true">Lower action</div>
    <div role="checkbox" aria-checked="True" aria-label="Mixed check"></div>
    <div role="checkbox" aria-checked="true" aria-label="Lower check"></div>
    <div role="textbox" contenteditable aria-readonly="True" aria-label="Mixed read only"></div>
    <div role="textbox" contenteditable aria-readonly="true" aria-label="Lower read only"></div>
    <input aria-label="Mixed invalid" aria-invalid="Spelling">
    <input aria-label="Lower invalid" aria-invalid="spelling">`);
  const snapshot = await ok('browser_snapshot');
  process.stdout.write(JSON.stringify({ case: 'mixed-case-aria', snapshot }) + '\n');
  for (const prefix of ['Mixed', 'Lower']) {
    expect(await page.getByRole('button', { name: `${prefix} action`, pressed: true, expanded: true }).count()).toBe(1);
    expect(await page.getByRole('checkbox', { name: `${prefix} check`, checked: true }).count()).toBe(1);
    expect(await page.getByRole('textbox', { name: `${prefix} read only` }).isEditable()).toBe(false);
    await ok('browser_verify_element_visible', { role: 'textbox', accessibleName: `${prefix} read only` });
    for (const [role, suffix, state] of [
      ['button', 'action', '[pressed]'], ['button', 'action', '[expanded]'],
      ['checkbox', 'check', '[checked]'],
      ['textbox', 'invalid', '[invalid=spelling]'],
    ]) {
      const line = snapshot.split('\n').find(line => line.includes(`${role} "${prefix} ${suffix}"`));
      expect(line, snapshot).toContain(state);
      await ok('browser_