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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { BrowserSessionRegistry, browserSessionTtlMs } from '../src/browserSessions.js';
import { resolveConfig } from '../src/config.js';
import { Context } from '../src/context.js';
import { SessionLog } from '../src/sessionLog.js';

import type { CallToolResult } from '@modelcontextprotocol/server';

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
    // Only exercised when a test enables --save-session (the input recorder).
    browserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
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

  it('mints sessions with the opening backend\'s identity, not the last initializer\'s', async () => {
    // A shared registry serves several live backends at once (stateful HTTP
    // sessions, stateless per-request backends). A registry-wide rebindable
    // context constructor made browser_session_open from client A create its
    // Context with whichever backend initialized last — the wrong clientInfo
    // (CDP User-Agent) and SessionLog folder.
    const { factory, createContext } = makeFactory();
    const config = await resolveConfig({});
    const registry = new BrowserSessionRegistry();
    const makeSharedBackend = async (clientName: string) => {
      const backend = new BrowserServerBackend(config, factory, registry);
      await backend.initialize(
          { notifyToolListChanged: async () => {} } as any,
          { name: clientName, version: '1.0.0' },
      );
      return backend;
    };
    const backendA = await makeSharedBackend('client-a');
    // Client B initializes AFTER A; its identity must not leak into A's sessions.
    const backendB = await makeSharedBackend('client-b');

    const id = await openSession(backendA);
    await backendA.callTool('browser_tabs', { action: 'list', browserSessionId: id });
    expect(createContext.mock.calls[0][0]).toMatchObject({ name: 'client-a' });

    // And B's own sessions keep B's identity.
    const idB = await openSession(backendB);
    await backendB.callTool('browser_tabs', { action: 'list', browserSessionId: idB });
    expect(createContext.mock.calls[1][0]).toMatchObject({ name: 'client-b' });
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

  it('refuses a vetoed session open before minting a --save-session directory', async () => {
    // The broker awaited the session-log supplier before registry.open()'s
    // sessionsUnsupportedReason check, so in modes that reject sessions
    // outright every attempt created (and announced) an empty session-*
    // directory — which the rejection itself never even landed in.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-vetoed-log-'));
    try {
      const config = await resolveConfig({ saveSession: true, outputDir });
      const { factory } = makeFactory();
      factory.sessionsUnsupportedReason = 'this connection attaches to the browser\'s existing context. Add --isolated.';
      const backend = new BrowserServerBackend(config, factory);
      await backend.initialize(
          { notifyToolListChanged: async () => {} } as any,
          { name: 'vitest', version: 'browser-sessions' },
      );

      const result = await backend.callTool('browser_session_open', {});
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Cannot open a separate browser session');
      expect(fs.readdirSync(outputDir)).toHaveLength(0);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('rejects unknown handles without disclosing the open sessions', async () => {
    const { factory } = makeFactory();
    const backend = await makeBackend(factory);

    await expect(backend.callTool('browser_tabs', { action: 'list', browserSessionId: 'bs_missing' }))
        .rejects.toThrow(/Unknown browserSessionId "bs_missing".*browser_session_open/);

    // Handles are bearer tokens: a caller probing with a bad handle must not
    // be handed the ids that would route it into other sessions' browsers.
    const id = await openSession(backend);
    let caught: Error | undefined;
    await backend.callTool('browser_tabs', { action: 'list', browserSessionId: 'bs_missing' }).catch(error => caught = error);
    expect(caught).toBeDefined();
    expect(String(caught)).toContain('Unknown browserSessionId "bs_missing"');
    expect(String(caught)).not.toContain(id);

    await expect(backend.callTool('browser_tabs', { action: 'list', browserSessionId: 42 as any }))
        .rejects.toThrow(/Invalid browserSessionId/);
  });

  it('closing an unknown handle is a tool error without disclosing the open sessions', async () => {
    const { factory } = makeFactory();
    const backend = await makeBackend(factory);
    const id = await openSession(backend);

    const result = await backend.callTool('browser_session_close', { browserSessionId: 'bs_missing' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown browserSessionId "bs_missing"');
    expect(textOf(result)).not.toContain(id);
  });

  it('keeps the browserSessionId in what the --save-session log records', async () => {
    // The wire-only handle is stripped before the zod parse, so without the
    // re-attach, calls into different sessions logged identical sessionless
    // args with interleaved snapshots.
    const logResponse = vi.spyOn(SessionLog.prototype, 'logResponse').mockImplementation(() => {});
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-session-log-'));
    try {
      const config = await resolveConfig({ saveSession: true, outputDir });
      const { factory } = makeFactory();
      const backend = new BrowserServerBackend(config, factory);
      await backend.initialize(
          { notifyToolListChanged: async () => {} } as any,
          { name: 'vitest', version: 'browser-sessions' },
      );

      const id = await openSession(backend);
      await backend.callTool('browser_tabs', { action: 'list', browserSessionId: id });
      const routed = logResponse.mock.calls.find(([response]) => response.toolName === 'browser_tabs')![0];
      expect(routed.toolArgs).toMatchObject({ action: 'list', browserSessionId: id });

      // The default session's calls stay unmarked, exactly as before.
      await backend.callTool('browser_tabs', { action: 'list' });
      const unrouted = logResponse.mock.calls.filter(([response]) => response.toolName === 'browser_tabs')[1][0];
      expect(unrouted.toolArgs).not.toHaveProperty('browserSessionId');
    } finally {
      logResponse.mockRestore();
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('hands the minted handle to the session context so recorded user actions are attributable', async () => {
    // The backend's one --save-session log is shared by the default context
    // and every session it opens; a session context that does not know its
    // own handle logs recorder actions no different from anyone else's.
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const logUserAction = vi.spyOn(SessionLog.prototype, 'logUserAction').mockImplementation(() => {});
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-recorder-tag-'));
    try {
      const config = await resolveConfig({ saveSession: true, outputDir });
      const { factory, created } = makeFactory();
      const backend = new BrowserServerBackend(config, factory);
      await backend.initialize(
          { notifyToolListChanged: async () => {} } as any,
          { name: 'vitest', version: 'browser-sessions' },
      );

      const id = await openSession(backend);
      // First routed call launches the session's browser context (and, with
      // --save-session, its input recorder).
      await backend.callTool('browser_tabs', { action: 'list', browserSessionId: id });
      await vi.advanceTimersByTimeAsync(501);

      // A page joins the session's context and the user acts on it.
      const page = new EventEmitter() as any;
      page.setDefaultNavigationTimeout = vi.fn();
      page.setDefaultTimeout = vi.fn();
      page.url = () => 'about:blank';
      created[0].browserContext.emit('page', page);
      const sink = created[0].browserContext._enableRecorder.mock.calls[0][1];
      sink.actionAdded(page, { action: { name: 'click' } }, 'await page.click();');

      expect(logUserAction).toHaveBeenCalledTimes(1);
      const tab = logUserAction.mock.calls[0][1] as any;
      expect(tab.context.options.browserSessionId).toBe(id);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('creates the --save-session directory lazily, only for backends whose own contexts are used', async () => {
    // Over stateless HTTP every request builds a fresh backend; creating the
    // log eagerly at initialize() minted (and announced) an empty session-*
    // folder for every tools/list and every call routed to an existing
    // browser session handle.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-lazy-log-'));
    try {
      const config = await resolveConfig({ saveSession: true, outputDir });
      const { factory } = makeFactory();
      const registry = new BrowserSessionRegistry();
      const makeSharedBackend = async () => {
        const backend = new BrowserServerBackend(config, factory, registry);
        await backend.initialize(
            { notifyToolListChanged: async () => {} } as any,
            { name: 'vitest', version: 'browser-sessions' },
        );
        return backend;
      };
      const sessionDirs = () => fs.readdirSync(outputDir).filter(name => name.startsWith('session-'));

      // A backend that only lists tools never touches its default context.
      const listBackend = await makeSharedBackend();
      await listBackend.listTools();
      expect(sessionDirs()).toHaveLength(0);

      // Opening and using a session is a real use of the opener backend.
      const opener = await makeSharedBackend();
      const id = await openSession(opener);
      expect(sessionDirs()).toHaveLength(1);

      // A fresh backend that only routes to the existing handle creates no
      // directory of its own — the routed call logs into the opener's.
      const router = await makeSharedBackend();
      const routed = await router.callTool('browser_tabs', { action: 'list', browserSessionId: id });
      expect(routed.isError).not.toBe(true);
      expect(sessionDirs()).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('logs a stateless-style close into the opener\'s session log, not a second directory', async () => {
    // browser_session_close runs unrouted, so over stateless HTTP it arrives
    // on a fresh per-request backend while the session was opened by another.
    // Awaiting the closing backend's own lazy log minted a second empty
    // session-* directory per close; the entry belongs in the opener's log,
    // reached through the closed session's Context.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const logResponse = vi.spyOn(SessionLog.prototype, 'logResponse').mockImplementation(() => {});
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-close-log-'));
    try {
      const config = await resolveConfig({ saveSession: true, outputDir });
      const { factory } = makeFactory();
      const registry = new BrowserSessionRegistry();
      const makeSharedBackend = async () => {
        const backend = new BrowserServerBackend(config, factory, registry);
        await backend.initialize(
            { notifyToolListChanged: async () => {} } as any,
            { name: 'vitest', version: 'browser-sessions' },
        );
        return backend;
      };
      const sessionDirs = () => fs.readdirSync(outputDir).filter(name => name.startsWith('session-'));

      const opener = await makeSharedBackend();
      const id = await openSession(opener);
      expect(sessionDirs()).toHaveLength(1);
      const openerLog = await (opener as any)._ensureSessionLog();

      // A fresh backend serves the close, the way each handshake-free HTTP
      // request builds its own.
      const closer = await makeSharedBackend();
      const closed = await closer.callTool('browser_session_close', { browserSessionId: id });
      expect(closed.isError).not.toBe(true);

      expect(sessionDirs()).toHaveLength(1);
      const closeIndex = logResponse.mock.calls.findIndex(([response]) => response.toolName === 'browser_session_close');
      expect(closeIndex).toBeGreaterThanOrEqual(0);
      expect(logResponse.mock.contexts[closeIndex]).toBe(openerLog);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('reports a completed close as success even when the closing backend cannot create its own log', async () => {
    // The session is already disposed by the time the response is logged; a
    // log-creation failure on the closing backend must not convert the
    // completed close into an isError — the caller's retry would only meet
    // "Unknown browserSessionId".
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(SessionLog.prototype, 'logResponse').mockImplementation(() => {});
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-close-nolog-'));
    try {
      const config = await resolveConfig({ saveSession: true, outputDir });
      const { factory } = makeFactory();
      const registry = new BrowserSessionRegistry();
      const makeSharedBackend = async () => {
        const backend = new BrowserServerBackend(config, factory, registry);
        await backend.initialize(
            { notifyToolListChanged: async () => {} } as any,
            { name: 'vitest', version: 'browser-sessions' },
        );
        return backend;
      };

      const opener = await makeSharedBackend();
      const id = await openSession(opener);

      // The closing backend's own log cannot be created (say, the output
      // volume is briefly unavailable when its request arrives).
      vi.spyOn(SessionLog, 'create').mockRejectedValue(new Error('EACCES: output volume unavailable'));
      const closer = await makeSharedBackend();
      const closed = await closer.callTool('browser_session_close', { browserSessionId: id });
      expect(closed.isError).not.toBe(true);
      expect(textOf(closed)).toContain(id);

      // The close really happened: the handle is gone.
      const again = await closer.callTool('browser_session_close', { browserSessionId: id });
      expect(again.isError).toBe(true);
      expect(textOf(again)).toContain('Unknown browserSessionId');
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('retries --save-session log creation after a transient failure instead of memoizing the rejection', async () => {
    // The lazy supplier used `??=`, which retained a rejected SessionLog.create
    // promise: after one transient failure every later browser_session_open
    // (and default-context call) replayed the original rejection until the
    // backend was recreated.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-log-retry-'));
    const outputDir = path.join(parent, 'out');
    // A regular file occupies the output path, so the first create fails.
    fs.writeFileSync(outputDir, '');
    try {
      const config = await resolveConfig({ saveSession: true, outputDir });
      const { factory } = makeFactory();
      const backend = new BrowserServerBackend(config, factory);
      await backend.initialize(
          { notifyToolListChanged: async () => {} } as any,
          { name: 'vitest', version: 'browser-sessions' },
      );

      const failed = await backend.callTool('browser_session_open', {});
      expect(failed.isError).toBe(true);

      // The transient obstruction is fixed; the next open must retry the
      // create instead of replaying the memoized rejection.
      fs.rmSync(outputDir);
      const opened = await backend.callTool('browser_session_open', {});
      expect(opened.isError).not.toBe(true);
      const sessionDirs = fs.readdirSync(outputDir).filter(name => name.startsWith('session-'));
      expect(sessionDirs).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(parent, { recursive: true, force: true });
    }
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

  it('does not reap a session while a download save is still in flight', async () => {
    // Downloads outlive the tool call that starts them, so the running-tool
    // hold alone left a window: a long download in an otherwise idle session
    // was reaped mid-save, aborting the file the response had promised.
    vi.useFakeTimers();
    let pendingDownload = true;
    const context = {
      isRunningTool: () => false,
      recordingActivityAt: () => undefined,
      hasPendingDownloads: () => pendingDownload,
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as Context;
    const registry = new BrowserSessionRegistry(TTL_MS);

    registry.open(() => context);
    // Past the TTL but within the bounded download grace: still held.
    await vi.advanceTimersByTimeAsync(TTL_MS + 60_000);
    expect(context.dispose).not.toHaveBeenCalled();

    // Once the save finishes, normal TTL expiry resumes at the next sweep.
    pendingDownload = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(context.dispose).toHaveBeenCalled();
  });

  it('reaps a session whose download never settles once the grace period lapses', async () => {
    // The download hold must be bounded: a stalled saveAs() on an abandoned
    // handle used to refresh the TTL forever, keeping the browser alive
    // indefinitely — the 30s disposal bound never applied because disposal
    // never began.
    vi.useFakeTimers();
    const context = {
      isRunningTool: () => false,
      recordingActivityAt: () => undefined,
      hasPendingDownloads: () => true,
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as Context;
    const registry = new BrowserSessionRegistry(TTL_MS);

    registry.open(() => context);
    // Anywhere under one extra TTL past expiry the download still holds.
    await vi.advanceTimersByTimeAsync(TTL_MS + TTL_MS / 2);
    expect(context.dispose).not.toHaveBeenCalled();

    // The save never settles: past 2x TTL the session is reaped anyway, and
    // disposal gives the download its own bounded window from there.
    await vi.advanceTimersByTimeAsync(TTL_MS / 2 + 60_000);
    expect(context.dispose).toHaveBeenCalled();
  });

  it('holds an active recording while actions continue but expires an abandoned one', async () => {
    vi.useFakeTimers();
    let recordingActivityAt = Date.now();
    const context = {
      isRunningTool: () => false,
      recordingActivityAt: () => recordingActivityAt,
      hasPendingDownloads: () => false,
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as Context;
    const registry = new BrowserSessionRegistry(TTL_MS);

    registry.open(() => context);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(TTL_MS / 2);
      recordingActivityAt = Date.now();
      expect(context.dispose).not.toHaveBeenCalled();
    }

    await vi.advanceTimersByTimeAsync(TTL_MS + 60_000);
    expect(context.dispose).toHaveBeenCalled();
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
