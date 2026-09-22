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
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it, vi } from 'vitest';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { BrowserSessionRegistry } from '../src/browserSessions.js';
import type { Context } from '../src/context.js';
import type { CallToolRequestContext } from '../src/mcp/server.js';

function contextHarness(label: string) {
  let tools = [{ name: 'echo', description: label, inputSchema: { type: 'object', properties: {
    browserSessionId: { type: 'number' }, _meta: { type: 'string' },
  }, required: ['browserSessionId', '_meta'] } }];
  let busy = 0;
  let calls = 0;
  let reads = 0;
  let disposed = false;
  let received: unknown;
  let protocolErrorBytes = 0;
  let read = async () => tools;
  let execute: (value: unknown) => unknown = value => value;
  const page = Object.assign(new EventEmitter(), { frames: () => [frame], isClosed: () => false });
  const sandbox = vm.createContext({
    window: {}, navigator: {}, performance: { timeOrigin: 1 }, TextEncoder, TextDecoder,
    document: { modelContext: {
      getTools: async () => { ++reads; return read(); },
      executeTool: async (_tool: unknown, input: string) => {
        ++calls;
        received = JSON.parse(input);
        return execute(received);
      },
    } },
  });
  const frame = { url: () => 'https://example.test', isDetached: () => false,
    evaluate: async (fn: Function, argument: unknown) => {
      try {
        return JSON.parse(JSON.stringify(await vm.runInContext(`(${fn.toString()})`, sandbox)(argument)));
      } catch (error) {
        const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
        protocolErrorBytes = Buffer.byteLength(message);
        throw error;
      }
    },
  };
  const context = {
    config: {}, currentTab: () => tab, tabs: () => [tab],
    beginToolCall: () => { ++busy; return () => --busy; },
    beginSessionHold: () => { ++busy; return () => --busy; },
    isRunningTool: () => busy > 0,
    recordingActivityAt: () => undefined, hasPendingDownloads: () => false,
    takeDownloadErrors: () => [],
    resumeAfterIdle: async () => undefined, resolveSessionLog: async () => undefined,
    dispose: async () => { disposed = true; },
  };
  const tab = { context, page, modalStates: () => [], operationTimeout: () => 25,
    isCurrentTab: () => true, updateTitle: async () => undefined,
  };
  return { context, tab, calls: () => calls, busy: () => busy, reads: () => reads, disposed: () => disposed,
    protocolErrorBytes: () => protocolErrorBytes, received: () => received,
    setRead: (value: typeof read) => { read = value; },
    removeTools: () => { tools = []; }, setExecute: (value: typeof execute) => { execute = value; },
  };
}

function backendHarness(shared?: Map<string, ReturnType<typeof contextHarness>['context']>, stateless = true) {
  const defaultContext = contextHarness('default');
  const sessions = shared ?? new Map();
  let notifications = 0;
  const registry = {
    resolve: (id: string) => {
      const context = sessions.get(id);
      if (!context)
        throw new Error('Unknown browserSessionId');
      return context;
    },
    touch: () => {}, disposeAll: async () => {},
  };
  // SAFETY: this fixture bypasses browser launch and injects only the private
  // state used by the production backend's list/call/close methods.
  const backend = Object.assign(Object.create(BrowserServerBackend.prototype), {
    _tools: [], _toolsByName: new Map(), _mcpTools: [], _config: {}, _browserContextFactory: {},
    _context: defaultContext.context, _sessionRegistry: registry, _sharedSessionRegistry: registry,
    _ephemeralDefaultContext: stateless, _closed: false,
    _notifyToolListChanged: async () => { ++notifications; },
  }) as BrowserServerBackend;
  return { backend, defaultContext, sessions, notifications: () => notifications };
}

function request(browserSessionId?: string, signal = new AbortController().signal): CallToolRequestContext {
  return { signal, requestId: 1, sendNotification: async () => {}, _meta: browserSessionId ? { browserSessionId } : undefined };
}

const input = { browserSessionId: 42, _meta: 'page metadata, not routing' };

function text(result: Awaited<ReturnType<BrowserServerBackend['callTool']>>) {
  return result.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '';
}

describe('WebMCP backend scope and argument contracts', () => {
  it('attaches a shared default context before stateful listing', async () => {
    const h = backendHarness(undefined, false);
    let attached = false;
    const ensureTab = vi.fn(async () => {
      attached = true;
      return h.defaultContext.tab;
    });
    Object.assign(h.defaultContext.context, {
      currentTab: () => attached ? h.defaultContext.tab : undefined,
      ensureTab,
    });
    Object.assign(h.backend, { _browserContextFactory: { sharedContext: true } });
    const [tool] = await h.backend.listTools();
    assert.match(tool.name, /^webmcp_/);
    assert.equal(ensureTab.mock.calls.length, 1);
    h.backend.serverClosed();
  });

  it('lists only a selected known session and does not expose other bearer handles', async () => {
    const h = backendHarness();
    const a = contextHarness('session A');
    const b = contextHarness('session B');
    h.sessions.set('bs_a_secret', a.context);
    h.sessions.set('bs_b_secret', b.context);
    const [defaultTool] = await h.backend.listTools();
    const [aTool] = await h.backend.listTools(request('bs_a_secret'));
    const [bTool] = await h.backend.listTools(request('bs_b_secret'));
    assert.notEqual(defaultTool.name, aTool.name);
    assert.notEqual(aTool.name, bTool.name);
    assert.match(aTool.description!, /session A$/);
    assert.doesNotMatch(JSON.stringify(aTool), /bs_a_secret|bs_b_secret|session B/);
    h.backend.serverClosed();
  });

  it('preserves page browserSessionId and _meta while routing through request metadata', async () => {
    const h = backendHarness();
    const a = contextHarness('session A');
    h.sessions.set('bs_a', a.context);
    const [tool] = await h.backend.listTools(request('bs_a'));
    assert.deepEqual(tool.inputSchema.required, ['browserSessionId', '_meta']);
    const result = await h.backend.callTool(tool.name, input, request('bs_a'));
    assert.notEqual(result.isError, true);
    assert.deepEqual(a.received(), input);
    assert.equal(h.defaultContext.calls(), 0);
    assert.equal(a.busy(), 0);
    h.backend.serverClosed();
  });

  it('does not interpret routing-looking fields in default page arguments', async () => {
    const h = backendHarness();
    const [tool] = await h.backend.listTools();
    const result = await h.backend.callTool(tool.name, input, request());
    assert.notEqual(result.isError, true);
    assert.deepEqual(h.defaultContext.received(), input);
    h.backend.serverClosed();
  });

  it('rejects a cached tool name in another scope rather than executing an identically named page action', async () => {
    const h = backendHarness();
    const a = contextHarness('session');
    const b = contextHarness('session');
    h.sessions.set('bs_a', a.context); h.sessions.set('bs_b', b.context);
    const [tool] = await h.backend.listTools(request('bs_a'));
    const result = await h.backend.callTool(tool.name, input, request('bs_b'));
    assert.equal(result.isError, true);
    assert.equal(a.calls() + b.calls() + h.defaultContext.calls(), 0);
    h.backend.serverClosed();
  });

  it('discovers and calls the same explicit session across fresh stateless backends', async () => {
    const a = contextHarness('persistent explicit session');
    const sessions = new Map([['bs_a', a.context]]);
    const first = backendHarness(sessions);
    const [tool] = await first.backend.listTools(request('bs_a'));
    first.backend.serverClosed();
    const second = backendHarness(sessions);
    assert.equal((await second.backend.listTools(request('bs_a')))[0].name, tool.name);
    assert.notEqual((await second.backend.callTool(tool.name, input, request('bs_a'))).isError, true);
    assert.equal(a.calls(), 1);
    second.backend.serverClosed();
  });

  it('rejects unknown or malformed scope metadata without default-scope discovery', async () => {
    const h = backendHarness();
    await assert.rejects(h.backend.listTools(request('missing')), /Unknown browserSessionId/);
    // SAFETY: deliberately invalid metadata exercises runtime validation.
    await assert.rejects(h.backend.listTools({ _meta: { browserSessionId: 12 } }), /Invalid WebMCP metadata/);
    assert.equal(h.defaultContext.reads(), 0);
    h.backend.serverClosed();
  });

  it('releases the session busy marker when a page invocation never resolves', async () => {
    const h = backendHarness();
    const [tool] = await h.backend.listTools();
    h.defaultContext.setExecute(() => new Promise(() => {}));
    const result = await h.backend.callTool(tool.name, input, request());
    assert.equal(result.isError, true);
    assert.match(text(result), /timed out.*may still be running/);
    assert.equal(h.defaultContext.busy(), 0);
    h.backend.serverClosed();
  });

  it('rejects arguments that do not match the advertised schema before page invocation', async () => {
    const h = backendHarness();
    const [tool] = await h.backend.listTools();
    const result = await h.backend.callTool(tool.name, { browserSessionId: 'wrong', _meta: 'ok' }, request());
    assert.equal(result.isError, true);
    assert.match(text(result), /Invalid WebMCP arguments/);
    assert.equal(h.defaultContext.calls(), 0);
    h.backend.serverClosed();
  });

  it('bounds page-thrown errors before they cross the browser protocol', async () => {
    const h = backendHarness();
    const [tool] = await h.backend.listTools();
    h.defaultContext.setExecute(() => { throw new Error('€'.repeat(10_000)); });
    const result = await h.backend.callTool(tool.name, input, request());
    assert.equal(result.isError, true);
    assert.ok(h.defaultContext.protocolErrorBytes() <= 2048);
    h.backend.serverClosed();
  });

  it('holds an explicit session against close and TTL expiry during listing', async () => {
    vi.useFakeTimers();
    const h = backendHarness();
    const a = contextHarness('session');
    const registry = new BrowserSessionRegistry(10);
    // SAFETY: the fixture implements the Context methods used by the real registry.
    const id = registry.open(() => a.context as unknown as Context);
    Object.assign(h.backend, { _sessionRegistry: registry, _sharedSessionRegistry: registry });
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    a.setRead(async () => { started.resolve(); await finish.promise; return []; });
    const listing = h.backend.listTools(request(id));
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(25);
      assert.equal(a.disposed(), false);
      assert.equal(registry.resolve(id), a.context);
      await assert.rejects(registry.close(id), /still has a tool call running/);
      finish.resolve();
      assert.deepEqual(await listing, []);
      assert.equal(a.busy(), 0);
      await registry.close(id);
      assert.equal(a.disposed(), true);
    } finally {
      finish.resolve();
      await listing;
      await registry.disposeAll();
      h.backend.serverClosed();
      vi.useRealTimers();
    }
  });

  it('releases a listed session promptly when hung discovery is cancelled', async () => {
    vi.useFakeTimers();
    const h = backendHarness();
    const a = contextHarness('session');
    const registry = new BrowserSessionRegistry(0);
    // SAFETY: the fixture implements the Context methods used by the real registry.
    const id = registry.open(() => a.context as unknown as Context);
    Object.assign(h.backend, { _sessionRegistry: registry, _sharedSessionRegistry: registry });
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    a.setRead(async () => { started.resolve(); await finish.promise; return []; });
    const controller = new AbortController();
    const listing = h.backend.listTools(request(id, controller.signal));
    const rejection = assert.rejects(listing, /cancel listing/);
    try {
      await started.promise;
      controller.abort(new Error('cancel listing'));
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(a.busy(), 0);
      await rejection;
      await registry.close(id);
      assert.equal(a.disposed(), true);
    } finally {
      finish.resolve();
      await rejection;
      await registry.disposeAll();
      h.backend.serverClosed();
      vi.useRealTimers();
    }
  });

  it('does not discover tools for an already-cancelled list request', async () => {
    const h = backendHarness();
    const controller = new AbortController();
    controller.abort(new Error('cancel listing'));
    await assert.rejects(h.backend.listTools(request(undefined, controller.signal)), /cancel listing/);
    assert.equal(h.defaultContext.reads(), 0);
    assert.equal(h.defaultContext.busy(), 0);
    h.backend.serverClosed();
  });

  it('releases a shared-context listing when initial attachment is cancelled', async () => {
    const h = backendHarness(undefined, false);
    const started = Promise.withResolvers<void>();
    Object.assign(h.defaultContext.context, {
      currentTab: () => undefined,
      ensureTab: async () => { started.resolve(); return new Promise(() => {}); },
    });
    Object.assign(h.backend, { _browserContextFactory: { sharedContext: true } });
    const controller = new AbortController();
    const listing = h.backend.listTools(request(undefined, controller.signal));
    await started.promise;
    controller.abort(new Error('cancel attachment'));
    await assert.rejects(listing, /cancel attachment/);
    assert.equal(h.defaultContext.busy(), 0);
    h.backend.serverClosed();
  });

  it('honors cancellation before discovering or executing a page tool', async () => {
    const h = backendHarness();
    const [tool] = await h.backend.listTools();
    const readsBefore = h.defaultContext.reads();
    const controller = new AbortController(); controller.abort();
    const result = await h.backend.callTool(tool.name, input, request(undefined, controller.signal));
    assert.equal(result.isError, true);
    assert.equal(h.defaultContext.reads(), readsBefore);
    assert.equal(h.defaultContext.busy(), 0);
    h.backend.serverClosed();
  });

  it('refreshes the last listed session after a call in an unrelated context', async () => {
    const h = backendHarness(undefined, false);
    const a = contextHarness('session A'); h.sessions.set('bs_a', a.context);
    const [defaultTool] = await h.backend.listTools();
    await h.backend.listTools(request('bs_a'));
    a.removeTools();
    await h.backend.callTool(defaultTool.name, input, request());
    const deadline = Date.now() + 500;
    while (!h.notifications() && Date.now() < deadline)
      await delay(5);
    assert.equal(h.notifications(), 1);
    assert.deepEqual(await h.backend.listTools(request('bs_a')), []);
    h.backend.serverClosed();
  });

  it('never polls a stateless response after listing', async () => {
    const h = backendHarness();
    await h.backend.listTools();
    // SAFETY: verifies lifecycle state without reaching a live browser.
    assert.equal((h.backend as unknown as { _webmcpObserver?: unknown })._webmcpObserver, undefined);
    h.backend.serverClosed();
  });
});
