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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProtocolErrorCode } from '@modelcontextprotocol/server';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { BrowserSessionRegistry } from '../src/browserSessions.js';
import { resolveConfig } from '../src/config.js';
import type { BrowserContextFactory } from '../src/browserContextFactory.js';
import type * as playwright from 'playwright';

const unusedFactory = {
  createContext: async () => {
    throw new Error('browser should not be launched in this test');
  },
} as any;

describe('BrowserServerBackend.callTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects unknown tools with an InvalidParams protocol error', async () => {
    const config = await resolveConfig({});
    const backend = new BrowserServerBackend(config, unusedFactory);
    await expect(backend.callTool('does_not_exist', {}))
        .rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
  });

  it('reports invalid tool input as a readable execution error', async () => {
    const config = await resolveConfig({});
    const backend = new BrowserServerBackend(config, unusedFactory);
    await expect(backend.callTool('browser_navigate', { url: 123 }))
        .rejects.toThrow(/Invalid input for tool "browser_navigate"/);
  });

  it('registers no session when the --save-session log cannot be created', async () => {
    // The session log used to be awaited only AFTER browser_session_open had
    // registered its Context: the rejection became an isError result carrying
    // no handle to close, so every retry accumulated another live session
    // until TTL reaping. The log must resolve before the handle is minted.
    const blockingFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-log-')), 'not-a-dir');
    fs.writeFileSync(blockingFile, '');
    const config = await resolveConfig({
      saveSession: true,
      // mkdir of the output directory fails with ENOTDIR under a plain file.
      outputDir: path.join(blockingFile, 'session-output'),
    });
    const registry = new BrowserSessionRegistry();
    const backend = new BrowserServerBackend(config, unusedFactory, registry);
    await backend.initialize({} as any, { name: 'vitest', version: '1.0.0' });

    const result = await backend.callTool('browser_session_open', {});
    expect(result.isError).toBe(true);
    expect((registry as any)._sessions.size).toBe(0);
  });

  it('logs a routed no-browser call made before the session launches a browser', async () => {
    // With --save-session, a routed call used to read context.sessionLog,
    // which is populated only when the session launches its browser. A
    // no-browser tool (browser_default_timeout) as the FIRST call in a fresh
    // explicit session therefore returned fine but never reached session.md.
    // The routed branch must resolve the session's log supplier — the opener
    // backend's async-once log — instead of reading the possibly-unset field.
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-routed-log-'));
    // Silence SessionLog.create()'s `Session: <folder>` announcement.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const config = await resolveConfig({ saveSession: true, outputDir });
      const registry = new BrowserSessionRegistry();
      const opener = new BrowserServerBackend(config, unusedFactory, registry);
      await opener.initialize({} as any, { name: 'vitest', version: '1.0.0' });
      const openResult = await opener.callTool('browser_session_open', {});
      expect(openResult.isError).not.toBe(true);
      const browserSessionId = (openResult.structuredContent as any).browserSessionId as string;

      // Route through a SECOND backend sharing the registry, as stateless
      // HTTP does: the call must land in the OPENER backend's log, not mint
      // one for the router.
      const router = new BrowserServerBackend(config, unusedFactory, registry);
      await router.initialize({} as any, { name: 'vitest', version: '1.0.0' });
      const result = await router.callTool('browser_default_timeout', { timeout: 30000, browserSessionId });
      expect(result.isError).not.toBe(true);

      // Flush the log's debounced buffer deterministically.
      const sessionLog = await (opener as any)._sessionLog;
      expect(sessionLog).toBeDefined();
      await (sessionLog as any)._flushEntries();
      await (sessionLog as any)._sessionFileQueue;

      const sessionFolders = fs.readdirSync(outputDir).filter(name => name.startsWith('session-'));
      // The routing backend minted no log of its own.
      expect(sessionFolders).toHaveLength(1);
      const sessionMd = fs.readFileSync(path.join(outputDir, sessionFolders[0], 'session.md'), 'utf-8');
      expect(sessionMd).toContain('browser_default_timeout');
      expect(sessionMd).toContain(browserSessionId);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('returns the trace warning from per-request teardown in the same stateless response', async () => {
    // Teardown trace damage must be visible before the response is serialized.
    const config = await resolveConfig({ saveTrace: true });
    const page = Object.assign(new EventEmitter(), {
      context: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      setDefaultTimeout: vi.fn(),
    });
    const browserContext = Object.assign(new EventEmitter(), {
      newPage: vi.fn().mockResolvedValue(page),
      pages: vi.fn().mockReturnValue([]),
      route: vi.fn().mockResolvedValue(undefined),
      tracing: {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockRejectedValue(new Error('browser disconnected')),
      },
    });
    page.context.mockReturnValue(browserContext);
    const close = vi.fn().mockResolvedValue(undefined);
    const factory: BrowserContextFactory = {
      // SAFETY: this test double implements every BrowserContext member read by Context.
      createContext: vi.fn().mockResolvedValue({ browserContext: browserContext as playwright.BrowserContext, close }),
    };
    const backend = new BrowserServerBackend(config, factory, undefined, { ephemeralDefaultContext: true });
    await backend.initialize({ notifyToolListChanged: vi.fn() }, { name: 'vitest', version: '1.0.0' });

    const result = await backend.callTool('browser_tabs', { action: 'new' });

    const content = result.content[0];
    expect(content.type).toBe('text');
    if (content.type !== 'text')
      throw new Error('Expected text content');
    expect(content.text).toContain('saved trace may be incomplete');
    expect(browserContext.tracing.stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    backend.serverClosed();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it('waits for overlapping stateless calls before tearing down their shared default context', async () => {
    const config = await resolveConfig({});
    const browserContext = new EventEmitter();
    const pages: playwright.Page[] = [];
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>(resolve => releaseSecond = resolve);
    const newPage = vi.fn(async () => {
      const page = Object.assign(new EventEmitter(), {
        context: () => browserContext,
        setDefaultNavigationTimeout: vi.fn(),
        setDefaultTimeout: vi.fn(),
        title: vi.fn().mockResolvedValue('title'),
        url: () => 'about:blank',
        // SAFETY: this test double implements every Page member read by Tab.
      }) as playwright.Page;
      pages.push(page);
      browserContext.emit('page', page);
      if (pages.length === 2)
        await secondGate;
      return page;
    });
    Object.assign(browserContext, {
      newPage,
      pages: () => [],
      route: vi.fn().mockResolvedValue(undefined),
    });
    const close = vi.fn().mockResolvedValue(undefined);
    const factory: BrowserContextFactory = {
      // SAFETY: this test double implements every BrowserContext member read by Context.
      createContext: vi.fn().mockResolvedValue({ browserContext: browserContext as playwright.BrowserContext, close }),
    };
    const backend = new BrowserServerBackend(config, factory, undefined, { ephemeralDefaultContext: true });
    await backend.initialize({ notifyToolListChanged: vi.fn() }, { name: 'vitest', version: '1.0.0' });

    let firstSettled = false;
    const first = backend.callTool('browser_tabs', { action: 'new' }).finally(() => firstSettled = true);
    const second = backend.callTool('browser_tabs', { action: 'new' });
    await vi.waitFor(() => expect(newPage).toHaveBeenCalledTimes(2));

    expect(firstSettled).toBe(false);
    expect(close).not.toHaveBeenCalled();
    releaseSecond();
    await Promise.all([first, second]);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
