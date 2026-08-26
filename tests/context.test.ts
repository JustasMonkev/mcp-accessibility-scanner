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
        config: {} as any,
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
        config: {} as any,
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
        config: {} as any,
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
        config: {} as any,
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
        config: { saveTrace: true } as any,
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
        config: { saveTrace: true } as any,
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
        config: { saveTrace: true } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });
      const second = new Context({
        tools: [],
        config: { saveTrace: true } as any,
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
        config: { saveTrace: true } as any,
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
        config: { saveTrace: true } as any,
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
        config: {} as any,
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
          config: {} as any,
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
        config: {} as any,
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
        config: {} as any,
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
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });
      context.trackPendingDownload(Promise.reject(new Error('canceled')));
      // The tracked rejection settles handled; the set drains.
      await new Promise(resolve => setImmediate(resolve));
      expect(context.hasPendingDownloads()).toBe(false);
      await context.dispose();
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

  describe('isRunningTool', () => {
    it('should return false initially', () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: {},
      });

      expect(context.isRunningTool()).toBe(false);
    });

    it('should return true when tool is running', () => {
      const context = new Context({
        tools: [],
        config: {} as any,
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
        config: {} as any,
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
        config: {} as any,
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
  });
});
