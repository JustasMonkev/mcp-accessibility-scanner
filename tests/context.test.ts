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
import { resolveConfig } from '../src/config.js';
import { Context } from '../src/context.js';
import { Response } from '../src/response.js';
import type { BrowserContextFactory } from '../src/browserContextFactory.js';
import { EventEmitter } from 'events';

describe('closePage', () => {
  type CloseablePage = {
    url: () => string;
    close: () => Promise<void>;
    isClosed: () => boolean;
  };

  const browserContextFactory: BrowserContextFactory = {
    createContext: async () => { throw new Error('Not used by closeTab tests.'); },
  };

  const contextFor = async (page: CloseablePage) => {
    const context = new Context({
      tools: [],
      config: await resolveConfig({}),
      browserContextFactory,
      sessionLog: undefined,
      clientInfo: {},
    });
    const tab = { page, operationTimeout: () => 5000 };
    Object.assign(context, { _tabs: [tab], _currentTab: tab });
    return context;
  };

  it('retries when Chromium acknowledges a close but leaves the target alive', async () => {
    let closed = false;
    const page = {
      url: () => 'https://example.com',
      close: vi.fn()
          .mockResolvedValueOnce(undefined)
          .mockImplementationOnce(async () => { closed = true; }),
      isClosed: vi.fn(() => closed),
    };
    const context = await contextFor(page);

    try {
      await expect(context.closeTab(undefined)).resolves.toBe('https://example.com');
      expect(page.close).toHaveBeenCalledTimes(2);
    } finally {
      await context.dispose();
    }
  });

  it('allows a slow remote page to close within the operation timeout', async () => {
    vi.useFakeTimers();
    let closed = false;
    let finishClose = () => {};
    const page = {
      url: () => 'https://example.com',
      close: vi.fn(() => new Promise<void>(resolve => {
        finishClose = () => {
          closed = true;
          resolve();
        };
      })),
      isClosed: vi.fn(() => closed),
    };
    const context = await contextFor(page);

    try {
      const closing = context.closeTab(undefined);
      await vi.advanceTimersByTimeAsync(4000);
      expect(page.close).toHaveBeenCalledTimes(1);

      finishClose();
      await expect(closing).resolves.toBe('https://example.com');
      expect(page.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      await context.dispose();
    }
  });

  it('reuses a timed-out close request when another tool call retries', async () => {
    vi.useFakeTimers();
    let closed = false;
    let finishClose = () => {};
    const page = {
      url: () => 'https://example.com',
      close: vi.fn(() => new Promise<void>(resolve => {
        finishClose = () => {
          closed = true;
          resolve();
        };
      })),
      isClosed: vi.fn(() => closed),
    };
    const context = await contextFor(page);

    try {
      const failure = expect(context.closeTab(undefined)).rejects.toThrow('Timed out after 5000ms');
      await vi.advanceTimersByTimeAsync(5000);
      await failure;

      const retry = context.closeTab(undefined);
      expect(page.close).toHaveBeenCalledTimes(1);
      finishClose();
      await expect(retry).resolves.toBe('https://example.com');
    } finally {
      vi.useRealTimers();
      await context.dispose();
    }
  });
});

describe('Context', () => {
  let mockBrowserContextFactory: BrowserContextFactory;
  let mockBrowserContext: any;
  let defaultConfig: Awaited<ReturnType<typeof resolveConfig>>;

  beforeEach(async () => {
    defaultConfig = await resolveConfig({});
    mockBrowserContext = new EventEmitter();
    mockBrowserContext.newPage = vi.fn().mockResolvedValue({});
    mockBrowserContext.pages = vi.fn().mockReturnValue([]);
    mockBrowserContext.route = vi.fn().mockResolvedValue(undefined);
    mockBrowserContext._disableRecorder = vi.fn().mockResolvedValue(undefined);
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
        config: defaultConfig,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });

      expect(context.tools).toEqual([]);
      expect(context.config).toBeDefined();
    });
  });

  describe('tabs', () => {
    it('should return empty array initially', () => {
      const context = new Context({
        tools: [],
        config: defaultConfig,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });

      expect(context.tabs()).toEqual([]);
    });
  });

  describe('currentTab', () => {
    it('should return undefined when no tabs exist', () => {
      const context = new Context({
        tools: [],
        config: defaultConfig,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });

      expect(context.currentTab()).toBeUndefined();
    });
  });

  describe('currentTabOrDie', () => {
    it('should throw error when no tabs exist', () => {
      const context = new Context({
        tools: [],
        config: defaultConfig,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
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
        config: { ...defaultConfig, saveTrace: true },
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });

      await expect(context.newTab()).rejects.toThrow('traces dir is not writable');
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('does not take ownership of a trace started outside this server', async () => {
      const close = vi.fn().mockResolvedValue(undefined);
      mockBrowserContext.tracing.start.mockRejectedValue(new Error('Tracing has been already started'));
      (mockBrowserContextFactory.createContext as any).mockResolvedValue({
        browserContext: mockBrowserContext,
        close,
      });
      const context = new Context({
        tools: [],
        config: { ...defaultConfig, saveTrace: true },
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });

      await expect(context.newTab()).rejects.toThrow('already started');

      expect(close).toHaveBeenCalledTimes(1);
      expect(mockBrowserContext.tracing.stop).not.toHaveBeenCalled();
    });

    it('keeps a shared trace running until the final session closes', async () => {
      const first = new Context({
        tools: [],
        config: { ...defaultConfig, saveTrace: true },
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });
      const second = new Context({
        tools: [],
        config: { ...defaultConfig, saveTrace: true },
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });

      await first.newTab();
      await second.newTab();
      expect(mockBrowserContext.tracing.start).toHaveBeenCalledTimes(1);

      await first.closeBrowserContext();
      expect(mockBrowserContext.tracing.stop).not.toHaveBeenCalled();

      await second.closeBrowserContext();
      expect(mockBrowserContext.tracing.stop).toHaveBeenCalledTimes(1);
    });

    it('gives each context its own trace name so traces in a shared tracesDir never collide', async () => {
      // With --isolated several sessions' contexts share the browser's one
      // cached tracesDir; a fixed name made every context write the same
      // trace.trace/trace.network files concurrently.
      const makeMockContext = () => {
        const browserContext: any = new EventEmitter();
        browserContext.newPage = vi.fn().mockResolvedValue({});
        browserContext.pages = vi.fn().mockReturnValue([]);
        browserContext.route = vi.fn().mockResolvedValue(undefined);
        browserContext.tracing = {
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
        };
        return browserContext;
      };
      const first = makeMockContext();
      const second = makeMockContext();
      (mockBrowserContextFactory.createContext as any)
          .mockResolvedValueOnce({ browserContext: first, close: vi.fn().mockResolvedValue(undefined) })
          .mockResolvedValueOnce({ browserContext: second, close: vi.fn().mockResolvedValue(undefined) });
      const makeContext = () => new Context({
        tools: [],
        config: { ...defaultConfig, saveTrace: true },
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });

      await makeContext().newTab();
      await makeContext().newTab();

      const firstName = first.tracing.start.mock.calls[0][0].name;
      const secondName = second.tracing.start.mock.calls[0][0].name;
      // The 'trace' prefix keeps the printed viewer URL (…/trace.json, served
      // as a prefix descriptor) matching the files.
      expect(firstName).toMatch(/^trace-/);
      expect(secondName).toMatch(/^trace-/);
      expect(firstName).not.toBe(secondName);
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
        config: { ...defaultConfig, saveTrace: true },
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });

      await context.newTab();
      await context.closeBrowserContext();

      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  describe('pending downloads', () => {
    it('waits for an in-flight download save before closing the browser context', async () => {
      // A download outlives the tool call that started it (the response even
      // reports it as "still downloading"); the stateless HTTP path disposes
      // the backend's default context the moment the response closes, which
      // used to abort saveAs() and leave the reported file missing/partial.
      const close = vi.fn().mockResolvedValue(undefined);
      (mockBrowserContextFactory.createContext as any).mockResolvedValue({
        browserContext: mockBrowserContext,
        close,
      });
      const context = new Context({
        tools: [],
        config: defaultConfig,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });
      await context.newTab();

      let finishDownload = () => {};
      context.trackPendingDownload(new Promise<void>(resolve => finishDownload = resolve));
      expect(context.hasPendingDownloads()).toBe(true);

      const disposing = context.dispose();
      // Give disposal a few turns: it must be parked on the download, not on
      // the factory close.
      for (let i = 0; i < 10; i++)
        await Promise.resolve();
      expect(close).not.toHaveBeenCalled();

      finishDownload();
      await disposing;
      expect(close).toHaveBeenCalledTimes(1);
      expect(context.hasPendingDownloads()).toBe(false);
    });

    it('abandons a stalled download after the 30s cap instead of hanging disposal', async () => {
      vi.useFakeTimers();
      try {
        const close = vi.fn().mockResolvedValue(undefined);
        (mockBrowserContextFactory.createContext as any).mockResolvedValue({
          browserContext: mockBrowserContext,
          close,
        });
        const context = new Context({
          tools: [],
          config: defaultConfig,
          browserContextFactory: mockBrowserContextFactory,
          sessionLog: undefined,
          clientInfo: {},
        });
        await context.newTab();

        // Never resolves: a download stalled forever must not stall disposal.
        context.trackPendingDownload(new Promise(() => {}));

        const disposing = context.dispose();
        await vi.advanceTimersByTimeAsync(30_000);
        await disposing;
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('signals closeStarting to the factory before waiting out the download drain', async () => {
      // The persistent factory needs the notice AHEAD of the bounded drain:
      // it is what lets a stable-profile successor arriving mid-drain be
      // told apart from a genuinely concurrent context.
      const close = vi.fn().mockResolvedValue(undefined);
      const closeStarting = vi.fn();
      (mockBrowserContextFactory.createContext as any).mockResolvedValue({
        browserContext: mockBrowserContext,
        close,
        closeStarting,
      });
      const context = new Context({
        tools: [],
        config: defaultConfig,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });
      await context.newTab();

      let finishDownload = () => {};
      context.trackPendingDownload(new Promise<void>(resolve => finishDownload = resolve));
      const closing = context.closeBrowserContext();
      for (let i = 0; i < 10; i++)
        await Promise.resolve();
      // The notice landed while close() is still parked on the drain.
      expect(closeStarting).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();

      finishDownload();
      await closing;
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('rejects a tool call arriving during the download drain instead of handing out the closing context', async () => {
      // The last tab closing with a download pending starts the bounded drain,
      // but _browserContextPromise used to stay published for its duration: a
      // browser_navigate/browser_tabs call in that window reused the closing
      // context, and its fresh tab was silently torn down when the drain
      // settled. The closing context must be unpublished before the drain so
      // such calls get the existing "being closed" rejection instead.
      const close = vi.fn().mockResolvedValue(undefined);
      (mockBrowserContextFactory.createContext as any).mockResolvedValue({
        browserContext: mockBrowserContext,
        close,
      });
      const context = new Context({
        tools: [],
        config: defaultConfig,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });
      await context.newTab();

      let finishDownload = () => {};
      context.trackPendingDownload(new Promise<void>(resolve => finishDownload = resolve));
      // The path _onPageClosed takes when the last tab closes.
      const closing = context.closeBrowserContext();
      // Park the close on the download drain.
      for (let i = 0; i < 10; i++)
        await Promise.resolve();
      expect(close).not.toHaveBeenCalled();

      // A tool call mid-drain must never get a tab in the draining context.
      await expect(context.newTab()).rejects.toThrow('Another browser context is being closed');

      finishDownload();
      await closing;
      expect(close).toHaveBeenCalledTimes(1);

      // Once the close has settled, the next tool call starts a fresh context.
      await context.newTab();
      expect(mockBrowserContextFactory.createContext).toHaveBeenCalledTimes(2);
    });

    it('logs a failed download save instead of leaving an unhandled rejection', async () => {
      const context = new Context({
        tools: [],
        config: defaultConfig,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });
      context.trackPendingDownload(Promise.reject(new Error('canceled')));
      // The tracked rejection settles handled; the set drains.
      await new Promise(resolve => setImmediate(resolve));
      expect(context.hasPendingDownloads()).toBe(false);
      expect(context.takeDownloadErrors()).toEqual(['Failed to save download: canceled']);
      expect(context.takeDownloadErrors()).toEqual([]);
      await context.dispose();
    });

    it('reports a failed save on the next tool response even after its tab closes', async () => {
      const context = new Context({
        tools: [], config: defaultConfig, browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined, clientInfo: {},
      });
      await context.newTab();
      const page = Object.assign(new EventEmitter(), {
        setDefaultNavigationTimeout: vi.fn(), setDefaultTimeout: vi.fn(), url: () => 'https://fixture.local/',
      });
      mockBrowserContext.emit('page', page);
      expect(context.tabs()).toHaveLength(1);
      vi.spyOn(context, 'outputFile').mockResolvedValue('/tmp/not-created.txt');
      const save = Promise.withResolvers<void>();
      const download = { suggestedFilename: () => 'report.txt', saveAs: vi.fn(() => save.promise) };
      page.emit('download', download);
      await vi.waitFor(() => expect(download.saveAs).toHaveBeenCalledOnce());
      page.emit('close');
      save.reject(new Error('Target page, context or browser has been closed'));
      await vi.waitFor(() => expect(context.hasPendingDownloads()).toBe(false));
      expect(context.currentTab()).toBeUndefined();

      const response = new Response(context, 'browser_snapshot', {});
      // Failed tool handlers skip finish(), just as currentTabOrDie does after
      // a native browser disconnect. Serialization must still report the save.
      expect(() => context.currentTabOrDie()).toThrow('No open pages');
      response.addError('No open pages available');
      const result = response.serialize();
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Failed to save download "report.txt": Target page, context or browser has been closed') });
      expect(result.content[0]).toMatchObject({ type: 'text', text: expect.not.stringContaining('/tmp/not-created.txt') });
      expect(context.takeDownloadErrors()).toEqual([]);
    });

    it('bounds retained download failures and reports omitted errors once', async () => {
      const context = new Context({
        tools: [], config: defaultConfig, browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined, clientInfo: {},
      });
      for (let i = 0; i < 23; i++)
        context.trackPendingDownload(Promise.reject(new Error('ė'.repeat(5000))), 'report.txt');
      await vi.waitFor(() => expect(context.hasPendingDownloads()).toBe(false));
      const errors = context.takeDownloadErrors();
      expect(errors).toHaveLength(21);
      expect(errors[0]).toContain('[truncated]');
      expect(Buffer.byteLength(errors[0])).toBeLessThan(2048);
      expect(errors[20]).toBe('Omitted 3 additional download failure(s).');
      expect(context.takeDownloadErrors()).toEqual([]);
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
        clientInfo: {},
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
        sessionLog: () => Promise.resolve(sessionLog),
        clientInfo: {},
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

    it('keeps the surviving session logging on a page a departed sibling also wrapped', async () => {
      // Both sessions wrap the same shared page; the departing one used to
      // delete the global page→tab entry it had overwritten, leaving the
      // survivor's recorder events without a tab to log against.
      mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
      const log1 = { logUserAction: vi.fn() };
      const log2 = { logUserAction: vi.fn() };
      const makeContext = (sessionLog: any) => new Context({
        tools: [],
        config: { timeouts: {} } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: () => Promise.resolve(sessionLog),
        clientInfo: {},
      });
      const context1 = makeContext(log1);
      await context1.newTab();
      const context2 = makeContext(log2);
      await context2.newTab();

      const page = new EventEmitter() as any;
      page.setDefaultNavigationTimeout = vi.fn();
      page.setDefaultTimeout = vi.fn();
      page.url = () => 'about:blank';
      mockBrowserContext.emit('page', page);

      await context2.closeBrowserContext();
      const sink = mockBrowserContext._enableRecorder.mock.calls[0][1];
      sink.actionAdded(page, { action: { name: 'click' } }, 'await page.click();');

      expect(log1.logUserAction).toHaveBeenCalledTimes(1);
      expect(log2.logUserAction).not.toHaveBeenCalled();
    });

    it('suppresses recorder events for every session while a sibling runs a tool', async () => {
      vi.useFakeTimers();
      // The recorder cannot attribute a DOM event to the session that caused
      // it, so a tool call in one session must not be recorded as another
      // session's user action.
      mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
      const log1 = { logUserAction: vi.fn() };
      const log2 = { logUserAction: vi.fn() };
      const makeContext = (sessionLog: any) => new Context({
        tools: [],
        config: { timeouts: {} } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: () => Promise.resolve(sessionLog),
        clientInfo: {},
      });
      const context1 = makeContext(log1);
      await context1.newTab();
      const context2 = makeContext(log2);
      await context2.newTab();

      const page = new EventEmitter() as any;
      page.setDefaultNavigationTimeout = vi.fn();
      page.setDefaultTimeout = vi.fn();
      page.url = () => 'about:blank';
      mockBrowserContext.emit('page', page);

      const sink = mockBrowserContext._enableRecorder.mock.calls[0][1];
      const endToolCall = context1.beginToolCall('browser_click');
      sink.actionAdded(page, { action: { name: 'click' } }, 'await page.click();');
      expect(log1.logUserAction).not.toHaveBeenCalled();
      expect(log2.logUserAction).not.toHaveBeenCalled();

      endToolCall();
      await vi.advanceTimersByTimeAsync(501);
      sink.actionAdded(page, { action: { name: 'click' } }, 'await page.click();');
      expect(log1.logUserAction).toHaveBeenCalledTimes(1);
      expect(log2.logUserAction).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('records its own tool actions but not a sibling session\'s actions', async () => {
      mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
      const makeContext = () => new Context({
        tools: [],
        config: { timeouts: {} } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });
      const context1 = makeContext();
      const context2 = makeContext();
      await context1.startRecording();
      await context2.startRecording();
      expect(mockBrowserContext._enableRecorder.mock.calls[0][0]).toMatchObject({
        mode: 'recording',
        recorderMode: 'api',
        omitCallTracking: true,
        language: 'javascript',
      });
      const sink = mockBrowserContext._enableRecorder.mock.calls[0][1];

      const endContext1Tool = context1.beginToolCall('browser_click');
      sink.actionAdded({} as any, { action: { name: 'click' } }, 'await page.getByText(\'One\').click();');
      endContext1Tool();

      expect(await context1.stopRecording()).toEqual(["await page.getByText('One').click();"]);
      expect(mockBrowserContext._disableRecorder).not.toHaveBeenCalled();
      expect(await context2.stopRecording()).toEqual([]);
      expect(mockBrowserContext._disableRecorder).toHaveBeenCalledTimes(1);
    });

    it('keeps a sibling tool action excluded through the recorder buffer', async () => {
      vi.useFakeTimers();
      try {
        mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
        const makeContext = () => new Context({
          tools: [],
          config: { timeouts: {} } as any,
          browserContextFactory: mockBrowserContextFactory,
          sessionLog: undefined,
          clientInfo: {},
        });
        const recordingContext = makeContext();
        const siblingContext = makeContext();
        await recordingContext.startRecording();
        await siblingContext.newTab();
        const sink = mockBrowserContext._enableRecorder.mock.calls[0][1];

        const endSiblingTool = siblingContext.beginToolCall('browser_click');
        endSiblingTool();
        await vi.advanceTimersByTimeAsync(499);
        sink.actionAdded({} as any, { action: { name: 'click', button: 'left' } }, 'sibling action');
        sink.actionAdded({} as any, { action: { name: 'press' } }, 'manual press');

        const stopping = recordingContext.stopRecording();
        await vi.advanceTimersByTimeAsync(500);
        await expect(stopping).resolves.toEqual(['manual press']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not suppress user actions while a sibling controls recording', async () => {
      mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
      const makeContext = () => new Context({
        tools: [],
        config: { timeouts: {} } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });
      const recordingContext = makeContext();
      const siblingContext = makeContext();
      await recordingContext.startRecording();
      await siblingContext.newTab();
      const sink = mockBrowserContext._enableRecorder.mock.calls[0][1];

      const endControlCall = siblingContext.beginToolCall('browser_start_recording');
      sink.actionAdded({} as any, { action: { name: 'click', button: 'left' } }, 'manual click');
      endControlCall();

      expect(await recordingContext.stopRecording()).toEqual(['manual click']);
    });

    it('keeps generated assertions executable for recordings and session logs', async () => {
      mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
      const sessionLog = { logUserAction: vi.fn() };
      const context = new Context({
        tools: [],
        config: { timeouts: {} } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: () => Promise.resolve(sessionLog),
        clientInfo: {},
      });
      await context.startRecording();
      const page = new EventEmitter() as any;
      page.setDefaultNavigationTimeout = vi.fn();
      page.setDefaultTimeout = vi.fn();
      page.url = () => 'about:blank';
      mockBrowserContext.emit('page', page);
      const sink = mockBrowserContext._enableRecorder.mock.calls[0][1];
      sink.actionAdded(page, { name: 'assertVisible', selector: 'text=Done', signals: [] }, '// await expect(page.getByText(\'Done\')).toBeVisible();');

      expect(await context.stopRecording()).toEqual([
        "const { expect } = require('playwright/test');",
        "await expect(page.getByText('Done')).toBeVisible();",
      ]);
      expect(sessionLog.logUserAction).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'assertVisible' }),
          expect.anything(),
          "const { expect } = require('playwright/test');\nawait expect(page.getByText('Done')).toBeVisible();",
          false,
      );
    });

    it('updates session-log actions with signal-generated code', async () => {
      mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
      const sessionLog = { logUserAction: vi.fn() };
      const context = new Context({
        tools: [],
        config: { timeouts: {} } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: () => Promise.resolve(sessionLog),
        clientInfo: {},
      });
      await context.newTab();
      const page = new EventEmitter() as any;
      page.setDefaultNavigationTimeout = vi.fn();
      page.setDefaultTimeout = vi.fn();
      page.url = () => 'about:blank';
      mockBrowserContext.emit('page', page);
      const sink = mockBrowserContext._enableRecorder.mock.calls[0][1];
      const action = { name: 'click', selector: 'text=Open', button: 'left', signals: [] };
      sink.actionAdded(page, action, "await page.getByText('Open').click();");
      sink.signalAdded(page, { name: 'popup', popupAlias: '1' }, "const page1Promise = page.waitForEvent('popup');\nawait page.getByText('Open').click();");

      expect(sessionLog.logUserAction).toHaveBeenLastCalledWith(
          action,
          expect.anything(),
          "const page1Promise = page.waitForEvent('popup');\nawait page.getByText('Open').click();",
          true,
      );
    });

    it('ignores signals whose initial action was suppressed', async () => {
      vi.useFakeTimers();
      try {
        mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
        const sessionLog = { logUserAction: vi.fn() };
        const config = await resolveConfig({});
        const recordingContext = new Context({
          tools: [],
          config,
          browserContextFactory: mockBrowserContextFactory,
          sessionLog: () => Promise.resolve(sessionLog),
          clientInfo: {},
        });
        const siblingContext = new Context({
          tools: [],
          config,
          browserContextFactory: mockBrowserContextFactory,
          sessionLog: undefined,
          clientInfo: {},
        });
        const starting = recordingContext.startRecording();
        await vi.advanceTimersByTimeAsync(500);
        await starting;
        await siblingContext.newTab();
        const createPage = (url: string) => Object.assign(new EventEmitter(), {
          setDefaultNavigationTimeout: vi.fn(),
          setDefaultTimeout: vi.fn(),
          url: () => url,
        });
        const page = createPage('about:blank');
        mockBrowserContext.emit('page', page);
        const sink = mockBrowserContext._enableRecorder.mock.calls[0][1];
        const manualAction = { name: 'fill', selector: '#query', text: 'manual' };
        sink.actionAdded(page, manualAction, 'manual fill');

        const endSiblingTool = siblingContext.beginToolCall('browser_fill_form');
        sink.actionAdded(page, { name: 'fill', selector: '#query', text: 'tool' }, 'suppressed fill');
        endSiblingTool();
        await vi.advanceTimersByTimeAsync(501);
        sink.signalAdded(page, { name: 'popup', popupAlias: '1' }, 'late suppressed popup');
        sink.signalAdded(page, { name: 'navigation', url: 'https://tool.example/' }, 'late suppressed navigation');
        const standalonePage = createPage('https://standalone.example/');
        mockBrowserContext.emit('page', standalonePage);
        sink.signalAdded(standalonePage, { name: 'navigation', url: 'https://standalone.example/' }, '');

        const stopping = recordingContext.stopRecording();
        await vi.advanceTimersByTimeAsync(500);
        await expect(stopping).resolves.toEqual(['manual fill']);
        expect(sessionLog.logUserAction).toHaveBeenCalledTimes(2);
        expect(sessionLog.logUserAction).toHaveBeenNthCalledWith(1, manualAction, expect.anything(), 'manual fill', false);
        expect(sessionLog.logUserAction).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ name: 'navigate', url: 'https://standalone.example/' }),
            expect.anything(),
            "await page.goto('https://standalone.example/');",
            false,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('replaces coalesced fills in recordings and session logs', async () => {
      vi.useFakeTimers();
      try {
        mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
        const sessionLog = { logUserAction: vi.fn() };
        const context = new Context({
          tools: [],
          config: { timeouts: {} } as any,
          browserContextFactory: mockBrowserContextFactory,
          sessionLog: () => Promise.resolve(sessionLog),
          clientInfo: {},
        });
        const starting = context.startRecording();
        await vi.advanceTimersByTimeAsync(500);
        await starting;
        const page = new EventEmitter() as any;
        page.setDefaultNavigationTimeout = vi.fn();
        page.setDefaultTimeout = vi.fn();
        page.url = () => 'about:blank';
        mockBrowserContext.emit('page', page);
        const sink = mockBrowserContext._enableRecorder.mock.calls[0][1];
        const initial = { name: 'fill', selector: '#query', text: 'a', signals: [] };
        const updated = { ...initial, text: 'answer' };

        sink.actionAdded(page, initial, "await page.locator('#query').fill('a');");
        sink.actionAdded({} as any, { name: 'press', selector: '#other' }, "await page.locator('#other').press('Enter');");
        sink.actionUpdated(page, updated, "await page.locator('#query').fill('answer');");

        const stopping = context.stopRecording();
        await vi.advanceTimersByTimeAsync(500);
        await expect(stopping).resolves.toEqual([
          "await page.locator('#query').fill('answer');",
          "await page.locator('#other').press('Enter');",
        ]);
        expect(sessionLog.logUserAction).toHaveBeenLastCalledWith(
            updated,
            expect.anything(),
            "await page.locator('#query').fill('answer');",
            true,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not apply an update whose initial action was suppressed', async () => {
      vi.useFakeTimers();
      try {
        mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
        const makeContext = () => new Context({
          tools: [],
          config: { timeouts: {} } as any,
          browserContextFactory: mockBrowserContextFactory,
          sessionLog: undefined,
          clientInfo: {},
        });
        const recordingContext = makeContext();
        const siblingContext = makeContext();
        await recordingContext.startRecording();
        await siblingContext.newTab();
        const sink = mockBrowserContext._enableRecorder.mock.calls[0][1];
        const page = {} as any;
        sink.actionAdded(page, { name: 'fill', selector: '#query' }, 'manual fill');

        const endSiblingTool = siblingContext.beginToolCall('browser_fill_form');
        sink.actionAdded(page, { name: 'fill', selector: '#query' }, 'suppressed fill');
        endSiblingTool();
        await vi.advanceTimersByTimeAsync(501);
        sink.actionUpdated(page, { name: 'fill', selector: '#query' }, 'late suppressed update');

        const stopping = recordingContext.stopRecording();
        await vi.advanceTimersByTimeAsync(500);
        await expect(stopping).resolves.toEqual(['manual fill']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('starts a fresh recording after stop', async () => {
      mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
      const context = new Context({
        tools: [],
        config: { timeouts: {} } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });
      await context.startRecording();
      const sink = mockBrowserContext._enableRecorder.mock.calls[0][1];
      const page = {} as any;
      sink.actionAdded(page, { action: { name: 'click' } }, 'old code');

      expect(await context.stopRecording()).toEqual(['old code']);

      await context.startRecording();
      sink.actionAdded({} as any, { action: { name: 'fill' } }, 'new code');
      expect(await context.stopRecording()).toEqual(['new code']);
      expect(mockBrowserContext._enableRecorder).toHaveBeenCalledTimes(2);
    });

    it('returns captured actions when recorder standby fails', async () => {
      mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
      mockBrowserContext._disableRecorder = vi.fn().mockRejectedValue(new Error('browser disconnected'));
      const context = new Context({
        tools: [],
        config: { timeouts: {} } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });
      await context.startRecording();
      const sink = mockBrowserContext._enableRecorder.mock.calls[0][1];
      sink.actionAdded({} as any, { name: 'press', signals: [] }, "await page.press('Enter');");

      await expect(context.stopRecording()).resolves.toEqual(["await page.press('Enter');"]);
    });

    it('re-arms an idle hub when a session logger joins', async () => {
      mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
      const recordingContext = new Context({
        tools: [],
        config: { timeouts: {} } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });
      await recordingContext.startRecording();
      await recordingContext.stopRecording();
      expect(mockBrowserContext._disableRecorder).toHaveBeenCalledTimes(1);

      const loggingContext = new Context({
        tools: [],
        config: { timeouts: {} } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: () => Promise.resolve({ logUserAction: vi.fn() } as any),
        clientInfo: {},
      });
      await loggingContext.newTab();
      expect(mockBrowserContext._enableRecorder).toHaveBeenCalledTimes(2);
    });

    it('re-arms only after an idle recorder has reached standby', async () => {
      vi.useFakeTimers();
      try {
        let finishStandby: () => void;
        mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
        mockBrowserContext._disableRecorder = vi.fn().mockImplementation(() => new Promise<void>(resolve => { finishStandby = resolve; }));
        const context = new Context({
          tools: [],
          config: { timeouts: {} } as any,
          browserContextFactory: mockBrowserContextFactory,
          sessionLog: undefined,
          clientInfo: {},
        });
        await context.startRecording();
        const firstStop = context.stopRecording();
        await vi.advanceTimersByTimeAsync(500);
        expect(mockBrowserContext._disableRecorder).toHaveBeenCalledTimes(1);

        const secondStart = context.startRecording();
        await vi.advanceTimersByTimeAsync(500);
        expect(mockBrowserContext._enableRecorder).toHaveBeenCalledTimes(1);
        finishStandby!();
        await firstStop;
        await secondStart;
        expect(mockBrowserContext._enableRecorder).toHaveBeenCalledTimes(2);

        const secondStop = context.stopRecording();
        finishStandby = () => {};
        mockBrowserContext._disableRecorder.mockResolvedValue(undefined);
        await vi.advanceTimersByTimeAsync(500);
        await secondStop;
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps page declarations when recording starts before or after a tab opens', async () => {
      vi.useFakeTimers();
      try {
        mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
        const context = new Context({
          tools: [],
          config: { timeouts: {} } as any,
          browserContextFactory: mockBrowserContextFactory,
          sessionLog: undefined,
          clientInfo: {},
        });
        await context.startRecording();
        const sink = mockBrowserContext._enableRecorder.mock.calls[0][1];
        const firstPage = {} as any;
        const secondPage = {} as any;
        mockBrowserContext.pages.mockReturnValue([firstPage, secondPage]);
        sink.actionAdded(firstPage, { name: 'click', signals: [] }, "await page.getByText('page1.example').click();");
        sink.actionAdded(secondPage, { name: 'openPage', signals: [], url: 'about:blank' }, 'const page1 = await context.newPage();');
        sink.actionAdded(secondPage, { name: 'click', signals: [] }, "await page1.getByText('Next').click();");

        let stopping = context.stopRecording();
        await vi.advanceTimersByTimeAsync(500);
        await expect(stopping).resolves.toEqual([
          "await page.getByText('page1.example').click();",
          'const page1 = await context.newPage();',
          "await page1.getByText('Next').click();",
        ]);

        const starting = context.startRecording();
        await vi.advanceTimersByTimeAsync(500);
        await starting;
        sink.actionAdded(firstPage, { name: 'closePage', signals: [] }, 'await page.close();');
        mockBrowserContext.pages.mockReturnValue([secondPage]);
        sink.actionAdded(secondPage, { name: 'assertTitle', signals: [] }, "await expect(page1).toHaveTitle('Still here');");

        stopping = context.stopRecording();
        await vi.advanceTimersByTimeAsync(500);
        await expect(stopping).resolves.toEqual([
          'const page1 = context.pages()[1];',
          'await page.close();',
          "const { expect } = require('playwright/test');",
          "await expect(page1).toHaveTitle('Still here');",
        ]);

        const thirdPage = {} as any;
        const restarting = context.startRecording();
        await vi.advanceTimersByTimeAsync(500);
        await restarting;
        mockBrowserContext.pages.mockReturnValue([firstPage, thirdPage]);
        sink.actionAdded(thirdPage, { name: 'click', signals: [] }, "await page2.getByText('const page2 = ').click();");

        stopping = context.stopRecording();
        await vi.advanceTimersByTimeAsync(500);
        await expect(stopping).resolves.toEqual([
          'const page2 = context.pages()[1];',
          "await page2.getByText('const page2 = ').click();",
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('ignores empty signal code from an earlier tab', async () => {
      vi.useFakeTimers();
      try {
        mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
        const context = new Context({
          tools: [],
          config: { timeouts: {} } as any,
          browserContextFactory: mockBrowserContextFactory,
          sessionLog: undefined,
          clientInfo: {},
        });
        await context.startRecording();
        const sink = mockBrowserContext._enableRecorder.mock.calls[0][1];
        const firstPage = {} as any;
        const secondPage = {} as any;
        sink.actionAdded(firstPage, { name: 'click', signals: [] }, 'first action');
        sink.actionAdded(secondPage, { name: 'click', signals: [] }, 'second action');
        sink.signalAdded(firstPage, { name: 'popup', popupAlias: '1' }, '');

        const stopping = context.stopRecording();
        await vi.advanceTimersByTimeAsync(500);
        await expect(stopping).resolves.toEqual(['first action', 'second action']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not include an action buffered before a repeated start', async () => {
      vi.useFakeTimers();
      try {
        mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
        const context = new Context({
          tools: [],
          config: { timeouts: {} } as any,
          browserContextFactory: mockBrowserContextFactory,
          sessionLog: undefined,
          clientInfo: {},
        });
        await context.startRecording();
        let stopping = context.stopRecording();
        await vi.advanceTimersByTimeAsync(500);
        await stopping;

        const sink = mockBrowserContext._enableRecorder.mock.calls[0][1];
        const starting = context.startRecording();
        await vi.advanceTimersByTimeAsync(499);
        sink.actionAdded({} as any, { action: { name: 'click' } }, 'before start');
        await vi.advanceTimersByTimeAsync(1);
        await starting;
        sink.actionAdded({} as any, { action: { name: 'click' } }, 'after start');

        stopping = context.stopRecording();
        await vi.advanceTimersByTimeAsync(500);
        await expect(stopping).resolves.toEqual(['after start']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps a last-tab close action until recording is stopped', async () => {
      vi.useFakeTimers();
      try {
        const page = new EventEmitter() as any;
        page.setDefaultNavigationTimeout = vi.fn();
        page.setDefaultTimeout = vi.fn();
        page.url = () => 'about:blank';
        mockBrowserContext.pages.mockReturnValue([page]);
        mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
        const close = vi.fn().mockResolvedValue(undefined);
        (mockBrowserContextFactory.createContext as any).mockResolvedValue({ browserContext: mockBrowserContext, close });
        const context = new Context({
          tools: [],
          config: { timeouts: {} } as any,
          browserContextFactory: mockBrowserContextFactory,
          sessionLog: undefined,
          clientInfo: {},
        });
        await context.startRecording();
        const sink = mockBrowserContext._enableRecorder.mock.calls[0][1];

        const stopping = context.stopRecording();
        page.emit('close');
        await vi.advanceTimersByTimeAsync(0);
        sink.actionAdded(page, { action: { name: 'closePage' } }, 'await page.close();');
        expect(close).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(500);
        await expect(stopping).resolves.toEqual(['await page.close();']);
        await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
      } finally {
        vi.useRealTimers();
      }
    });

    it('waits for an in-flight recording stop before closing the browser', async () => {
      vi.useFakeTimers();
      try {
        mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
        const close = vi.fn().mockResolvedValue(undefined);
        (mockBrowserContextFactory.createContext as any).mockResolvedValue({ browserContext: mockBrowserContext, close });
        const context = new Context({
          tools: [],
          config: { timeouts: {} } as any,
          browserContextFactory: mockBrowserContextFactory,
          sessionLog: undefined,
          clientInfo: {},
        });
        await context.startRecording();
        const sink = mockBrowserContext._enableRecorder.mock.calls[0][1];

        const stopping = context.stopRecording();
        const closing = context.closeBrowserContext();
        await vi.advanceTimersByTimeAsync(499);
        sink.actionAdded({} as any, { action: { name: 'click', button: 'left' } }, 'last action');
        expect(close).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        await expect(stopping).resolves.toEqual(['last action']);
        await closing;
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('closes a last-tab context when recorder startup fails', async () => {
      const page = new EventEmitter() as any;
      page.setDefaultNavigationTimeout = vi.fn();
      page.setDefaultTimeout = vi.fn();
      page.url = () => 'about:blank';
      mockBrowserContext.pages.mockReturnValue([page]);
      let rejectEnable: (error: Error) => void;
      mockBrowserContext._enableRecorder = vi.fn().mockImplementation(() => new Promise((_, reject) => { rejectEnable = reject; }));
      const close = vi.fn().mockResolvedValue(undefined);
      (mockBrowserContextFactory.createContext as any).mockResolvedValue({ browserContext: mockBrowserContext, close });
      const context = new Context({
        tools: [],
        config: { timeouts: {} } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });

      const starting = context.startRecording();
      await vi.waitFor(() => expect(mockBrowserContext._enableRecorder).toHaveBeenCalledTimes(1));
      page.emit('close');
      rejectEnable!(new Error('recorder unavailable'));

      await expect(starting).rejects.toThrow('recorder unavailable');
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    });

    it('rejects a second recording while one is active', async () => {
      mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
      const context = new Context({
        tools: [],
        config: { timeouts: {} } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });
      await context.startRecording();

      await expect(context.startRecording()).rejects.toThrow('Recording is already in progress');
    });

    it('reserves a focused start and lets an overlapping stop wait for it', async () => {
      vi.useFakeTimers();
      try {
        mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
        const context = new Context({
          tools: [],
          config: { timeouts: {} } as any,
          browserContextFactory: mockBrowserContextFactory,
          sessionLog: undefined,
          clientInfo: {},
        });
        let releaseTab: () => void;
        const tabReady = new Promise<void>(resolve => releaseTab = resolve);
        const bringToFront = vi.fn().mockResolvedValue(undefined);
        vi.spyOn(context, 'ensureTab').mockImplementation(async () => {
          await tabReady;
          return { page: { bringToFront } } as any;
        });

        const first = context.startRecordingOnCurrentTab();
        await expect(context.startRecordingOnCurrentTab()).rejects.toThrow('Recording is already in progress');
        const stopping = context.stopRecording();
        expect(context.ensureTab).toHaveBeenCalledTimes(1);

        releaseTab!();
        await first;
        await vi.advanceTimersByTimeAsync(500);
        await expect(stopping).resolves.toEqual([]);
        expect(bringToFront).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('releases a focused start reservation when tab focus fails', async () => {
      mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
      const context = new Context({
        tools: [],
        config: { timeouts: {} } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });
      vi.spyOn(context, 'ensureTab')
          .mockResolvedValueOnce({ page: { bringToFront: vi.fn().mockRejectedValue(new Error('page closed')) } } as any)
          .mockResolvedValueOnce({ page: { bringToFront: vi.fn().mockResolvedValue(undefined) } } as any);

      const starting = context.startRecordingOnCurrentTab();
      const stopping = context.stopRecording();
      await expect(starting).rejects.toThrow('page closed');
      await expect(stopping).resolves.toBeUndefined();
      await expect(context.startRecordingOnCurrentTab()).resolves.toBeUndefined();
    });

    it('waits for Playwright to deliver its last buffered action', async () => {
      vi.useFakeTimers();
      try {
        mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
        const context = new Context({
          tools: [],
          config: { timeouts: {} } as any,
          browserContextFactory: mockBrowserContextFactory,
          sessionLog: undefined,
          clientInfo: {},
        });
        await context.startRecording();
        const sink = mockBrowserContext._enableRecorder.mock.calls[0][1];

        const stopping = context.stopRecording();
        sink.actionAdded({} as any, { action: { name: 'press' } }, 'after stop');
        await vi.advanceTimersByTimeAsync(499);
        sink.actionAdded({} as any, { action: { name: 'click', button: 'left' } }, 'last action');
        await vi.advanceTimersByTimeAsync(1);

        await expect(stopping).resolves.toEqual(['last action']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not let an in-flight stop remove a replacement recording', async () => {
      vi.useFakeTimers();
      try {
        let resolveEnable: () => void;
        mockBrowserContext._enableRecorder = vi.fn()
            .mockImplementationOnce(() => new Promise<void>(resolve => { resolveEnable = resolve; }))
            .mockResolvedValue(undefined);
        const context = new Context({
          tools: [],
          config: { timeouts: {} } as any,
          browserContextFactory: mockBrowserContextFactory,
          sessionLog: undefined,
          clientInfo: {},
        });

        const firstStart = context.startRecording();
        await vi.advanceTimersByTimeAsync(0);
        const firstStop = context.stopRecording();
        const secondStart = context.startRecording();
        resolveEnable!();
        await firstStart;
        await vi.advanceTimersByTimeAsync(500);
        await secondStart;
        await firstStop;

        const sink = mockBrowserContext._enableRecorder.mock.calls[0][1];
        sink.actionAdded({} as any, { action: { name: 'click' } }, 'replacement action');
        const secondStop = context.stopRecording();
        await vi.advanceTimersByTimeAsync(500);
        await expect(secondStop).resolves.toEqual(['replacement action']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('requires a browser session for recording in a stateless default context', async () => {
      const context = new Context({
        tools: [],
        config: { timeouts: {} } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
        browserSession: true,
      });

      await expect(context.startRecording()).rejects.toThrow(/browserSessionId/);
      await expect(context.stopRecording()).rejects.toThrow(/browserSessionId/);
      expect(mockBrowserContextFactory.createContext).not.toHaveBeenCalled();
    });

    it('makes a joining session wait for the in-flight recorder enablement and share its failure', async () => {
      // The first session stores the hub before _enableRecorder resolves; a
      // session joining meanwhile must not report recording ready while the
      // one enablement is still in flight — and must fail with it, not run
      // unrecorded.
      let rejectEnable: (error: Error) => void;
      mockBrowserContext._enableRecorder = vi.fn().mockImplementation(() => new Promise((_, reject) => { rejectEnable = reject; }));
      const makeContext = () => new Context({
        tools: [],
        config: { timeouts: {} } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: async () => ({ logUserAction: vi.fn() }) as any,
        clientInfo: {},
      });
      const pending1 = makeContext().newTab();
      const pending2 = makeContext().newTab();

      await vi.waitFor(() => expect(mockBrowserContext._enableRecorder).toHaveBeenCalledTimes(1));
      rejectEnable!(new Error('recorder unavailable'));

      await expect(pending1).rejects.toThrow('recorder unavailable');
      await expect(pending2).rejects.toThrow('recorder unavailable');
    });

    it('retries recorder enablement after a failed one instead of caching the dead hub', async () => {
      // A failed _enableRecorder left the hub cached: every later session
      // skipped enablement and silently produced no user-action recording.
      mockBrowserContext._enableRecorder = vi.fn()
          .mockRejectedValueOnce(new Error('recorder unavailable'))
          .mockResolvedValueOnce(undefined);
      const makeContext = () => new Context({
        tools: [],
        config: { timeouts: {} } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: async () => ({ logUserAction: vi.fn() }) as any,
        clientInfo: {},
      });
      await expect(makeContext().newTab()).rejects.toThrow('recorder unavailable');

      await makeContext().newTab();

      expect(mockBrowserContext._enableRecorder).toHaveBeenCalledTimes(2);
    });
  });

  describe('ensureTab after its owner gives up', () => {
    const createContext = () => new Context({
      tools: [],
      config: defaultConfig,
      browserContextFactory: mockBrowserContextFactory,
      sessionLog: undefined,
      clientInfo: {},
    });

    it('does not open a page for a caller cancelled during attachment', async () => {
      const attached = Promise.withResolvers<{ browserContext: any, close: () => Promise<void> }>();
      vi.mocked(mockBrowserContextFactory.createContext).mockReturnValue(attached.promise);
      const context = createContext();
      const controller = new AbortController();
      const pending = context.ensureTab(controller.signal);
      controller.abort(new Error('listing cancelled'));
      attached.resolve({ browserContext: mockBrowserContext, close: vi.fn().mockResolvedValue(undefined) });
      await expect(pending).rejects.toThrow('listing cancelled');
      expect(mockBrowserContext.newPage).not.toHaveBeenCalled();
    });

    it('does not open a page once disposal began during attachment', async () => {
      const attached = Promise.withResolvers<{ browserContext: any, close: () => Promise<void> }>();
      const close = vi.fn().mockResolvedValue(undefined);
      vi.mocked(mockBrowserContextFactory.createContext).mockReturnValue(attached.promise);
      const context = createContext();
      const pending = context.ensureTab();
      const disposed = context.dispose();
      attached.resolve({ browserContext: mockBrowserContext, close });
      await expect(pending).rejects.toThrow('closed while a tab was being opened');
      await disposed;
      expect(mockBrowserContext.newPage).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('closes a page that finishes opening after disposal began, before releasing the browser', async () => {
      const opened = Promise.withResolvers<{ close: () => Promise<void> }>();
      const close = vi.fn().mockResolvedValue(undefined);
      mockBrowserContext.newPage = vi.fn(() => opened.promise);
      vi.mocked(mockBrowserContextFactory.createContext).mockResolvedValue({ browserContext: mockBrowserContext, close });
      const context = createContext();
      const pending = context.ensureTab();
      await vi.waitFor(() => expect(mockBrowserContext.newPage).toHaveBeenCalled());
      const disposed = context.dispose();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(close).not.toHaveBeenCalled();
      const page = { close: vi.fn().mockResolvedValue(undefined) };
      opened.resolve(page);
      await expect(pending).rejects.toThrow('closed while a tab was being opened');
      await disposed;
      expect(page.close).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(page.close.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
    });
  });

  describe('idle timeout', () => {
    const close = vi.fn<() => Promise<void>>();

    beforeEach(() => {
      vi.useFakeTimers();
      close.mockReset().mockResolvedValue(undefined);
      vi.mocked(mockBrowserContextFactory.createContext).mockResolvedValue({ browserContext: mockBrowserContext, close });
    });

    afterEach(() => vi.useRealTimers());

    const createContext = async (idle = 1000, browserSession = false) => new Context({
      tools: [],
      config: await resolveConfig({ timeouts: { idle } }),
      browserContextFactory: mockBrowserContextFactory,
      sessionLog: undefined,
      clientInfo: {},
      browserSession,
    });

    it.each([[0, false], [1000, true]])('leaves disabled defaults and explicit sessions open (idle=%s, session=%s)', async (idle, browserSession) => {
      const context = await createContext(Number(idle), Boolean(browserSession));
      await context.ensureTab();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(close).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps shared clients alive through overlapping tools and waits one idle window after the final completion', async () => {
      const first = await createContext();
      const second = await createContext();
      await first.ensureTab();
      await second.ensureTab();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(900);
      const endFirst = second.beginToolCall('browser_click');
      const endSecond = second.beginToolCall('browser_click');
      await vi.advanceTimersByTimeAsync(10_000);
      endSecond();
      endSecond();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(close).not.toHaveBeenCalled();
      endFirst();
      await vi.advanceTimersByTimeAsync(999);
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(close).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      expect(mockBrowserContext.listenerCount('page')).toBe(0);
    });

    it('holds idle cleanup until downloads finish and resets the idle window afterward', async () => {
      const context = await createContext();
      await context.ensureTab();
      const download = Promise.withResolvers<void>();
      context.trackPendingDownload(download.promise);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(close).not.toHaveBeenCalled();
      download.resolve();
      await vi.advanceTimersByTimeAsync(999);
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(close).toHaveBeenCalledOnce();
    });

    it('waits for idle cleanup before reopening and returns the navigation notice once', async () => {
      const context = await createContext();
      const cleanup = Promise.withResolvers<void>();
      close.mockReturnValueOnce(cleanup.promise);
      await context.ensureTab();
      await vi.advanceTimersByTimeAsync(1000);
      expect(close).toHaveBeenCalledOnce();
      const endTool = context.beginToolCall('browser_snapshot');
      const resume = context.resumeAfterIdle();
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockBrowserContextFactory.createContext).toHaveBeenCalledOnce();
      cleanup.resolve();
      await expect(resume).resolves.toContain('Use browser_navigate');
      expect(mockBrowserContextFactory.createContext).toHaveBeenCalledTimes(2);
      await expect(context.resumeAfterIdle()).resolves.toBeUndefined();
      endTool();
      await context.dispose();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not release a shared context with a disabled sibling and rearms when that sibling leaves', async () => {
      const first = await createContext();
      const second = await createContext(0);
      await first.ensureTab();
      await second.ensureTab();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(close).not.toHaveBeenCalled();
      await second.dispose();
      await vi.advanceTimersByTimeAsync(0);
      expect(close).toHaveBeenCalledTimes(2);
    });

    it('waits for every shared client cleanup before resuming or attaching a new client', async () => {
      const first = await createContext();
      const second = await createContext();
      const newcomer = await createContext();
      await first.ensureTab();
      await second.ensureTab();
      const siblingCleanup = Promise.withResolvers<void>();
      close.mockResolvedValueOnce(undefined).mockReturnValueOnce(siblingCleanup.promise);
      await vi.advanceTimersByTimeAsync(1000);
      const endFirst = first.beginToolCall('browser_snapshot');
      const endNewcomer = newcomer.beginToolCall('browser_navigate');
      const resumed = first.resumeAfterIdle();
      const attached = newcomer.ensureTab();
      await vi.advanceTimersByTimeAsync(0);
      // The new acquisition releases its lease, then both callers wait for
      // the sibling's cleanup instead of reviving the closing context.
      expect(close).toHaveBeenCalledTimes(3);
      expect(mockBrowserContextFactory.createContext).toHaveBeenCalledTimes(3);
      expect(mockBrowserContext.listenerCount('page')).toBe(0);
      siblingCleanup.resolve();
      await Promise.all([resumed, attached]);
      expect(mockBrowserContextFactory.createContext).toHaveBeenCalledTimes(5);
      expect(mockBrowserContext.listenerCount('page')).toBe(2);
      endFirst();
      endNewcomer();
    });

    it('allows retry after a failed idle relaunch without leaking a timer', async () => {
      const context = await createContext();
      await context.ensureTab();
      await vi.advanceTimersByTimeAsync(1000);
      vi.mocked(mockBrowserContextFactory.createContext).mockRejectedValueOnce(new Error('launch failed'));
      await expect(context.resumeAfterIdle()).rejects.toThrow('launch failed');
      expect(vi.getTimerCount()).toBe(0);
      await expect(context.resumeAfterIdle()).resolves.toContain('Use browser_navigate');
      expect(mockBrowserContextFactory.createContext).toHaveBeenCalledTimes(3);
    });

    it('holds the shared group while a new client is still setting up its context', async () => {
      const first = await createContext();
      await first.ensureTab();
      const sessionLog = Promise.withResolvers<undefined>();
      const newcomer = new Context({
        tools: [],
        config: first.config,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: () => sessionLog.promise,
        clientInfo: {},
      });
      const endTool = newcomer.beginToolCall('browser_navigate');
      const setup = newcomer.ensureTab();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(close).not.toHaveBeenCalled();
      sessionLog.resolve(undefined);
      await setup;
      endTool();
      await vi.advanceTimersByTimeAsync(1000);
      expect(close).toHaveBeenCalledTimes(2);
    });

    it('keeps explicit recordings alive and rearms after the recorder stops', async () => {
      mockBrowserContext._enableRecorder = vi.fn().mockResolvedValue(undefined);
      const context = await createContext();
      await context.startRecording();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(close).not.toHaveBeenCalled();
      const stopping = context.stopRecording();
      await vi.advanceTimersByTimeAsync(499);
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(mockBrowserContext._disableRecorder).toHaveBeenCalledOnce();
      expect(context.recordingActivityAt()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(999);
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('explicit close waits for idle cleanup and clears the relaunch notice', async () => {
      const context = await createContext();
      const cleanup = Promise.withResolvers<void>();
      close.mockReturnValueOnce(cleanup.promise);
      await context.ensureTab();
      await vi.advanceTimersByTimeAsync(1000);
      const explicitClose = context.closeBrowserContext();
      cleanup.resolve();
      await explicitClose;
      await expect(context.resumeAfterIdle()).resolves.toBeUndefined();
      expect(mockBrowserContextFactory.createContext).toHaveBeenCalledOnce();
    });

    it('finalizes the trace once before releasing shared clients', async () => {
      const config = await resolveConfig({ timeouts: { idle: 1000 }, saveTrace: true });
      const contexts = [0, 1].map(() => new Context({ tools: [], config, browserContextFactory: mockBrowserContextFactory, sessionLog: undefined, clientInfo: {} }));
      for (const context of contexts)
        await context.ensureTab();
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockBrowserContext.tracing.stop).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledTimes(2);
    });
  });

  describe('isRunningTool', () => {
    it('should return false initially', () => {
      const context = new Context({
        tools: [],
        config: defaultConfig,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });

      expect(context.isRunningTool()).toBe(false);
    });

    it('should return true when tool is running', () => {
      const context = new Context({
        tools: [],
        config: defaultConfig,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });

      context.beginToolCall('test_tool');
      expect(context.isRunningTool()).toBe(true);
    });

    it('should return false after tool completes', () => {
      const context = new Context({
        tools: [],
        config: defaultConfig,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });

      const endToolCall = context.beginToolCall('test_tool');
      endToolCall();
      expect(context.isRunningTool()).toBe(false);
    });

    it('stays running until every overlapping call has released', () => {
      // A single running-tool slot let the first finisher clear the marker
      // while a second call still ran — the TTL reaper could then dispose the
      // session's browser mid-operation.
      const context = new Context({
        tools: [],
        config: defaultConfig,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });

      const endFirst = context.beginToolCall('browser_click');
      const endSecond = context.beginToolCall('browser_click');
      endFirst();
      expect(context.isRunningTool()).toBe(true);
      // Releasing one call twice must not release its sibling.
      endFirst();
      expect(context.isRunningTool()).toBe(true);
      endSecond();
      expect(context.isRunningTool()).toBe(false);
    });

    it('holds a session without suppressing input recording', () => {
      const context = new Context({
        tools: [],
        config: defaultConfig,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });

      const endList = context.beginSessionHold();
      const endOtherList = context.beginSessionHold();
      expect(context.isRunningTool()).toBe(true);
      expect(context.isRunningToolForRecording(true)).toBe(false);
      endList();
      endList();
      expect(context.isRunningTool()).toBe(true);
      endOtherList();
      expect(context.isRunningTool()).toBe(false);
      expect(context.isRunningToolForRecording(true)).toBe(false);
    });
  });
});
