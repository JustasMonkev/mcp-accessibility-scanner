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

const resizeWaiters: (() => void)[] = [];
// The image without alt text is only rendered at narrow widths, so a variant
// scanned at the wrong viewport changes the finding.
const server = http.createServer((request, response) => {
  if (request.url === '/resized') {
    for (const wake of resizeWaiters.splice(0))
      wake();
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(`<!doctype html><html lang="en"><title>Matrix</title>
    <style>img { display: none } @media (max-width: 500px) { img { display: block } }</style>
    <main><h1>Matrix</h1><img src="/missing.png" width="10" height="10"></main>
    <script>addEventListener('resize', () => { if (innerWidth < 500) fetch('/resized'); });</script></html>`);
});
let client: Client;
let directory: string;

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP fixture server');
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-page-matrix-admission-'));
  const config = await resolveCLIConfig({ browser: 'chromium', headless: true, isolated: true, outputDir: directory, viewportSize: '1280,720' });
  client = new Client({ name: 'scan-page-matrix-admission-test', version: '1' });
  await client.connect(await wrapInProcess(new BrowserServerBackend(config, contextFactory(config))));
  const navigated = await client.callTool({ name: 'browser_navigate', arguments: { url: `http://127.0.0.1:${address.port}/` } });
  expect(navigated.isError, text(navigated)).not.toBe(true);
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

it('rejects an overlapping matrix scan so neither call measures or restores the other\'s variant', async () => {
  const mobileApplied = new Promise<void>(resolve => resizeWaiters.push(resolve));
  const first = client.callTool({ name: 'scan_page_matrix', arguments: {
    reportFile: 'first.json', waitAfterApplyMs: 1500, withRules: ['image-alt'],
    variants: [{ name: 'baseline' }, { name: 'mobile', viewport: { width: 375, height: 812 } }],
  } });
  await mobileApplied;

  // Started while the first call holds the mobile viewport: admitted, it would
  // capture 375px as the original, switch the first call's mobile scan to
  // 1280px, and restore 375px after the first call finished.
  const overlapping = await client.callTool({ name: 'scan_page_matrix', arguments: {
    reportFile: 'overlapping.json', waitAfterApplyMs: 3000, withRules: ['image-alt'],
    variants: [{ name: 'desktop', viewport: { width: 1280, height: 720 } }],
  } });
  expect(overlapping.isError).toBe(true);
  expect(text(overlapping)).toContain('is busy');

  const firstResult = await first;
  expect(firstResult.isError, text(firstResult)).not.toBe(true);
  const report = JSON.parse(await fs.readFile(path.join(directory, 'first.json'), 'utf8'));
  expect(report.variants.map((variant: { name: string, nodeCountByRuleId: Record<string, number> }) => [variant.name, variant.nodeCountByRuleId])).toEqual([
    ['baseline', {}],
    ['mobile', { 'image-alt': 1 }],
  ]);

  const viewport = await client.callTool({ name: 'browser_evaluate', arguments: { function: '() => `${innerWidth}x${innerHeight}`' } });
  expect(text(viewport)).toContain('1280x720');
});
