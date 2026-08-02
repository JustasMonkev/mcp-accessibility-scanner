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
  let locatorSnapshot: string | undefined;

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
    locatorSnapshot = 'button "Submit" [ref=1]';
    mockPage.locator = vi.fn().mockReturnValue({
      describe: vi.fn().mockReturnValue({}),
      ariaSnapshot: vi.fn(async () => {
        if (locatorSnapshot === undefined)
          throw new Error('Element not found');
        return locatorSnapshot;
      }),
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

  describe('out-of-band dialog close', () => {
    const makeDialog = (message = 'Hello') => ({
      type: () => 'alert',
      message: () => message,
    }) as any;

    it('sets a dialog modal state when a dialog opens', () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      mockPage.emit('dialog', makeDialog());
      expect(tab.modalStates()).toHaveLength(1);
      expect(tab.modalStates()[0].type).toBe('dialog');
    });

    it('clears the dialog modal state when the dialog closes out of band', () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      const dialog = makeDialog();
      mockPage.emit('dialog', dialog);
      expect(tab.modalStates()).toHaveLength(1);

      mockPage.emit('dialogclosed', dialog);
      expect(tab.modalStates()).toEqual([]);
    });

    it('unblocks snapshots after the dialog closes out of band', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      const dialog = makeDialog();
      mockPage.emit('dialog', dialog);

      const blocked = await tab.captureSnapshot();
      expect(blocked.ariaSnapshot).toBe('');
      expect(blocked.modalStates).toHaveLength(1);

      mockPage.emit('dialogclosed', dialog);

      const unblocked = await tab.captureSnapshot();
      expect(unblocked.ariaSnapshot).toBe('button "Submit" [ref=1]');
      expect(unblocked.modalStates).toEqual([]);
    });

    it('only clears the state of the dialog that actually closed', () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      const first = makeDialog('first');
      const second = makeDialog('second');
      mockPage.emit('dialog', first);
      mockPage.emit('dialog', second);
      expect(tab.modalStates()).toHaveLength(2);

      mockPage.emit('dialogclosed', first);
      expect(tab.modalStates()).toHaveLength(1);
      expect(tab.modalStates()[0].description).toContain('second');
    });

    it('ignores a close event for a dialog it never tracked', () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      const tracked = makeDialog();
      mockPage.emit('dialog', tracked);

      mockPage.emit('dialogclosed', makeDialog('untracked'));
      expect(tab.modalStates()).toHaveLength(1);
    });

    it('leaves non-dialog modal states alone', () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      mockPage.emit('filechooser', {});
      const dialog = makeDialog();
      mockPage.emit('dialog', dialog);

      mockPage.emit('dialogclosed', dialog);
      expect(tab.modalStates()).toHaveLength(1);
      expect(tab.modalStates()[0].type).toBe('fileChooser');
    });

    it('is a no-op when no modal states exist', () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      expect(() => mockPage.emit('dialogclosed', makeDialog())).not.toThrow();
      expect(tab.modalStates()).toEqual([]);
    });

    it('stops listening after dispose', () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      const dialog = makeDialog();
      mockPage.emit('dialog', dialog);
      expect(mockPage.listenerCount('dialogclosed')).toBe(1);

      tab.dispose();
      expect(mockPage.listenerCount('dialogclosed')).toBe(0);

      mockPage.emit('dialogclosed', dialog);
      expect(tab.modalStates()).toHaveLength(1);
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

    it('does not cache an accessibility snapshot that resolves after its timeout', async () => {
      vi.useFakeTimers();
      mockContext.config.timeouts.defaultTimeout = 25;
      let resolveSnapshot!: (snapshot: string) => void;
      mockPage.ariaSnapshot = vi.fn().mockReturnValue(new Promise(resolve => { resolveSnapshot = resolve; }));
      const tab = new Tab(mockContext, mockPage as any, onPageClose);

      const snapshotPromise = tab.captureSnapshot();
      await vi.advanceTimersByTimeAsync(25);
      await snapshotPromise;
      resolveSnapshot('button "Submit" [ref=1]');
      await Promise.resolve();

      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button "Other" [ref=2]');
      await expect(
          tab.refLocators([{ element: 'Submit', ref: '1' }])
      ).rejects.toThrow('Ref 1 not found');
      expect(mockPage.ariaSnapshot).toHaveBeenCalledTimes(1);
    });

    it('does not return an accessibility snapshot captured before navigation', async () => {
      let resolveSnapshot!: (snapshot: string) => void;
      mockPage.ariaSnapshot = vi.fn().mockReturnValue(new Promise(resolve => { resolveSnapshot = resolve; }));
      const tab = new Tab(mockContext, mockPage as any, onPageClose);

      const snapshotPromise = tab.captureSnapshot();
      mockPage.emit('framenavigated', { parentFrame: () => null });
      resolveSnapshot('button "Old page" [ref=1]');
      const snapshot = await snapshotPromise;

      expect(snapshot.ariaSnapshot).toContain('Page snapshot unavailable');
      expect(snapshot.ariaSnapshot).not.toContain('Old page');
    });

    it('does not invalidate a newer overlapping snapshot when an old capture resolves', async () => {
      let resolveOld!: (snapshot: string) => void;
      let resolveFresh!: (snapshot: string) => void;
      mockPage.ariaSnapshot = vi.fn()
          .mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
          .mockReturnValueOnce(new Promise(resolve => { resolveFresh = resolve; }));
      const tab = new Tab(mockContext, mockPage as any, onPageClose);

      const oldCapture = tab.captureSnapshot();
      mockPage.emit('framenavigated', { parentFrame: () => null });
      const freshCapture = tab.captureSnapshot();
      resolveFresh('button "Fresh page" [ref=2]');
      expect((await freshCapture).ariaSnapshot).toContain('Fresh page');
      resolveOld('button "Old page" [ref=1]');
      expect((await oldCapture).ariaSnapshot).toContain('Page snapshot unavailable');

      locatorSnapshot = 'button "Fresh page" [ref=2]';
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button "Other" [ref=3]');
      await tab.refLocators([{ element: 'Fresh page', ref: '2' }]);
      expect(mockPage.ariaSnapshot).not.toHaveBeenCalled();
    });

    it('does not invalidate a newer overlapping snapshot when an old capture times out', async () => {
      vi.useFakeTimers();
      mockContext.config.timeouts.defaultTimeout = 25;
      mockPage.ariaSnapshot = vi.fn()
          .mockReturnValueOnce(new Promise(() => {}))
          .mockResolvedValueOnce('button "Fresh page" [ref=2]');
      const tab = new Tab(mockContext, mockPage as any, onPageClose);

      const oldCapture = tab.captureSnapshot();
      const freshCapture = tab.captureSnapshot();
      expect((await freshCapture).ariaSnapshot).toContain('Fresh page');
      await vi.advanceTimersByTimeAsync(25);
      expect((await oldCapture).ariaSnapshot).toContain('Page snapshot unavailable');

      locatorSnapshot = 'button "Fresh page" [ref=2]';
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button "Other" [ref=3]');
      await tab.refLocators([{ element: 'Fresh page', ref: '2' }]);
      expect(mockPage.ariaSnapshot).not.toHaveBeenCalled();
    });

    it('does not cache a snapshot completed after a modal interrupts capture', async () => {
      let resolveSnapshot!: (snapshot: string) => void;
      mockPage.ariaSnapshot = vi.fn().mockReturnValue(new Promise(resolve => { resolveSnapshot = resolve; }));
      const tab = new Tab(mockContext, mockPage as any, onPageClose);

      const pending = tab.captureSnapshot();
      const modal = { type: 'dialog', description: 'Dialog', dialog: {} } as any;
      tab.setModalState(modal);
      expect((await pending).ariaSnapshot).toBe('');
      tab.clearModalState(modal);
      resolveSnapshot('button "Unseen" [ref=2]');
      await Promise.resolve();

      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button "Current" [ref=3]');
      await expect(tab.refLocators([{ element: 'Unseen', ref: '2' }])).rejects.toThrow('Ref 2 not found');
      expect(mockPage.ariaSnapshot).toHaveBeenCalledTimes(1);
    });

    it('caches overlapping snapshots in completion order', async () => {
      let resolveFirst!: (snapshot: string) => void;
      let resolveSecond!: (snapshot: string) => void;
      mockPage.ariaSnapshot = vi.fn()
          .mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve; }))
          .mockReturnValueOnce(new Promise(resolve => { resolveSecond = resolve; }));
      const tab = new Tab(mockContext, mockPage as any, onPageClose);

      const first = tab.captureSnapshot();
      const second = tab.captureSnapshot();
      resolveSecond('button "B" [ref=2]');
      await second;
      resolveFirst('button "A" [ref=1]');
      await first;

      locatorSnapshot = 'button "A" [ref=1]';
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button "Other" [ref=3]');
      await tab.refLocators([{ element: 'A', ref: '1' }]);
      expect(mockPage.ariaSnapshot).not.toHaveBeenCalled();
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

    it('resolves refs against the snapshot already returned to the caller', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button "Submit" [ref=1]');
      await tab.captureSnapshot();
      expect(mockPage.ariaSnapshot).toHaveBeenCalledTimes(1);

      await tab.refLocators([{ element: 'Submit', ref: '1' }]);

      // The ref came from that snapshot, so re-reading the page adds nothing.
      expect(mockPage.ariaSnapshot).toHaveBeenCalledTimes(1);
      expect(mockPage.locator).toHaveBeenCalledWith('aria-ref=1');
    });

    it('re-captures when a cached ref no longer resolves to an element', async () => {
      // The element was removed after the snapshot went out: the ref is still in
      // the cached text, but it matches nothing, and handing back that locator
      // would fail as an action timeout instead of a useful message.
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button "Submit" [ref=1]');
      await tab.captureSnapshot();
      locatorSnapshot = undefined;
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button "Other" [ref=2]');

      await expect(
          tab.refLocators([{ element: 'Submit', ref: '1' }])
      ).rejects.toThrow('Ref 1 not found');
      expect(mockPage.ariaSnapshot).toHaveBeenCalledTimes(1);
    });

    it('re-captures when a cached ref has different accessible semantics', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      await tab.captureSnapshot();
      locatorSnapshot = 'button "Delete" [ref=2]';
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button "Delete" [ref=2]');

      await expect(
          tab.refLocators([{ element: 'Submit', ref: '1' }])
      ).rejects.toThrow('Ref 1 not found');
      expect(mockPage.ariaSnapshot).toHaveBeenCalledTimes(1);
    });

    it('re-captures when the page navigates during cached ref validation', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      await tab.captureSnapshot();
      let resolveValidation!: (snapshot: string) => void;
      mockPage.locator = vi.fn().mockReturnValue({
        ariaSnapshot: vi.fn().mockReturnValue(new Promise(resolve => { resolveValidation = resolve; })),
        describe: vi.fn().mockReturnValue({}),
      });
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button "New page" [ref=2]');

      const locators = tab.refLocators([{ element: 'Submit', ref: '1' }]);
      mockPage.emit('framenavigated', { parentFrame: () => null });
      resolveValidation('button "Submit" [ref=1]');

      await expect(locators).rejects.toThrow('Ref 1 not found');
      expect(mockPage.ariaSnapshot).toHaveBeenCalledTimes(1);
    });

    it('does not accept a generated locator that only partially matches the old name', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button "Save" [ref=1]');
      await tab.captureSnapshot();
      locatorSnapshot = 'button "Save 2" [ref=2]';
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button "Save 2" [ref=2]');

      await expect(
          tab.refLocators([{ element: 'Save', ref: '1' }])
      ).rejects.toThrow('Ref 1 not found');
      expect(mockPage.ariaSnapshot).toHaveBeenCalledTimes(1);
    });

    it('revalidates YAML-quoted snapshot entries without a full-page capture', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      locatorSnapshot = `- 'button "Warning: Delete" [ref=1]'`;
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue(`- 'button "Warning: Delete" [ref=1]'`);
      await tab.captureSnapshot();

      await tab.refLocators([{ element: 'Delete', ref: '1' }]);

      expect(mockPage.ariaSnapshot).toHaveBeenCalledTimes(1);
    });

    it('accepts Playwright synthetic roles when the public ARIA role is empty', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      locatorSnapshot = 'generic [ref=1]';
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('generic [ref=1]');
      await tab.captureSnapshot();

      await tab.refLocators([{ element: 'Target', ref: '1' }]);

      expect(mockPage.ariaSnapshot).toHaveBeenCalledTimes(1);
    });

    it('reuses a cached ref whose long name is omitted from the snapshot', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      locatorSnapshot = 'button [ref=1]';
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button [ref=1]');
      await tab.captureSnapshot();

      await tab.refLocators([{ element: 'Long name', ref: '1' }]);
      await tab.refLocators([{ element: 'Long name', ref: '1' }]);

      expect(mockPage.ariaSnapshot).toHaveBeenCalledTimes(1);
    });

    it('re-captures when an omitted long name changes the Playwright ref', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button [ref=1]');
      await tab.captureSnapshot();
      locatorSnapshot = 'button [ref=2]';
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button [ref=2]');

      await expect(
          tab.refLocators([{ element: 'Long name', ref: '1' }])
      ).rejects.toThrow('Ref 1 not found');
    });

    it('re-reads the page for a ref the last snapshot does not hold', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button "Submit" [ref=1]');
      await tab.captureSnapshot();
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button "Submit" [ref=1] button "Added" [ref=2]');

      await tab.refLocators([{ element: 'Added', ref: '2' }]);

      expect(mockPage.ariaSnapshot).toHaveBeenCalledWith({ mode: 'ai' });
      expect(mockPage.locator).toHaveBeenCalledWith('aria-ref=2');
    });

    it('stops trusting the cached snapshot once the tab navigates', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button "Submit" [ref=1]');
      await tab.captureSnapshot();
      mockPage.goto = vi.fn().mockResolvedValue(undefined);
      mockPage.waitForLoadState = vi.fn().mockResolvedValue(undefined);
      await tab.navigate('https://example.com/next');

      await tab.refLocators([{ element: 'Submit', ref: '1' }]);

      // Two captures: the first one described a page that is gone.
      expect(mockPage.ariaSnapshot).toHaveBeenCalledTimes(2);
    });

    it('stops trusting the cached snapshot after any main-frame navigation', async () => {
      // goBack(), page.reload() and a page-driven location change never reach
      // Tab.navigate(), so the cache is keyed on the navigation event itself.
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button "Submit" [ref=1]');
      await tab.captureSnapshot();

      mockPage.emit('framenavigated', { parentFrame: () => null });
      await tab.refLocators([{ element: 'Submit', ref: '1' }]);

      expect(mockPage.ariaSnapshot).toHaveBeenCalledTimes(2);
    });

    it('keeps the cached snapshot when only a sub-frame navigates', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      mockPage.ariaSnapshot = vi.fn().mockResolvedValue('button "Submit" [ref=1]');
      await tab.captureSnapshot();

      mockPage.emit('framenavigated', { parentFrame: () => ({}) });
      await tab.refLocators([{ element: 'Submit', ref: '1' }]);

      expect(mockPage.ariaSnapshot).toHaveBeenCalledTimes(1);
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
