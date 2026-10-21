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

afterEach(() => vi.restoreAllMocks());

it.each([false, true])('renders URL parameters through real MCP without changing browser inputs (enabled: %s)', async enabled => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-url-redaction-'));
  const browser = await chromium.launch({ headless: true });
  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();
  const seen: string[] = [];
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

    if (enabled) {
      const audit = await client.callTool({ name: 'audit_keyboard', arguments: { maxTabs: 1, checkSkipLink: false, reportFile: 'redaction-audit.json' } });
      expect(audit.isError, JSON.stringify(audit)).not.toBe(true);
      expect(JSON.stringify(audit.structuredContent)).not.toContain('synthetic-query-secret');
      expect(JSON.stringify(audit.structuredContent)).toContain('REDACTED');
      const reportPath = path.join(folder, 'redaction-audit.json');
      expect(await fs.readFile(reportPath, 'utf8')).toContain('synthetic-query-secret');
      expect(JSON.stringify(audit)).toContain(pathToFileURL(reportPath).href);

      await vi.waitFor(async () => {
        const files = await fs.readdir(folder, { recursive: true });
        const sessionFiles = files.filter(file => file.endsWith('session.md') || file.endsWith('.snapshot.yml'));
        expect(sessionFiles.some(file => file.endsWith('.snapshot.yml'))).toBe(true);
        const text = (await Promise.all(sessionFiles.map(file => fs.readFile(path.join(folder, file), 'utf8')))).join('\n');
        expect(text).toContain('browser_navigate');
        expect(text).toContain('REDACTED');
        expect(text).toContain('c%6Fde=synthetic-encoded-secret');
        for (const secret of ['synthetic-query-secret', 'synthetic-fragment-secret', 'synthetic-link-secret'])
          expect(text).not.toContain(secret);
      }, { timeout: 5000 });
    }
  } finally {
    await client.close();
    await browser.close();
    await fs.rm(folder, { recursive: true, force: true });
  }
});
