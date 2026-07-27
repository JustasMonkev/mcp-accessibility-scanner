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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Context } from '../src/context.js';
import type { BrowserContextFactory } from '../src/browserContextFactory.js';
import { EventEmitter } from 'events';

describe('Context', () => {
  let mockBrowserContextFactory: BrowserContextFactory;
  let mockBrowserContext: any;

  beforeEach(() => {
    mockBrowserContext = new EventEmitter();
    mockBrowserContext.newPage = vi.fn().mockResolvedValue({});
    mockBrowserContext.pages = vi.fn().mockReturnValue([]);
    mockBrowserContext.route = vi.fn().mockResolvedValue(undefined);
    mockBrowserContext.tracing = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    mockBrowserContextFactory = {
      createContext: vi.fn().mockResolvedValue({
        browserContext: mockBrowserContext,
        close: vi.fn().mockResolvedValue(undefined),
      }),
    } as any;
  });

  afterEach(async () => {
    await Context.disposeAll();
  });

  describe('constructor', () => {
    it('should create context with options', () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      expect(context.tools).toEqual([]);
      expect(context.config).toBeDefined();
    });
  });

  describe('tabs', () => {
    it('should return empty array initially', () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      expect(context.tabs()).toEqual([]);
    });
  });

  describe('currentTab', () => {
    it('should return undefined when no tabs exist', () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      expect(context.currentTab()).toBeUndefined();
    });
  });

  describe('currentTabOrDie', () => {
    it('should throw error when no tabs exist', () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      expect(() => context.currentTabOrDie()).toThrow('No open pages available');
    });
  });

  describe('browser context setup failure', () => {
    it('closes the factory-owned context when setup after createContext fails', async () => {
      // The factory hands ownership over with close(); a tracing (or any
      // post-factory) setup failure must not discard that callback with the
      // browser still running — for storage-state sessions that would pin the
      // disposable profile forever.
      const close = vi.fn().mockResolvedValue(undefined);
      mockBrowserContext.tracing.start.mockRejectedValue(new Error('traces dir is not writable'));
      (mockBrowserContextFactory.createContext as any).mockResolvedValue({
        browserContext: mockBrowserContext,
        close,
      });
      const context = new Context({
        tools: [],
        config: { saveTrace: true } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      await expect(context.newTab()).rejects.toThrow('traces dir is not writable');
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('tolerates tracing already started by a sibling session on a shared context', async () => {
      // Two sessions sharing a reused context with --save-trace: the second
      // tracing.start() deterministically rejects with "already started".
      // Failing setup for that would run cleanup and tear down the shared
      // connection under the sibling's live audit — the recording is running,
      // which is what --save-trace asked for.
      const close = vi.fn().mockResolvedValue(undefined);
      mockBrowserContext.tracing.start.mockRejectedValue(new Error('Tracing has been already started'));
      (mockBrowserContextFactory.createContext as any).mockResolvedValue({
        browserContext: mockBrowserContext,
        close,
      });
      const context = new Context({
        tools: [],
        config: { saveTrace: true } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      await context.newTab();

      expect(close).not.toHaveBeenCalled();
    });

    it('closes the factory-owned context even when stopping tracing fails on shutdown', async () => {
      // This close attempt is the only one — _browserContextPromise is cleared
      // before the trace stop — so a failing tracing.stop() must not skip the
      // factory's close(), or a storage-state session's disposable profile
      // leaks with every failed shutdown.
      const close = vi.fn().mockResolvedValue(undefined);
      mockBrowserContext.tracing.stop.mockRejectedValue(new Error('browser disconnected'));
      (mockBrowserContextFactory.createContext as any).mockResolvedValue({
        browserContext: mockBrowserContext,
        close,
      });
      const context = new Context({
        tools: [],
        config: { saveTrace: true } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      await context.newTab();
      await context.closeBrowserContext();

      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  describe('shared context observers', () => {
    function createMockPage() {
      const page = new EventEmitter() as any;
      page.setDefaultNavigationTimeout = vi.fn();
      page.setDefaultTimeout = vi.fn();
      page.url = () => 'about:blank';
      return page;
    }

    it('removes its page observers and tab wrappers from the context on close', async () => {
      // A non-isolated CDP context is shared and survives this session's
      // close; the session's 'page' listener and its tabs' page listeners
      // must not — they would keep creating tabs inside a disposed Context
      // and pile up with session churn.
      const context = new Context({
        tools: [],
        config: { timeouts: {} } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });
      await context.newTab();

      const page = createMockPage();
      mockBrowserContext.emit('page', page);
      expect(context.tabs()).toHaveLength(1);
      expect(page.listenerCount('console')).toBeGreaterThan(0);

      await context.closeBrowserContext();

      expect(context.tabs()).toHaveLength(0);
      expect(page.listenerCount('console')).toBe(0);
      expect(mockBrowserContext.listenerCount('page')).toBe(0);
      // A page opened by a sibling after this session closed must not
      // resurrect tabs inside the disposed session.
      mockBrowserContext.emit('page', createMockPage());
      expect(context.tabs()).toHaveLength(0);
    });
  });

  describe('shared context recorder', () => {
    it('multiplexes recorder events so a departing session does not silence the survivor', async () => {
      // Playwright's _enableRecorder supports one sink per context; a second
      // session used to replace the first session's callbacks, and a closing
      // session left the sink pointing at its disposed Context.
      mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
      const log1 = { logUserAction: vi.fn() };
      const log2 = { logUserAction: vi.fn() };
      const makeContext = (sessionLog: any) => new Context({
        tools: [],
        config: { timeouts: {} } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog,
        clientInfo: { rootPath: '/tmp' } as any,
      });
      const context1 = makeContext(log1);
      await context1.newTab();

      // A page owned by session 1 arrives before session 2 joins.
      const page = new EventEmitter() as any;
      page.setDefaultNavigationTimeout = vi.fn();
      page.setDefaultTimeout = vi.fn();
      page.url = () => 'about:blank';
      mockBrowserContext.emit('page', page);

      const context2 = makeContext(log2);
      await context2.newTab();

      expect(mockBrowserContext._enableRecorder).toHaveBeenCalledTimes(1);
      const sink = mockBrowserContext._enableRecorder.mock.calls[0][1];

      // Session 2 leaves; the shared context (and session 1) live on.
      await context2.closeBrowserContext();
      sink.actionAdded(page, { action: { name: 'click' } }, 'await page.click();');

      expect(log1.logUserAction).toHaveBeenCalledTimes(1);
      expect(log2.logUserAction).not.toHaveBeenCalled();
    });
  });

  describe('isRunningTool', () => {
    it('should return false initially', () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      expect(context.isRunningTool()).toBe(false);
    });

    it('should return true when tool is running', () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      context.setRunningTool('test_tool');
      expect(context.isRunningTool()).toBe(true);
    });

    it('should return false after tool completes', () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      context.setRunningTool('test_tool');
      context.setRunningTool(undefined);
      expect(context.isRunningTool()).toBe(false);
    });
  });
});
