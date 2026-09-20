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

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { chromium } from 'playwright';
import { listWebMCPTools } from '../src/webmcp.js';
import type { Tab } from '../src/tab.js';
import type { Response } from '../src/response.js';

// Opt-in because the default unit suite must not require a browser download.
// This fixture verifies actual evaluate/serialization across Chromium using a
// deterministic WebMCP API fixture. It does not claim native WebMCP conformance.
const browserTests = process.env.WEBMCP_BROWSER_TEST === '1' ? describe : describe.skip;
browserTests('WebMCP browser boundary', () => {
  it('discovers, calls, isolates frames, retires stale names and bounds a hung page promise', async () => {
    const browser = await chromium.launch({ headless: true,
      executablePath: process.env.WEBMCP_BROWSER_EXECUTABLE_PATH || undefined,
      args: process.env.WEBMCP_BROWSER_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
    });
    try {
      const page = await browser.newPage();
      await page.setContent('<h1>Audit setup</h1><iframe srcdoc="<h2>Widget</h2>"></iframe>');
      for (const [index, frame] of page.frames().entries()) {
        await frame.evaluate(({ index }) => {
          Object.defineProperty(document, 'modelContext', { configurable: true, value: {
            getTools: async () => [
              { name: 'prepare/a', description: `first-${index}`, inputSchema: { type: 'object' } },
              { name: 'prepare?a', description: `second-${index}`, inputSchema: { type: 'object' } },
              { name: 'hang', description: `hang-${index}`, inputSchema: { type: 'object' } },
            ],
            executeTool: async (tool: { name: string }, input: string) => {
              if (tool.name === 'hang')
                return new Promise(() => {});
              return JSON.stringify({ frame: index, name: tool.name, input: JSON.parse(input) });
            },
          } });
        }, { index });
      }
      const context = {};
      // SAFETY: the actual Page handles evaluation; only the surrounding Tab policy is a fixture.
      const tab = { page, context, modalStates: () => [], operationTimeout: () => 100,
        isCurrentTab: () => true } as unknown as Tab;
      const tools = await listWebMCPTools(tab);
      assert.equal(tools.length, 6);
      assert.equal(new Set(tools.map(tool => tool.schema.name)).size, 6);
      const output: string[] = [];
      const errors: string[] = [];
      // SAFETY: invocation only uses these two Response methods.
      const response = { addResult: (value: string) => output.push(value), addError: (value: string) => errors.push(value) } as unknown as Response;
      const target = tools.find(tool => tool.schema.description?.endsWith('second-1'))!;
      await target.handle({ browserSessionId: 42, _meta: 'page input' }, response);
      assert.equal(errors.length, 0);
      assert.match(output[0], /"frame":1/);
      assert.match(output[0], /"browserSessionId":42/);
      assert.match(output[0], /"_meta":"page input"/);
      const hung = tools.find(tool => tool.schema.description?.endsWith('hang-0'))!;
      await hung.handle({}, response);
      assert.match(errors.pop()!, /timed out.*may still be running/);
      const controller = new AbortController();
      const pending = hung.handle({}, response, controller.signal);
      setTimeout(() => controller.abort(), 10);
      await pending;
      assert.match(errors.pop()!, /cancelled/);
      await page.goto('about:blank');
      await target.handle({}, response);
      assert.match(errors.pop()!, /frame or active tab changed/);
      assert.deepEqual(await listWebMCPTools(tab), []);
    } finally {
      await browser.close();
    }
  });
});
