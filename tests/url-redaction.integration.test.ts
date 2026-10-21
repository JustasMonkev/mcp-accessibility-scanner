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
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/client';
import { createConnection } from '../src/index.js';
import { InProcessTransport } from '../src/mcp/inProcessTransport.js';
import { Context } from '../src/context.js';
import { Tab } from '../src/tab.js';
import { SessionLog } from '../src/sessionLog.js';
import { resolveConfig } from '../src/config.js';

afterEach(() => vi.restoreAllMocks());

it.each([false, true])('renders URL parameters through real MCP without changing browser inputs (enabled: %s)', async enabled => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-url-redaction-'));
  const browser = await chromium.launch({ headless: true });
  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();
  const seen: string[] = [];
  await browserContext.setExtraHTTPHeaders({ Authorization: 'synthetic-header-secret' });
  await browserContext.route('http://redaction.test/**', async route => {
    seen.push(route.request().url());
    await route.fulfill({ contentType: 'text/html', body: `<html lang="en"><title>Fixture</title><main><a href="/next?code=synthetic-link-secret&keep=visible">Next</a><input aria-label="URL"></main></html>` });
  });
  const server = await createConnection({
    redactUrlParams: enabled ? ['code', 'access_token'] : undefined,
    saveSession: enabled,
    outputDir: folder,
    timeouts: { settle: 0 },
  }, async () => browserContext);
  const client = new Client({ name: 'url-redaction-fixture', version: '1' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await client.connect(new InProcessTransport(server));
  const url = 'http://redaction.test/start?code=synthetic-query-secret&c%6Fde=synthetic-encoded-secret&keep=visible#ACCESS_TOKEN=synthetic-fragment-secret';
  try {
    const navigate = await client.callTool({ name: 'browser_navigate', arguments: { url } });
    expect(navigate.isError, JSON.stringify(navigate)).not.toBe(true);
    expect(page.url()).toBe(new URL(url).href);
    expect(new URL(page.url()).searchParams.get('code')).toBe('synthetic-query-secret');
    expect(seen[0]).toContain('code=synthetic-query-secret');
    expect(seen[0]).toContain('c%6Fde=synthetic-encoded-secret');
    const output = JSON.stringify(navigate);
    for (const secret of ['synthetic-query-secret', 'synthetic-fragment-secret', 'synthetic-link-secret']) {
      if (enabled)
        expect(output).not.toContain(secret);
      else
        expect(output).toContain(secret);
    }
    expect(output).toContain('keep=visible');
    expect(output).toContain('c%6Fde=synthetic-encoded-secret');

    const tabs = await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
    expect(tabs.isError, JSON.stringify(tabs)).not.toBe(true);
    expect(JSON.stringify(tabs)).toContain(enabled ? url.replace('synthetic-query-secret', 'REDACTED').replace('synthetic-fragment-secret', 'REDACTED') : url);

    const evaluated = await client.callTool({ name: 'browser_evaluate', arguments: { function: '() => ({ url: location.href })' } });
    expect(evaluated.isError, JSON.stringify(evaluated)).not.toBe(true);
    expect(JSON.stringify(evaluated).includes('synthetic-query-secret')).toBe(!enabled);
    expect(page.url()).toBe(new URL(url).href);

    const listing = await client.callTool({ name: 'browser_network_requests', arguments: {} });
    const firstId = JSON.stringify(listing).match(/\[(\d+)\] \[GET\] http:\/\/redaction\.test\/start/)?.[1];
    expect(firstId).toBeDefined();
    const details = await client.callTool({ name: 'browser_network_request', arguments: { index: Number(firstId) } });
    expect(details.isError, JSON.stringify(details)).not.toBe(true);
    expect(JSON.stringify(details)).not.toContain('synthetic-header-secret');
    expect(JSON.stringify(details)).toContain('<redacted,');

    if (enabled) {
      const audit = await client.callTool({ name: 'audit_keyboard', arguments: { maxTabs: 1, checkSkipLink: false, reportFile: 'redaction-audit.json' } });
      expect(audit.isError, JSON.stringify(audit)).not.toBe(true);
      expect(JSON.stringify(audit.structuredContent)).not.toContain('synthetic-query-secret');
      expect(JSON.stringify(audit.structuredContent)).toContain('REDACTED');
      const reportPath = path.join(folder, 'redaction-audit.json');
      expect(await fs.readFile(reportPath, 'utf8')).toContain('synthetic-query-secret');
      expect(JSON.stringify(audit)).toContain(pathToFileURL(reportPath).href);

      await client.callTool({ name: 'browser_navigate', arguments: { url: 'http://redaction.test/second?code=synthetic-second-secret' } });
      const historical = await client.callTool({ name: 'browser_network_requests', arguments: { all: true } });
      expect(JSON.stringify(historical)).toContain(`/start?code=REDACTED`);
      expect(JSON.stringify(historical)).not.toContain('synthetic-query-secret');
      expect(JSON.stringify(historical)).not.toContain('synthetic-second-secret');
      const previous = await client.callTool({ name: 'browser_network_request', arguments: { index: Number(firstId) } });
      expect(previous.isError, JSON.stringify(previous)).not.toBe(true);
      expect(JSON.stringify(previous)).toContain('/start?code=REDACTED');

      await vi.waitFor(async () => {
        const files = await fs.readdir(folder, { recursive: true });
        const sessionFiles = files.filter(file => file.endsWith('session.md') || file.endsWith('.snapshot.yml'));
        expect(sessionFiles.some(file => file.endsWith('.snapshot.yml'))).toBe(true);
        const text = (await Promise.all(sessionFiles.map(file => fs.readFile(path.join(folder, file), 'utf8')))).join('\n');
        expect(text).toContain('browser_navigate');
        expect(text).toContain('REDACTED');
        expect(text).toContain('c%6Fde=synthetic-encoded-secret');
        for (const secret of ['synthetic-query-secret', 'synthetic-fragment-secret', 'synthetic-link-secret', 'synthetic-second-secret'])
          expect(text).not.toContain(secret);
      }, { timeout: 5000 });
    }
  } finally {
    await client.close();
    await browser.close();
    await fs.rm(folder, { recursive: true, force: true });
  }
});

it.each([false, true])('renders snapshots and coalesced recorder rewrites without changing the recorded action (enabled: %s)', async enabled => {
  const browser = await chromium.launch({ headless: true });
  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();
  const config = await resolveConfig({ redactUrlParams: ['code'] });
  const context = new Context({
    config, tools: [], sessionLog: undefined,
    clientInfo: { name: 'session-redaction', version: '1' },
    browserContextFactory: { createContext: async () => ({ browserContext, close: async () => {} }) },
  });
  const tab = new Tab(context, page, () => {});
  const files = new Map<string, string>();
  const storage = {
    readFile: async (file: string) => files.get(file) ?? '',
    writeFile: async (file: string, content: string) => { files.set(file, content); },
    appendFile: async (file: string, content: string) => { files.set(file, (files.get(file) ?? '') + content); },
  };
  const log = new SessionLog('/unused', storage, enabled ? ['code'] : []);
  const initial = { name: 'fill', selector: 'input', signals: [], text: 'https://fixture.test/?code=synthetic-recorded-secret&state=old', ariaSnapshot: '- link "Next":\n  - /url: /next?code=synthetic-snapshot-secret\n- text: bs_00000001-0000-4000-8000-000000000000' } as const;
  const initialAction = { ...initial, signals: [] };
  try {
    log.logUserAction(initialAction, tab, `await page.fill('input', '${initialAction.text}');`, false);
    await vi.waitFor(() => expect(files.get('/unused/session.md')).toContain('state=old'), { timeout: 3000 });
    const initialMarkdown = files.get('/unused/session.md');
    expect(initialMarkdown).toContain(enabled ? 'https://fixture.test/?code=REDACTED&state=old' : initialAction.text);
    if (enabled)
      expect(initialMarkdown).not.toContain('synthetic-recorded-secret');
    const updated = { ...initial, signals: [], text: 'https://fixture.test/?code=synthetic-updated-secret&state=new' };
    log.logUserAction(updated, tab, `await page.fill('input', '${updated.text}');`, true);
    await vi.waitFor(() => expect(files.get('/unused/session.md')).toContain('state=new'));
    const rendered = [...files.values()].join('\n');
    if (enabled) {
      expect(rendered).not.toContain('synthetic-recorded-secret');
      expect(rendered).not.toContain('synthetic-snapshot-secret');
      expect(rendered).not.toContain('synthetic-updated-secret');
      expect(rendered).toContain('REDACTED');
    } else {
      expect(rendered).toContain('synthetic-snapshot-secret');
      expect(rendered).toContain('synthetic-updated-secret');
    }
    expect(files.get('/unused/001.snapshot.yml')).toBe(enabled ? initial.ariaSnapshot.replace('code=synthetic-snapshot-secret', 'code=REDACTED') : initial.ariaSnapshot);
    expect(rendered).not.toContain('state=old');
    expect(initialAction.text).toBe('https://fixture.test/?code=synthetic-recorded-secret&state=old');
    expect(updated.text).toContain('synthetic-updated-secret');
  } finally {
    tab.dispose();
    await context.dispose();
    await browser.close();
  }
});
