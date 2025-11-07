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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Tab, renderModalStates } from '../src/tab.js';
import type { Context } from '../src/context.js';
import type * as playwright from 'playwright';
import { EventEmitter } from 'events';

describe('Tab', () => {
  let mockContext: Context;
  let mockPage: any;
  let onPageClose: any;

  beforeEach(() => {
    mockPage = new EventEmitter();
    mockPage.url = vi.fn().mockReturnValue('https://example.com');
    mockPage.title = vi.fn().mockResolvedValue('Example Page');
    mockPage.setDefaultNavigationTimeout = vi.fn();
    mockPage.setDefaultTimeout = vi.fn();
    mockPage.goto = vi.fn().mockResolvedValue(null);
    mockPage.waitForLoadState = vi.fn().mockResolvedValue(undefined);
    mockPage.waitForEvent = vi.fn().mockResolvedValue(undefined);
    mockPage._snapshotForAI = vi.fn().mockResolvedValue('button "Submit" [ref=1]');
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
      tools: [],
    } as any;

    onPageClose = vi.fn();
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

    it('should emit modal state event', (done) => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      const modalState = {
        type: 'dialog' as const,
        description: 'Test dialog',
        dialog: {} as any,
      };

      tab.on('modalState', (state) => {
        expect(state).toBe(modalState);
        done();
      });

      tab.setModalState(modalState);
    });
  });

  describe('navigate', () => {
    it('should navigate to URL', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      await tab.navigate('https://example.com');
      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', { waitUntil: 'domcontentloaded' });
    });

    it('should wait for load state', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      await tab.navigate('https://example.com');
      expect(mockPage.waitForLoadState).toHaveBeenCalled();
    });

    it('should clear collected artifacts on navigation', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);

      // Add some console messages
      mockPage.emit('console', {
        type: () => 'log',
        text: () => 'Old message',
        location: () => ({ url: 'test.js', lineNumber: 1 }),
      });

      expect(tab.consoleMessages()).toHaveLength(1);

      await tab.navigate('https://example.com');
      expect(tab.consoleMessages()).toHaveLength(0);
    });
  });

  describe('updateTitle', () => {
    it('should update last title', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      await tab.updateTitle();
      expect(tab.lastTitle()).toBe('Example Page');
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
      const otherTab = new Tab(mockContext, {} as any, onPageClose);
      mockContext.currentTab = vi.fn().mockReturnValue(otherTab);
      expect(tab.isCurrentTab()).toBe(false);
    });
  });

  describe('captureSnapshot', () => {
    it('should capture page snapshot', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      const snapshot = await tab.captureSnapshot();
      expect(snapshot.url).toBe('https://example.com');
      expect(snapshot.title).toBe('Example Page');
      expect(snapshot.ariaSnapshot).toBe('button "Submit" [ref=1]');
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
  });

  describe('refLocator', () => {
    it('should get locator for ref', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      const locator = await tab.refLocator({ element: 'Submit button', ref: '1' });
      expect(mockPage.locator).toHaveBeenCalledWith('aria-ref=1');
    });

    it('should throw error if ref not found', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      mockPage._snapshotForAI = vi.fn().mockResolvedValue('button "Other"');

      await expect(
        tab.refLocator({ element: 'Submit button', ref: '999' })
      ).rejects.toThrow('Ref 999 not found');
    });
  });

  describe('refLocators', () => {
    it('should get multiple locators', async () => {
      const tab = new Tab(mockContext, mockPage as any, onPageClose);
      mockPage._snapshotForAI = vi.fn().mockResolvedValue('button "Submit" [ref=1] button "Cancel" [ref=2]');

      const locators = await tab.refLocators([
        { element: 'Submit', ref: '1' },
        { element: 'Cancel', ref: '2' },
      ]);

      expect(locators).toHaveLength(2);
      expect(mockPage.locator).toHaveBeenCalledWith('aria-ref=1');
      expect(mockPage.locator).toHaveBeenCalledWith('aria-ref=2');
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

      const mockRequest = { url: () => 'https://api.example.com' } as any;
      const mockResponse = { status: () => 200 } as any;

      mockPage.emit('request', mockRequest);
      mockPage.emit('response', { ...mockResponse, request: () => mockRequest });

      expect(tab.requests().size).toBe(1);
      expect(tab.requests().get(mockRequest)).toBe(mockResponse);
    });
  });
});

describe('renderModalStates', () => {
  it('should render empty modal states', () => {
    const mockContext = { tools: [] } as any;
    const result = renderModalStates(mockContext, []);
    expect(result).toContain('### Modal state');
    expect(result).toContain('There is no modal state present');
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
    expect(result.join('\n')).toContain('Test dialog');
    expect(result.join('\n')).toContain('browser_handle_dialog');
  });
});
