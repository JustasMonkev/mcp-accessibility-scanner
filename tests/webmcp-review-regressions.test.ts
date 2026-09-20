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
import { describe, it } from 'vitest';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { listWebMCPTools } from '../src/webmcp.js';
import type { Tab } from '../src/tab.js';
import type { Response } from '../src/response.js';

function modalHarness(event?: string) {
  const page = Object.assign(new EventEmitter(), { frames: () => [frame], isClosed: () => false });
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
