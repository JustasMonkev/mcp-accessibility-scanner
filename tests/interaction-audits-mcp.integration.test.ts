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
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { contextFactory } from '../src/browserContextFactory.js';
import { resolveCLIConfig } from '../src/config.js';
import { wrapInProcess } from '../src/mcp/server.js';

const fixtureEvents = new Map<string, () => void>();
const cancelledAuditAdmissionPollIntervalMs = 25;
const server = http.createServer((request, response) => {
  const event = new URL(request.url ?? '/', 'http://localhost').pathname.match(/^\/test-event\/([^/]+)$/)?.[1];
  if (event) {
    fixtureEvents.get(event)?.();
    fixtureEvents.delete(event);
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(`<button id="toggle" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true')">Open</button>
    <form novalidate><label for="email">Email</label><input id="email" aria-describedby="error">
    <button id="submit">Submit</button><p id="error"></p></form>
    <script>
    window.interactions = { keys: 0, pointer: 0, submits: 0, value: '' };
    document.addEventListener('pointerdown', () => window.interactions.pointer++);
    document.addEventListener('keydown', () => fetch('/test-event/keyboard'));
    document.getElementById('email').addEventListener('keydown', event => {
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) window.interactions.keys++;
    });
    document.querySelector('form').onsubmit = event => {
      event.preventDefault();
      window.interactions.submits++;
      window.interactions.value = document.getElementById('email').value;
      document.getElementById('email').setAttribute('aria-invalid', 'true');
      document.getElementById('error').textContent = 'Enter a valid email';
    };</script>`);
});
let client: Client;
let directory: string;
let url: string;

function waitForFixtureEvent(name: string): Promise<void> {
  return new Promise(resolve => fixtureEvents.set(name, resolve));
}

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP fixture server');
  url = `http://127.0.0.1:${address.port}`;
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'interaction-audits-mcp-'));
  const config = await resolveCLIConfig({ browser: 'chromium', headless: true, isolated: true, outputDir: directory });
  client = new Client({ name: 'interaction-audits-test', version: '1' });
  await client.connect(await wrapInProcess(new BrowserServerBackend(config, contextFactory(config))));
});

afterAll(async () => {
  try {
    await client?.callTool({ name: 'browser_close', arguments: {} });
  } finally {
    await client?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (directory)
      await fs.rm(directory, { recursive: true, force: true });
  }
});

it('publishes non-idempotent mutation annotations and runs both audits through MCP with saved reports', async () => {
  const catalog = await client.listTools();
  for (const name of ['audit_keyboard_operation', 'audit_form_validation']) {
    const tool = catalog.tools.find(tool => tool.name === name);
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
  }
  const navigate = await client.callTool({ name: 'browser_navigate', arguments: { url } });
  expect(navigate.isError).not.toBe(true);
  const keyboard = await client.callTool({ name: 'audit_keyboard_operation', arguments: {
    reportFile: 'keyboard.json',
    steps: [
      { key: 'Tab', expect: [{ selector: '#toggle', focused: true }] },
      { key: 'Enter', expect: [{ selector: '#toggle', expanded: true }] },
    ],
  } });
  expect(keyboard.isError).not.toBe(true);
  expect(keyboard.structuredContent).toMatchObject({ kind: 'audit_keyboard_operation' });
  const keyboardReport = JSON.parse(await fs.readFile(path.join(directory, 'keyboard.json'), 'utf8'));
  expect(keyboardReport.status).toBe('passed');
  expect(keyboardReport.steps.map((step: { status: string }) => step.status)).toEqual(['passed', 'passed']);

  const forms = await client.callTool({ name: 'audit_form_validation', arguments: {
    reportFile: 'forms.json', fields: [{ selector: '#email', value: 'invalid-email' }],
    submitSelector: '#submit', expectedFeedback: [{ selector: '#error', kind: 'error' }],
  } });
  expect(forms.isError).not.toBe(true);
  expect(forms.structuredContent).toMatchObject({ kind: 'audit_form_validation' });
  const formReport = JSON.parse(await fs.readFile(path.join(directory, 'forms.json'), 'utf8'));
  expect(formReport.outcome).toBe('completed');
  expect(formReport.interactionMode).toBe('keyboard');
  expect(formReport.findings).toEqual([]);
  expect(formReport.observed.fields[0]).toMatchObject({ invalid: true, associatedErrors: ['#error'] });
  const interaction = await client.callTool({ name: 'browser_evaluate', arguments: {
    function: '() => window.interactions.keys === 13 && window.interactions.pointer === 0 && window.interactions.submits === 1 && window.interactions.value === "invalid-email"',
  } });
  expect(interaction.isError).not.toBe(true);
  expect(interaction.content.filter(item => item.type === 'text').map(item => item.text).join('\n')).toContain('true');
});

it('accepts text and editing steps through the MCP schema', async () => {
  await client.callTool({ name: 'browser_navigate', arguments: { url } });
  const result = await client.callTool({ name: 'audit_keyboard_operation', arguments: {
    steps: [
      { key: 'Tab', expect: [{ selector: '#toggle', focused: true }] },
      { key: 'Tab', expect: [{ selector: '#email', focused: true }] },
      { text: 'draft', expect: [{ selector: '#email', value: 'draft' }] },
      { key: 'Backspace', expect: [{ selector: '#email', value: 'draf' }] },
    ],
  } });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ status: 'passed' });
});

it('admits interactive audits exclusively per browser context and releases admission after cancellation', async () => {
  await client.callTool({ name: 'browser_navigate', arguments: { url } });
  const opened = await client.callTool({ name: 'browser_session_open', arguments: {} });
  const browserSessionId = opened.structuredContent?.browserSessionId;
  expect(typeof browserSessionId).toBe('string');
  await client.callTool({ name: 'browser_navigate', arguments: { url, browserSessionId } });

  const keyboardStarted = waitForFixtureEvent('keyboard');
  const audit = client.callTool({ name: 'audit_keyboard_operation', arguments: {
    timeoutMs: 1000,
    steps: [{ key: 'Tab', expect: [{ selector: '#toggle', focused: true }] }],
  } });
  await keyboardStarted;

  const competingMutation = await client.callTool({ name: 'browser_evaluate', arguments: {
    function: '() => document.querySelector("#toggle").click()',
  } });
  expect(competingMutation.isError).toBe(true);
  expect(competingMutation.content.filter(item => item.type === 'text').map(item => item.text).join('\n')).toContain('busy because an interactive audit is running');

  const independentContext = await client.callTool({ name: 'browser_evaluate', arguments: {
    browserSessionId,
    function: '() => document.querySelector("#toggle").getAttribute("aria-expanded")',
  } });
  expect(independentContext.isError).not.toBe(true);
  expect(independentContext.content.filter(item => item.type === 'text').map(item => item.text).join('\n')).toContain('false');

  const auditResult = await audit;
  expect(auditResult.isError).not.toBe(true);
  const afterAudit = await client.callTool({ name: 'browser_evaluate', arguments: {
    function: '() => document.querySelector("#toggle").getAttribute("aria-expanded")',
  } });
  expect(afterAudit.isError).not.toBe(true);
  expect(afterAudit.content.filter(item => item.type === 'text').map(item => item.text).join('\n')).toContain('false');

  const evaluationStarted = waitForFixtureEvent('evaluate');
  const ordinaryCall = client.callTool({ name: 'browser_evaluate', arguments: {
    function: '() => { fetch("/test-event/evaluate"); return new Promise(resolve => { window.releaseOrdinaryEvaluation = () => resolve("finished"); }); }',
  } });
  await evaluationStarted;
  try {
    const concurrentOrdinaryCall = await client.callTool({ name: 'browser_evaluate', arguments: {
      function: '() => "ordinary concurrency retained"',
    } });
    expect(concurrentOrdinaryCall.isError).not.toBe(true);
    const overlappingAudit = await client.callTool({ name: 'audit_form_validation', arguments: {
      fields: [{ selector: '#email', value: 'invalid-email' }], submitSelector: '#submit',
      expectedFeedback: [{ selector: '#error', kind: 'error' }],
    } });
    expect(overlappingAudit.isError).toBe(true);
    expect(overlappingAudit.content.filter(item => item.type === 'text').map(item => item.text).join('\n')).toContain('interactive audits require exclusive access');
  } finally {
    const release = await client.callTool({ name: 'browser_evaluate', arguments: {
      function: '() => { window.releaseOrdinaryEvaluation?.(); delete window.releaseOrdinaryEvaluation; return "ordinary evaluation released"; }',
    } });
    expect(release.isError).not.toBe(true);
    await ordinaryCall;
  }

  const controller = new AbortController();
  const cancelledAuditStarted = waitForFixtureEvent('keyboard');
  const cancelledAudit = client.callTool({ name: 'audit_keyboard_operation', arguments: {
    reportFile: 'cancelled-keyboard.json',
    timeoutMs: 1000,
    steps: [{ key: 'Tab', expect: [{ selector: '#toggle', focused: true }] }],
  } }, { signal: controller.signal });
  await cancelledAuditStarted;
  controller.abort();
  await cancelledAudit.catch(() => undefined);
  let released = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const afterCancellation = await client.callTool({ name: 'browser_evaluate', arguments: {
      function: '() => "released"',
    } });
    if (!afterCancellation.isError) {
      released = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, cancelledAuditAdmissionPollIntervalMs));
  }
  expect(released).toBe(true);
  const cancelledReport = JSON.parse(await fs.readFile(path.join(directory, 'cancelled-keyboard.json'), 'utf8'));
  expect(cancelledReport.status).toBe('incomplete');
  expect(cancelledReport.reason).toBe('The scenario was cancelled.');
  expect(cancelledReport.steps[0].status).toBe('incomplete');
  await client.callTool({ name: 'browser_session_close', arguments: { browserSessionId } });
});
