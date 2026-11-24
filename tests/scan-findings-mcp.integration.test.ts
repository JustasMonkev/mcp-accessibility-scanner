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
import { Client } from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';
import { createConnection } from '../src/index.js';
import { InProcessTransport } from '../src/mcp/inProcessTransport.js';
import type { AxeNode } from '../src/tools/axe.js';

it('pages through all 73 observed nodes after navigation, but never through a foreign or replaced scan ID', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'retained-findings-'));
  const server = await createConnection({
    browser: { browserName: 'chromium', isolated: true, launchOptions: { headless: true } },
    outputDir,
    redactUrlParams: ['token'],
  });
  const client = new Client({ name: 'scan-findings-test', version: '1' });
  await client.connect(new InProcessTransport(server));
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  try {
    const lookup = (await client.listTools()).tools.find(tool => tool.name === 'get_scan_findings');
    expect(lookup?.annotations?.readOnlyHint).toBe(true);
    expect(lookup?.inputSchema.properties).toHaveProperty('browserSessionId');
    expect(lookup?.inputSchema.required).toEqual(['scanId', 'ruleId', 'outcome']);

    await call('browser_navigate', { url: 'about:blank' });
    const buttons = Array.from({ length: 73 }, (_, i) => `<button id="b${i}" data-url="/?token=test-secret"></button>`);
    // Put the last occurrence inside a frame: annotation cannot mark it, but
    // retention must still preserve its frame-qualified selector.
    await call('browser_evaluate', { function: `async () => {
      document.body.innerHTML = ${JSON.stringify(buttons.slice(0, -1).join(''))};
      const frame = document.createElement('iframe');
      frame.id = 'embedded';
      frame.srcdoc = ${JSON.stringify(buttons.at(-1))};
      const loaded = new Promise(resolve => { frame.onload = resolve; });
      document.body.append(frame);
      await loaded;
    }` });
    const scanArgs = { withRules: ['button-name'], maxNodesPerViolation: 2 };
    const scan = await call('scan_page', { ...scanArgs, retainFindings: true, annotateScreenshot: true });
    expect(scan.isError).not.toBe(true);
    const scanId = scan.structuredContent?.scanId;
    expect(scan.structuredContent).toEqual({ scanId: expect.any(String), rules: [{ outcome: 'violation', ruleId: 'button-name', count: 73 }] });
    const scanText = scan.content.filter(item => item.type === 'text').map(item => item.text).join('');
    expect(scanText).toContain('showing 2 of 73 nodes');
    expect(scanText).toContain('1 inside an iframe');
    expect(scanText.match(/"failureSummary":/g)).toHaveLength(2);
    expect(scanText).not.toContain('test-secret');
    expect(scanText).toContain('?token=REDACTED');
    const args = { scanId, ruleId: 'button-name', outcome: 'violation' };

    const opened = await call('browser_session_open');
    const browserSessionId = opened.structuredContent?.browserSessionId;
    expect(browserSessionId).toEqual(expect.any(String));
    const foreign = await call('get_scan_findings', { ...args, browserSessionId });
    expect(foreign.isError).toBe(true);
    const unknown = await call('get_scan_findings', { ...args, scanId: 'unknown' });
    expect(unknown).toEqual(foreign);
    expect(JSON.stringify(unknown)).not.toContain(scanId);
    await call('browser_session_close', { browserSessionId });

    await call('browser_navigate', { url: 'data:text/html,<title>Different document</title>' });
    const ordinary = await call('scan_page', scanArgs);
    expect(ordinary.isError).not.toBe(true);
    expect(ordinary.structuredContent).toBeUndefined();

    const allNodes: AxeNode[] = [];
    for (const offset of [0, 25, 50]) {
      const page = await call('get_scan_findings', { ...args, offset, limit: 25 });
      expect(page.isError).not.toBe(true);
      const expectedNext = offset < 50 ? offset + 25 : null;
      expect(page.structuredContent).toMatchObject({ ...args, offset, total: 73, nextOffset: expectedNext });
      const text = page.content.filter(item => item.type === 'text').map(item => item.text).join('');
      expect(text).not.toContain('test-secret');
      expect(text).toContain('?token=REDACTED');
      allNodes.push(...page.structuredContent!.nodes as AxeNode[]);
    }
    const failureSummary = allNodes[0].failureSummary;
    expect(failureSummary).toMatch(/^Fix any of the following:/);
    expect(scanText).toContain(JSON.stringify(failureSummary));
    expect(allNodes).toEqual(buttons.map((html, i) => ({
      target: i === 72 ? ['#embedded', '#b72'] : [`#b${i}`], html: html.replace('test-secret', 'REDACTED'), failureSummary,
    })));

    expect((await call('get_scan_findings', { ...args, offset: 73 })).structuredContent).toMatchObject({ nodes: [], nextOffset: null });
    expect((await call('get_scan_findings', { ...args, offset: 74 })).isError).toBe(true);
    const replacement = await call('scan_page', { ...scanArgs, retainFindings: true });
    expect(replacement.structuredContent).toEqual({ scanId: expect.any(String), rules: [] });
    expect(await call('get_scan_findings', args)).toEqual(unknown);
  } finally {
    await call('browser_close');
    await client.close();
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
