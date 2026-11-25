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

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/export.csv') {
    response.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="export.csv"' });
    response.end('a,b\n1,2\n');
    return;
  }
  if (pathname === '/moved') {
    response.writeHead(302, { location: '/landing' });
    response.end();
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(`<!doctype html><html lang="en"><title>${pathname}</title><main><img src="/missing.png"></main></html>`);
});
let client: Client;
let directory: string;
let origin: string;

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP fixture server');
  origin = `http://127.0.0.1:${address.port}`;
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-site-download-'));
  const config = await resolveCLIConfig({ browser: 'chromium', headless: true, isolated: true, outputDir: directory });
  client = new Client({ name: 'audit-site-download-test', version: '1' });
  await client.connect(await wrapInProcess(new BrowserServerBackend(config, contextFactory(config))));
  const navigated = await client.callTool({ name: 'browser_navigate', arguments: { url: `${origin}/start` } });
  expect(navigated.isError, JSON.stringify(navigated.content)).not.toBe(true);
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

async function auditProvided(urls: string[], reportFile: string) {
  const result = await client.callTool({ name: 'audit_site', arguments: {
    strategy: 'provided', urls, concurrency: 1, waitAfterNavigationMs: 0, reportFile,
  } });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return JSON.parse(await fs.readFile(path.join(directory, reportFile), 'utf8'));
}

it('skips a download on a reused crawl tab instead of auditing the previous document as that URL', async () => {
  const page = `${origin}/page`;
  const attachment = `${origin}/export.csv`;
  const report = await auditProvided([page, attachment], 'download.json');

  expect(report.summary.totals).toMatchObject({ scannedPages: 1, erroredPages: 0, skippedUrls: 1 });
  expect(report.pages.map((entry: { url: string, status: string }) => [entry.url, entry.status])).toEqual([
    [page, 'scanned'],
    [attachment, 'skipped'],
  ]);
  const skipped = report.pages[1];
  expect(skipped).toMatchObject({ title: '', error: null, violations: [], incomplete: [], summary: null });
  expect(skipped.skipReason).toContain('download');
  const imageAlt = report.summary.violations.find((violation: { id: string }) => violation.id === 'image-alt');
  expect(imageAlt.pagesAffected).toEqual([page]);
});

it('still audits an in-scope document reached through a redirect after a download', async () => {
  const report = await auditProvided([`${origin}/export.csv`, `${origin}/moved`], 'redirect.json');

  expect(report.summary.totals).toMatchObject({ scannedPages: 1, erroredPages: 0, skippedUrls: 1 });
  expect(report.pages[1]).toMatchObject({ url: `${origin}/moved`, status: 'scanned', title: '/landing' });
  const imageAlt = report.summary.violations.find((violation: { id: string }) => violation.id === 'image-alt');
  expect(imageAlt.pagesAffected).toEqual([`${origin}/moved`]);
});
