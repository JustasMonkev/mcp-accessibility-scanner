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
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/client';
import { describe, it } from 'vitest';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { resolveConfig } from '../src/config.js';
import { createConnection } from '../src/index.js';
import { InProcessTransport } from '../src/mcp/inProcessTransport.js';
import { wrapInProcess } from '../src/mcp/server.js';
import { VSCodeBrowserContextFactory } from '../src/vscode/browserContextFactory.js';
import { listWebMCPTools } from '../src/webmcp.js';
import type { BrowserContext } from 'playwright';
import type { Tab } from '../src/tab.js';
import type { Response } from '../src/response.js';

function modalHarness(event?: string) {
  const page = Object.assign(new EventEmitter(), {
    frames: () => [frame],
    isClosed: () => false,
    setDefaultNavigationTimeout: () => {},
    setDefaultTimeout: () => {},
  });
  const frame = {
    url: () => 'https://example.test', isDetached: () => false,
    evaluate: async (_fn: unknown, argument: unknown) => {
      if (argument && typeof argument === 'object' && 'expected' in argument) {
        if (event)
          page.emit(event);
        return new Promise(() => {});
      }
      return { timeOrigin: 1, tools: [{ name: 'prepare', title: 'Prepare audit state', description: '', inputSchema: { type: 'object' } }] };
    },
  };
  // SAFETY: only these page and tab operations are used by the adapter.
  const tab = { page, context: {}, modalStates: () => [], operationTimeout: () => 30, isCurrentTab: () => true } as unknown as Tab;
  const errors: string[] = [];
  const results: string[] = [];
  // SAFETY: invocation writes through these two Response methods only.
  const response = { addError: (value: string) => errors.push(value), addResult: (value: string) => results.push(value) } as unknown as Response;
  return { page, tab, response, errors, results };
}

describe('WebMCP follow-up review regressions', () => {
  it('attaches a custom shared context before its first tools/list', async () => {
    const page = Object.assign(new EventEmitter(), {
      frames: () => [],
      isClosed: () => false,
      setDefaultNavigationTimeout: () => {},
      setDefaultTimeout: () => {},
    });
    let opened = 0;
    const browserContext = Object.assign(new EventEmitter(), {
      pages: () => [],
      newPage: async () => {
        ++opened;
        browserContext.emit('page', page);
        return page;
      },
      close: async () => {},
    });
    // SAFETY: this fixture implements only the BrowserContext surface reached by initial listing.
    const server = await createConnection({}, async () => browserContext as unknown as BrowserContext);
    const client = new Client({ name: 'custom-context-test', version: '1' });
    try {
      await client.connect(new InProcessTransport(server));
      await client.listTools();
      assert.equal(opened, 1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('attaches the VS Code provider before its first tools/list', async () => {
    const { page } = modalHarness();
    const browserContext = Object.assign(new EventEmitter(), { pages: () => [page] });
    const browser = { contexts: () => [browserContext], close: async () => {} };
    const config = await resolveConfig({});
    // SAFETY: these fixtures implement only the connected browser surfaces reached by initial listing.
    const playwright = { chromium: { connect: async () => browser } } as unknown as typeof import('playwright');
    const factory = new VSCodeBrowserContextFactory(config, playwright, 'ws://127.0.0.1:1234/');
    const client = new Client({ name: 'vscode-context-test', version: '1' });
    try {
      await client.connect(await wrapInProcess(new BrowserServerBackend(config, factory)));
      const tools = (await client.listTools()).tools.filter(tool => tool.name.startsWith('webmcp_'));
      assert.equal(tools.length, 1);
    } finally {
      await client.close();
    }
  });

  it('preserves a nonempty built-in list before initialization', async () => {
    const staticTools = [{ name: 'browser_snapshot', inputSchema: { type: 'object' } }];
    // SAFETY: mirrors pre-initialize fields; no browser or registry exists yet.
    const backend = Object.assign(Object.create(BrowserServerBackend.prototype), {
      _tools: [], _toolsByName: new Map(), _mcpTools: staticTools,
      _context: undefined, _sessionRegistry: undefined,
    }) as BrowserServerBackend;
    assert.deepEqual(await backend.listTools(), staticTools);
    await assert.rejects(backend.listTools({ _meta: { browserSessionId: 'bs_uninitialized' } }), /Initialize the browser backend/);
  });

  it('advertises bounded top-level titles alongside legacy annotations', async () => {
    const { tab } = modalHarness();
    const [tool] = await listWebMCPTools(tab);
    assert.equal(tool.schema.title, 'Prepare audit state');
    assert.equal(tool.schema.title, tool.schema.annotations?.title);
  });

  for (const [event, resolver] of [['dialog', 'browser_handle_dialog'], ['filechooser', 'browser_file_upload']]) {
    it(`reports a new ${event}, names its resolving tool, and removes listeners`, async () => {
      const h = modalHarness(event);
      const [tool] = await listWebMCPTools(h.tab);
      const before = h.page.listenerCount(event);
      await tool.handle({}, h.response);
      assert.equal(h.results.length, 0);
      assert.match(h.errors.join(''), new RegExp(resolver));
      assert.equal(h.page.listenerCount(event), before);
    });
  }
});


describe('WebMCP aggregate discovery budget', () => {
  for (const frameCount of [3, 32]) {
    it(`caps registrations before transport across ${frameCount} populated frames`, async () => {
      let transferred = 0;
      const budgets: number[] = [];
      const page = Object.assign(new EventEmitter(), { frames: () => frames, isClosed: () => false });
      const frames = Array.from({ length: frameCount }, (_, index) => {
        const sandbox = vm.createContext({
          window: {}, navigator: {}, performance: { timeOrigin: index + 1 }, TextEncoder,
          document: { modelContext: { getTools: async () => Array.from({ length: 128 }, (_, tool) => ({
            name: `tool${tool}`, description: '', inputSchema: { type: 'object' },
          })) } },
        });
        return {
          url: () => 'https://example.test', isDetached: () => false,
          evaluate: async (fn: Function, budget: { tools: number }) => {
            budgets.push(budget.tools);
            const result = await vm.runInContext(`(${fn.toString()})`, sandbox)(budget);
            transferred += result.tools.length;
            return JSON.parse(JSON.stringify(result));
          },
        };
      });
      // SAFETY: exercises the production in-page collector and concurrency path with serializing frame fixtures.
      const tab = { page, context: {}, modalStates: () => [] } as unknown as Tab;
      const tools = await listWebMCPTools(tab);
      assert.equal(transferred, 128);
      assert.equal(tools.length, 128);
      assert.equal(budgets.reduce((sum, count) => sum + count, 0), 128);
      assert.ok(Math.max(...budgets) - Math.min(...budgets) <= 1);
    });
  }
});
