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
import { Client } from '@modelcontextprotocol/client';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { resolveConfig } from '../src/config.js';
import { wrapInProcess } from '../src/mcp/server.js';
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

browserTests('Native WebMCP over MCP', () => {
  it('lists and invokes registerTool registrations through the pinned browser and real MCP SDK', async () => {
    const browser = await chromium.launch({ headless: true,
      executablePath: process.env.WEBMCP_BROWSER_EXECUTABLE_PATH || undefined,
      args: ['--enable-features=WebMCP', ...(process.env.WEBMCP_BROWSER_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])],
    });
    const client = new Client({ name: 'native-webmcp-test', version: '1' });
    try {
      const browserContext = await browser.newContext();
      await browserContext.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Native WebMCP</h1><iframe src="/frame"></iframe>' }));
      // Prevent recursive frames while retaining same-origin native registration.
      await browserContext.route('http://localhost/frame', route => route.fulfill({ contentType: 'text/html', body: '<h2>Frame</h2>' }));
      const config = await resolveConfig({});
      const backend = new BrowserServerBackend(config, {
        createContext: async () => ({ browserContext, close: () => browserContext.close() }),
      });
      await client.connect(await wrapInProcess(backend));
      const navigation = await client.callTool({ name: 'browser_navigate', arguments: { url: 'http://localhost/' } });
      assert.notEqual(navigation.isError, true);
      const page = browserContext.pages()[0];
      for (const [index, frame] of page.frames().entries()) {
        await frame.evaluate(index => {
          type NativeContext = { registerTool: (tool: { name: string, description: string, inputSchema: { type: 'object', properties: Record<string, { type: 'number' | 'string' }>, required: string[] }, execute: (input: unknown) => Promise<unknown> }) => void };
          // SAFETY: these are the native experimental members absent from TypeScript's DOM declarations.
          const modelContext = (document as Document & { modelContext: NativeContext }).modelContext;
          modelContext.registerTool({ name: 'native_echo', description: `native-frame-${index}`,
            inputSchema: { type: 'object', properties: { browserSessionId: { type: 'number' }, _meta: { type: 'string' } }, required: ['browserSessionId', '_meta'] },
            execute: async input => ({ content: [{ type: 'text', text: `frame=${index};${JSON.stringify(input)}` }] }),
          });
        }, index);
      }
      const tools = (await client.listTools()).tools.filter(tool => tool.name.startsWith('webmcp_'));
      assert.equal(tools.length, 2);
      const child = tools.find(tool => tool.description?.endsWith('native-frame-1'))!;
      const result = await client.callTool({ name: child.name, arguments: { browserSessionId: 42, _meta: 'page input' } });
      assert.notEqual(result.isError, true);
      const text = JSON.stringify(result.content);
      assert.ok(text.includes('page input'));
      assert.ok(text.includes('frame=1;'));
      assert.ok(text.includes('42'));
      await page.goto('http://localhost/next');
      const stale = await client.callTool({ name: child.name, arguments: { browserSessionId: 42, _meta: 'page input' } });
      assert.equal(stale.isError, true);
      assert.equal((await client.listTools()).tools.filter(tool => tool.name.startsWith('webmcp_')).length, 0);
    } finally {
      try {
        await client.close();
      } finally {
        await browser.close();
      }
    }
  }, 30000);
});
