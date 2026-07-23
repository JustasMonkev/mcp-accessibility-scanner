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
import { Tab, renderModalStates } from '../src/tab.js';
import type { Context } from '../src/context.js';
import { EventEmitter } from 'events';

describe('Tab', () => {
  let mockContext: Context;
  let mockPage: any;
  let onPageClose: any;

  beforeEach(() => {
    mockPage = new EventEmitter();
    mockPage.url = vi.fn().mockReturnValue('https://example.com');
    mockPage.title = vi.fn().mockResolvedValue('Example Page');
    mockPage.mainFrame = vi.fn().mockReturnValue('main-frame');
    mockPage.waitForTimeout = vi.fn().mockResolvedValue(undefined);
    mockPage._wrapApiCall = vi.fn(async (callback: () => Promise<unknown>) => await callback());
    mockPage.setDefaultNavigationTimeout = vi.fn();
    mockPage.setDefaultTimeout = vi.fn();
    mockPage.goBack = vi.fn().mockResolvedValue(null);
    mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button "Submit" [ref=1]');
    mockPage.locator = vi.fn().mockReturnValue({
      describe: vi.fn().mockReturnValue({}),
    });

    mockContext = {
      config: {
        timeouts: {
          navigationTimeout: 30000,
          defaultTimeout: 6000,
        },
      },
      currentTab: vi.fn(),
      outputFile: vi.fn().mockResolvedValue('/tmp/download'),
      tools: [],
    } as any;

    onPageClose = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should create a tab with page and context', () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      expect(tab.context).toBe(mockContext);
      expect(tab.page).toBe(mockPage);
    });

    it('should set default timeouts', () => {
      new Tab(mockContext, mockPage as any, onPageClose);
      expect(mockPage.setDefaultNavigationTimeout).toHaveBeenCalledWith(30000);
      expect(mockPage.setDefaultTimeout).toHaveBeenCalledWith(6000);
    });

    it('should listen to console events', () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      const consoleMessage = {
        type: () => 'log',
        text: () => 'Test message',
        location: () => ({ url: 'test.js', lineNumber: 10 }),
      };
      mockPage.emit('console', consoleMessage);
      expect(tab.consoleMessages()).toHaveLength(1);
    });

    it('should listen to page error events', () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      const error = new Error('Test error');
      mockPage.emit('pageerror', error);
      expect(tab.consoleMessages()).toHaveLength(1);
    });
  });

  describe('forPage', () => {
    it('should retrieve tab for page', () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      expect(Tab.forPage(mockPage as any)).toBe(tab);
    });

    it('should return undefined for unknown page', () => {
      const otherPage = {} as any;
      expect(Tab.forPage(otherPage)).toBeUndefined();
    });
  });

  describe('modalStates', () => {
    it('should return empty array initially', () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      expect(tab.modalStates()).toEqual([]);
    });

    it('should add modal state', () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      const modalState = {
        type: 'dialog' as const,
        description: 'Test dialog',
        dialog: {} as any,
      };
      tab.setModalState(modalState);
      expect(tab.modalStates()).toContain(modalState);
    });

    it('should clear modal state', () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      const modalState = {
        type: 'dialog' as const,
        description: 'Test dialog',
        dialog: {} as any,
      };
      tab.setModalState(modalState);
      tab.clearModalState(modalState);
      expect(tab.modalStates()).toEqual([]);
    });
  });

  describe('isCurrentTab', () => {
    it('should return true when tab is current', () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      mockContext.currentTab = vi.fn().mockReturnValue(tab);
      expect(tab.isCurrentTab()).toBe(true);
    });

    it('should return false when tab is not current', () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      const otherTab = {} as any;
      mockContext.currentTab = vi.fn().mockReturnValue(otherTab);
      expect(tab.isCurrentTab()).toBe(false);
    });
  });

  describe('updateTitle', () => {
    it('stops waiting when the page title never resolves', async () => {
      vi.useFakeTimers();
      mockContext.config.timeouts.defaultTimeout = 25;
      mockPage.title = vi.fn().mockReturnValue(new Promise(() => {}));
      const tab = new Tab(mockContext, mockPage as any, onPageClose);

      const updatePromise = tab.updateTitle();
      await vi.advanceTimersByTimeAsync(25);

      await expect(updatePromise).resolves.toBeUndefined();
      expect(tab.lastTitle()).toBe('about:blank');
    });

    it('caps unresponsive title refreshes at five seconds', async () => {
      vi.useFakeTimers();
      mockContext.config.timeouts.defaultTimeout = 30_000;
      mockPage.title = vi.fn().mockReturnValue(new Promise(() => {}));
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      let finished = false;

      const updatePromise = tab.updateTitle().then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(finished).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(finished).toBe(true);
      await updatePromise;
      expect(tab.lastTitle()).toBe('about:blank');
    });

    it('uses the runtime default timeout when it changes after tab creation', async () => {
      vi.useFakeTimers();
      mockContext.config.timeouts.defaultTimeout = 25;
      mockPage.title = vi.fn().mockReturnValue(new Promise(() => {}));
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      let finished = false;

      tab.setDefaultTimeout(75);
      const updatePromise = tab.updateTitle().then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(25);

      expect(finished).toBe(false);

      await vi.advanceTimersByTimeAsync(50);
      await updatePromise;

      expect(finished).toBe(true);
      expect(mockPage.setDefaultTimeout).toHaveBeenLastCalledWith(75);
    });
  });

  describe('navigate', () => {
    it('does not wait for a download after an unrelated aborted navigation', async () => {
      mockPage.goto = vi.fn().mockRejectedValue(new Error('page.goto: net::ERR_ABORTED'));
      mockPage.waitForEvent = vi.fn().mockReturnValue(new Promise(() => {}));
      const tab = new Tab(mockContext, mockPage as any, onPageClose);

      await expect(tab.navigate('chrome://crash')).rejects.toThrow('net::ERR_ABORTED');
    });

    it('waits for an explicitly reported download', async () => {
      const download = {
        suggestedFilename: vi.fn().mockReturnValue('download.txt'),
        saveAs: vi.fn().mockResolvedValue(undefined),
      };
      mockPage.goto = vi.fn(async () => {
        mockPage.emit('download', download);
        throw new Error('Download is starting');
      });
      const tab = new Tab(mockContext, mockPage as any, onPageClose);

      await expect(tab.navigate('https://example.com/download')).resolves.toBeUndefined();
      expect(download.saveAs).toHaveBeenCalledWith('/tmp/download');
      expect(mockPage.listenerCount('download')).toBe(1);
    });

    it('rethrows when an explicitly reported download never arrives', async () => {
      vi.useFakeTimers();
      mockPage.goto = vi.fn().mockRejectedValue(new Error('Download is starting'));
      const tab = new Tab(mockContext, mockPage as any, onPageClose);

      const result = expect(tab.navigate('https://example.com/download')).rejects.toThrow('Download is starting');
      await vi.advanceTimersByTimeAsync(6000);
      await result;
      expect(mockPage.listenerCount('download')).toBe(1);
    });
  });

  describe('captureSnapshot', () => {
    it('should capture page snapshot', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      const snapshot = await tab.captureSnapshot();
      expect(snapshot.url).toBe('https://example.com');
      expect(snapshot.title).toBe('Example Page');
      expect(snapshot.ariaSnapshot).toBe('button "Submit" [ref=1]');
      expect(mockPage.ariaSnapshot).toHaveBeenCalledWith({ mode: 'ai' });
    });

    it('should include console messages in snapshot', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      mockPage.emit('console', {
        type: () => 'log',
        text: () => 'Test message',
        location: () => ({ url: 'test.js', lineNumber: 1 }),
      });

      const snapshot = await tab.captureSnapshot();
      expect(snapshot.consoleMessages).toHaveLength(1);
    });

    it('should clear recent console messages after capture', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      mockPage.emit('console', {
        type: () => 'log',
        text: () => 'Test message',
        location: () => ({ url: 'test.js', lineNumber: 1 }),
      });

      await tab.captureSnapshot();
      const snapshot2 = await tab.captureSnapshot();
      expect(snapshot2.consoleMessages).toHaveLength(0);
    });

    it('returns a best-effort snapshot when the page title never resolves', async () => {
      vi.useFakeTimers();
      mockContext.config.timeouts.defaultTimeout = 25;
      mockPage.title = vi.fn().mockReturnValue(new Promise(() => {}));
      const tab = new Tab(mockContext, mockPage as any, onPageClose);

      const snapshotPromise = tab.captureSnapshot();
      await vi.advanceTimersByTimeAsync(25);
      const snapshot = await snapshotPromise;

      expect(snapshot.url).toBe('https://example.com');
      expect(snapshot.title).toBe('about:blank');
      expect(snapshot.ariaSnapshot).toBe('button "Submit" [ref=1]');
    });

    it('returns a best-effort snapshot when the accessibility snapshot never resolves', async () => {
      vi.useFakeTimers();
      mockContext.config.timeouts.defaultTimeout = 25;
      mockPage.ariaSnapshot = vi.fn().mockReturnValue(new Promise(() => {}));
      const tab = new Tab(mockContext, mockPage as any, onPageClose);

      const snapshotPromise = tab.captureSnapshot();
      await vi.advanceTimersByTimeAsync(25);
      const snapshot = await snapshotPromise;

      expect(snapshot.url).toBe('https://example.com');
      expect(snapshot.title).toBe('Example Page');
      expect(snapshot.ariaSnapshot).toContain('Page snapshot unavailable');
      expect(snapshot.ariaSnapshot).toContain('capturing page accessibility snapshot');
    });

    it('keeps data URL payloads in captured accessibility snapshots for session logs', async () => {
      const payload = '<svg viewBox="0 0 10 10"><text>Hello</text></svg>';
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue(`- link "Example" [ref=e1]:\n  - /url: data:image/svg+xml,${payload}`);
      const tab = new Tab(mockContext, mockPage as any, onPageClose);

      const snapshot = await tab.captureSnapshot();

      expect(snapshot.ariaSnapshot).toContain(`data:image/svg+xml,${payload}`);
    });
  });

  describe('refLocator', () => {
    it('should get locator for ref', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      await tab.refLocator({ element: 'Submit button', ref: '1' });
      expect(mockPage.locator).toHaveBeenCalledWith('aria-ref=1');
      expect(mockPage.ariaSnapshot).toHaveBeenCalledWith({ mode: 'ai' });
    });

    it('should throw error if ref not found', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button "Other"');

      await expect(
          tab.refLocator({ element: 'Submit button', ref: '999' })
      ).rejects.toThrow('Ref 999 not found');
      expect(mockPage.ariaSnapshot).toHaveBeenCalledWith({ mode: 'ai' });
    });
  });

  describe('refLocators', () => {
    it('should get multiple locators', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button "Submit" [ref=1] button "Cancel" [ref=2]');

      const locators = await tab.refLocators([
        { element: 'Submit', ref: '1' },
        { element: 'Cancel', ref: '2' },
      ]);

      expect(locators).toHaveLength(2);
      expect(mockPage.locator).toHaveBeenCalledWith('aria-ref=1');
      expect(mockPage.locator).toHaveBeenCalledWith('aria-ref=2');
      expect(mockPage.ariaSnapshot).toHaveBeenCalledWith({ mode: 'ai' });
    });
  });

  describe('consoleMessages', () => {
    it('should track console messages', () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);

      mockPage.emit('console', {
        type: () => 'log',
        text: () => 'Message 1',
        location: () => ({ url: 'test.js', lineNumber: 1 }),
      });

      mockPage.emit('console', {
        type: () => 'error',
        text: () => 'Error message',
        location: () => ({ url: 'test.js', lineNumber: 2 }),
      });

      expect(tab.consoleMessages()).toHaveLength(2);
      expect(tab.consoleMessages()[0].type).toBe('log');
      expect(tab.consoleMessages()[1].type).toBe('error');
    });
  });

  describe('requests', () => {
    it('should track network requests', () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);

      const mockRequest = { url: () => 'https://api.example.com', isNavigationRequest: () => false } as any;
      const mockResponse = { status: () => 200, request: () => mockRequest } as any;

      mockPage.emit('request', mockRequest);
      mockPage.emit('response', mockResponse);

      expect(tab.requests().size).toBe(1);
      expect(tab.requests().get(mockRequest)).toBe(mockResponse);
    });

    it('tracks only the final main-document HTTP status', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      const redirectedRequest = {
        isNavigationRequest: () => true,
        redirectedTo: () => ({}),
      } as any;
      const finalRequest = {
        isNavigationRequest: () => true,
        redirectedTo: () => null,
      } as any;

      mockPage.emit('response', {
        request: () => redirectedRequest,
        frame: () => mockPage.mainFrame(),
        status: () => 302,
        statusText: () => 'Found',
      });
      mockPage.emit('response', {
        request: () => finalRequest,
        frame: () => mockPage.mainFrame(),
        status: () => 402,
        statusText: () => 'Payment Required',
      });

      const snapshot = await tab.captureSnapshot();

      expect(snapshot.mainDocumentStatus).toEqual({ status: 402, statusText: 'Payment Required' });
    });

    it('clears main-document status before history navigation', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      const request = {
        isNavigationRequest: () => true,
        redirectedTo: () => null,
      } as any;

      mockPage.emit('response', {
        request: () => request,
        frame: () => mockPage.mainFrame(),
        status: () => 402,
        statusText: () => 'Payment Required',
      });

      await tab.goBack({ waitUntil: 'commit' });
      const snapshot = await tab.captureSnapshot();

      expect(mockPage.goBack).toHaveBeenCalledWith({ waitUntil: 'commit' });
      expect(snapshot.mainDocumentStatus).toBeUndefined();
    });
  });

  describe('waitForTimeout', () => {
    it('delegates to page.waitForTimeout when JavaScript is not blocked', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      await tab.waitForTimeout(2750);
      expect(mockPage.waitForTimeout).toHaveBeenCalledWith(2750);
    });
  });
});

describe('renderModalStates', () => {
  it('should render empty modal states', () => {
    const mockContext = { tools: [] } as any;
    const result = renderModalStates(mockContext, []);
    const text = result.join('\n');
    expect(text).toContain('### Modal state');
    expect(text).toContain('There is no modal state present');
  });

  it('should render dialog modal state', () => {
    const mockContext = {
      tools: [{
        schema: { name: 'browser_handle_dialog' },
        clearsModalState: 'dialog',
      }],
    } as any;

    const modalStates = [{
      type: 'dialog' as const,
      description: 'Test dialog',
      dialog: {} as any,
    }];

    const result = renderModalStates(mockContext, modalStates);
    const text = result.join('\n');
    expect(text).toContain('Test dialog');
    expect(text).toContain('browser_handle_dialog');
  });
});
