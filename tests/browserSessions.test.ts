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

import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { browserSessionTtlMs } from '../src/browserSessions.js';
import { resolveConfig } from '../src/config.js';
import { Context } from '../src/context.js';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const TTL_MS = 30 * 60 * 1000;

type FakeBrowserContext = {
  browserContext: any;
  close: ReturnType<typeof vi.fn>;
  newPage: ReturnType<typeof vi.fn>;
};

function makeFactory() {
  const created: FakeBrowserContext[] = [];
  const createContext = vi.fn(async (..._args: any[]) => {
    const browserContext: any = new EventEmitter();
    const newPage = vi.fn().mockResolvedValue({});
    browserContext.newPage = newPage;
    browserContext.pages = vi.fn().mockReturnValue([]);
    browserContext.route = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    created.push({ browserContext, close, newPage });
    return { browserContext, close };
  });
  return { factory: { createContext } as any, createContext, created };
}

async function makeBackend(factory: any) {
  const config = await resolveConfig({});
  const backend = new BrowserServerBackend(config, factory);
  await backend.initialize(
      { notifyToolListChanged: async () => {} } as any,
      { name: 'vitest', version: 'browser-sessions' },
  );
  return backend;
}

function textOf(result: Pick<CallToolResult, 'content'>): string {
  const first = result.content?.[0];
  return first?.type === 'text' ? first.text : '';
}

async function openSession(backend: BrowserServerBackend): Promise<string> {
  const result = await backend.callTool('browser_session_open', {});
  expect(result.isError).not.toBe(true);
  const id = (result.structuredContent as any)?.browserSessionId;
  expect(typeof id).toBe('string');
  return id;
}

describe('browser sessions', () => {
  afterEach(async () => {
    vi.useRealTimers();
    await Context.disposeAll();
  });

  it('opens a session, returns the handle in text and structured content, and closes it', async () => {
    const { factory, created } = makeFactory();
    const backend = await makeBackend(factory);

    const openResult = await backend.callTool('browser_session_open', {});
    expect(openResult.isError).not.toBe(true);
    const id = (openResult.structuredContent as any)?.browserSessionId;
    expect(id).toMatch(/^bs_/);
    expect(textOf(openResult)).toContain(id);

    // Use the session so its browser context actually exists.
    const listResult = await backend.callTool('browser_tabs', { action: 'list', browserSessionId: id });
    expect(listResult.isError).not.toBe(true);
    expect(created).toHaveLength(1);

    const closeResult = await backend.callTool('browser_session_close', { browserSessionId: id });
    expect(closeResult.isError).not.toBe(true);
    expect(textOf(closeResult)).toContain(id);
    expect(created[0].close).toHaveBeenCalled();

    // The handle is gone afterwards.
    await expect(backend.callTool('browser_tabs', { action: 'list', browserSessionId: id }))
        .rejects.toThrow(/Unknown browserSessionId/);
  });

  it('routes tool calls to the context named by the handle', async () => {
    const { factory, createContext } = makeFactory();
    const backend = await makeBackend(factory);

    const first = await openSession(backend);
    const second = await openSession(backend);

    await backend.callTool('browser_tabs', { action: 'list', browserSessionId: first });
    expect(createContext).toHaveBeenCalledTimes(1);
    // The same handle reuses the same context.
    await backend.callTool('browser_tabs', { action: 'list', browserSessionId: first });
    expect(createContext).toHaveBeenCalledTimes(1);
    // A different handle gets its own context.
    await backend.callTool('browser_tabs', { action: 'list', browserSessionId: second });
    expect(createContext).toHaveBeenCalledTimes(2);
    // No handle uses the default context, separate from both sessions.
    await backend.callTool('browser_tabs', { action: 'list' });
    expect(createContext).toHaveBeenCalledTimes(3);
    await backend.callTool('browser_tabs', { action: 'list' });
    expect(createContext).toHaveBeenCalledTimes(3);
  });

  it('marks registry contexts as browser sessions for the factory, default context unmarked', async () => {
    // The persistent factory keys disposable-profile allocation off this flag:
    // without it, two session handles under the default config collide on the
    // one stable profile and the second open fails "Browser is already in use".
    const { factory, createContext } = makeFactory();
    const backend = await makeBackend(factory);

    const id = await openSession(backend);
    await backend.callTool('browser_tabs', { action: 'list', browserSessionId: id });
    expect(createContext.mock.calls[0][3]).toMatchObject({ browserSession: true });

    await backend.callTool('browser_tabs', { action: 'list' });
    expect(createContext.mock.calls[1][3]?.browserSession).toBeFalsy();
  });

  it('refuses to open a session when the factory cannot mint separate contexts', async () => {
    const { factory } = makeFactory();
    factory.sessionsUnsupportedReason = 'this connection attaches to the browser\'s existing context. Add --isolated.';
    const backend = await makeBackend(factory);

    const result = await backend.callTool('browser_session_open', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Cannot open a separate browser session');
    expect(textOf(result)).toContain('Add --isolated');
  });

  it('rejects unknown handles with the list of open sessions', async () => {
    const { factory } = makeFactory();
    const backend = await makeBackend(factory);

    await expect(backend.callTool('browser_tabs', { action: 'list', browserSessionId: 'bs_missing' }))
        .rejects.toThrow(/Unknown browserSessionId "bs_missing"\. No browser sessions are open\./);

    const id = await openSession(backend);
    await expect(backend.callTool('browser_tabs', { action: 'list', browserSessionId: 'bs_missing' }))
        .rejects.toThrow(new RegExp(`Open sessions: ${id}`));

    await expect(backend.callTool('browser_tabs', { action: 'list', browserSessionId: 42 as any }))
        .rejects.toThrow(/Invalid browserSessionId/);
  });

  it('closing an unknown handle is a tool error listing the open sessions', async () => {
    const { factory } = makeFactory();
    const backend = await makeBackend(factory);

    const result = await backend.callTool('browser_session_close', { browserSessionId: 'bs_missing' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown browserSessionId "bs_missing"');
  });

  it('advertises browserSessionId on browser tools but not on the session tools', async () => {
    const { factory } = makeFactory();
    const backend = await makeBackend(factory);

    const tools = await backend.listTools();
    const byName = new Map(tools.map(tool => [tool.name, tool]));

    const navigate = byName.get('browser_navigate') as any;
    expect(navigate.inputSchema.properties.browserSessionId).toMatchObject({ type: 'string' });

    const open = byName.get('browser_session_open') as any;
    expect(open.inputSchema.properties?.browserSessionId).toBeUndefined();

    // The close tool's own argument comes from its zod schema, not injection.
    const close = byName.get('browser_session_close') as any;
    expect(close.inputSchema.properties.browserSessionId).toMatchObject({ type: 'string' });
    expect(close.inputSchema.required).toContain('browserSessionId');
  });

  it('reaps idle sessions after the TTL and disposes their contexts', async () => {
    vi.useFakeTimers();
    const { factory, created } = makeFactory();
    const backend = await makeBackend(factory);

    const id = await openSession(backend);
    await backend.callTool('browser_tabs', { action: 'list', browserSessionId: id });
    expect(created).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(TTL_MS + 60_000);

    expect(created[0].close).toHaveBeenCalled();
    await expect(backend.callTool('browser_tabs', { action: 'list', browserSessionId: id }))
        .rejects.toThrow(/Unknown browserSessionId/);
  });

  it('refreshes the TTL on use instead of expiring from creation time', async () => {
    vi.useFakeTimers();
    const { factory, created } = makeFactory();
    const backend = await makeBackend(factory);

    const id = await openSession(backend);
    // Keep using the session at intervals shorter than the TTL.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(TTL_MS / 2);
      const result = await backend.callTool('browser_tabs', { action: 'list', browserSessionId: id });
      expect(result.isError).not.toBe(true);
    }
    expect(created[0].close).not.toHaveBeenCalled();
  });

  it('does not reap a session while a tool is running in it', async () => {
    vi.useFakeTimers();
    const { factory, created } = makeFactory();
    const backend = await makeBackend(factory);

    const id = await openSession(backend);
    // First call creates the fake browser context.
    await backend.callTool('browser_tabs', { action: 'list', browserSessionId: id });

    // Gate the next newPage call so the tool hangs mid-run.
    let releaseNewPage = () => {};
    const gate = new Promise<any>(resolve => releaseNewPage = () => resolve({}));
    created[0].newPage.mockImplementationOnce(() => gate);
    const running = backend.callTool('browser_tabs', { action: 'new', browserSessionId: id });
    // Wait for the tool to reach the gated newPage call.
    for (let i = 0; i < 100 && !created[0].newPage.mock.calls.length; i++)
      await Promise.resolve();

    // Well past the TTL while the tool is still running: not reaped.
    await vi.advanceTimersByTimeAsync(TTL_MS * 3);
    expect(created[0].close).not.toHaveBeenCalled();

    releaseNewPage();
    const result = await running;
    expect(result.isError).not.toBe(true);

    // Completion refreshed the TTL: the session survives most of another TTL,
    // then expires once genuinely idle.
    await vi.advanceTimersByTimeAsync(TTL_MS - 60_000);
    expect(created[0].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(created[0].close).toHaveBeenCalled();
  });

  it('keeps the session alive past the TTL until every overlapping call finished', async () => {
    // A single running-tool slot let the first finisher clear the marker while
    // the second call still ran, so the reaper disposed the browser mid-call.
    vi.useFakeTimers();
    const { factory, created } = makeFactory();
    const backend = await makeBackend(factory);

    const id = await openSession(backend);
    await backend.callTool('browser_tabs', { action: 'list', browserSessionId: id });

    let releaseFirst = () => {};
    const firstGate = new Promise<any>(resolve => releaseFirst = () => resolve({}));
    let releaseSecond = () => {};
    const secondGate = new Promise<any>(resolve => releaseSecond = () => resolve({}));
    created[0].newPage
        .mockImplementationOnce(() => firstGate)
        .mockImplementationOnce(() => secondGate);

    const first = backend.callTool('browser_tabs', { action: 'new', browserSessionId: id });
    for (let i = 0; i < 100 && created[0].newPage.mock.calls.length < 1; i++)
      await Promise.resolve();
    const second = backend.callTool('browser_tabs', { action: 'new', browserSessionId: id });
    for (let i = 0; i < 100 && created[0].newPage.mock.calls.length < 2; i++)
      await Promise.resolve();

    // The first call completes; the second still runs. Well past the TTL the
    // session must survive on the second call's account.
    releaseFirst();
    await first;
    await vi.advanceTimersByTimeAsync(TTL_MS * 3);
    expect(created[0].close).not.toHaveBeenCalled();

    releaseSecond();
    const result = await second;
    expect(result.isError).not.toBe(true);

    // Only once genuinely idle does the session expire.
    await vi.advanceTimersByTimeAsync(TTL_MS + 60_000);
    expect(created[0].close).toHaveBeenCalled();
  });

  it('refuses to close a session while a tool call is still running in it', async () => {
    const { factory, created } = makeFactory();
    const backend = await makeBackend(factory);

    const id = await openSession(backend);
    await backend.callTool('browser_tabs', { action: 'list', browserSessionId: id });

    let releaseNewPage = () => {};
    const gate = new Promise<any>(resolve => releaseNewPage = () => resolve({}));
    created[0].newPage.mockImplementationOnce(() => gate);
    const running = backend.callTool('browser_tabs', { action: 'new', browserSessionId: id });
    for (let i = 0; i < 100 && !created[0].newPage.mock.calls.length; i++)
      await Promise.resolve();

    // Closing now would dispose the browser out from under the running call.
    const refused = await backend.callTool('browser_session_close', { browserSessionId: id });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('still has a tool call running');
    expect(created[0].close).not.toHaveBeenCalled();

    releaseNewPage();
    const result = await running;
    expect(result.isError).not.toBe(true);

    // Once the call finished, close succeeds and disposes the context.
    const closed = await backend.callTool('browser_session_close', { browserSessionId: id });
    expect(closed.isError).not.toBe(true);
    expect(created[0].close).toHaveBeenCalled();
  });

  it('serverClosed disposes every session context and the default one', async () => {
    const { factory, created } = makeFactory();
    const backend = await makeBackend(factory);

    const first = await openSession(backend);
    const second = await openSession(backend);
    await backend.callTool('browser_tabs', { action: 'list', browserSessionId: first });
    await backend.callTool('browser_tabs', { action: 'list', browserSessionId: second });
    await backend.callTool('browser_tabs', { action: 'list' });
    expect(created).toHaveLength(3);

    backend.serverClosed();

    await vi.waitFor(() => {
      for (const fake of created)
        expect(fake.close).toHaveBeenCalled();
    });
  });

  it('parses the TTL override defensively', () => {
    const original = process.env.PLAYWRIGHT_MCP_BROWSER_SESSION_TTL_MS;
    try {
      delete process.env.PLAYWRIGHT_MCP_BROWSER_SESSION_TTL_MS;
      expect(browserSessionTtlMs()).toBe(TTL_MS);
      process.env.PLAYWRIGHT_MCP_BROWSER_SESSION_TTL_MS = '60000';
      expect(browserSessionTtlMs()).toBe(60000);
      // Present-but-blank or garbage values keep the default instead of
      // silently becoming 0 (which would mean "never expire").
      process.env.PLAYWRIGHT_MCP_BROWSER_SESSION_TTL_MS = '   ';
      expect(browserSessionTtlMs()).toBe(TTL_MS);
      process.env.PLAYWRIGHT_MCP_BROWSER_SESSION_TTL_MS = 'soon';
      expect(browserSessionTtlMs()).toBe(TTL_MS);
      process.env.PLAYWRIGHT_MCP_BROWSER_SESSION_TTL_MS = '0';
      expect(browserSessionTtlMs()).toBe(0);
    } finally {
      if (original === undefined)
        delete process.env.PLAYWRIGHT_MCP_BROWSER_SESSION_TTL_MS;
      else
        process.env.PLAYWRIGHT_MCP_BROWSER_SESSION_TTL_MS = original;
    }
  });
});
