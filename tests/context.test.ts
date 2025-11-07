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
  let mockPage: any;

  beforeEach(() => {
    mockPage = new EventEmitter();
    mockPage.url = vi.fn().mockReturnValue('about:blank');
    mockPage.title = vi.fn().mockResolvedValue('');
    mockPage.setDefaultNavigationTimeout = vi.fn();
    mockPage.setDefaultTimeout = vi.fn();
    mockPage.close = vi.fn().mockResolvedValue(undefined);
    mockPage.bringToFront = vi.fn().mockResolvedValue(undefined);
    mockPage._snapshotForAI = vi.fn().mockResolvedValue('');

    mockBrowserContext = new EventEmitter();
    mockBrowserContext.newPage = vi.fn().mockResolvedValue(mockPage);
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

    it('should track created tabs', async () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      await context.newTab();
      expect(context.tabs()).toHaveLength(1);
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

    it('should return current tab after creation', async () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      const tab = await context.newTab();
      expect(context.currentTab()).toBe(tab);
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

    it('should return current tab when exists', async () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      const tab = await context.newTab();
      expect(context.currentTabOrDie()).toBe(tab);
    });
  });

  describe('newTab', () => {
    it('should create new tab', async () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      const tab = await context.newTab();
      expect(tab).toBeDefined();
      expect(context.tabs()).toContain(tab);
    });

    it('should set new tab as current', async () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      const tab = await context.newTab();
      expect(context.currentTab()).toBe(tab);
    });
  });

  describe('selectTab', () => {
    it('should select tab by index', async () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      const tab1 = await context.newTab();

      const mockPage2 = { ...mockPage };
      mockBrowserContext.newPage = vi.fn().mockResolvedValue(mockPage2);
      const tab2 = await context.newTab();

      await context.selectTab(0);
      expect(context.currentTab()).toBe(tab1);
    });

    it('should throw error for invalid index', async () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      await expect(context.selectTab(999)).rejects.toThrow('Tab 999 not found');
    });

    it('should bring tab to front', async () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      await context.newTab();
      await context.selectTab(0);
      expect(mockPage.bringToFront).toHaveBeenCalled();
    });
  });

  describe('ensureTab', () => {
    it('should create tab if none exists', async () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      const tab = await context.ensureTab();
      expect(tab).toBeDefined();
      expect(context.tabs()).toHaveLength(1);
    });

    it('should return existing tab if available', async () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      const tab1 = await context.ensureTab();
      const tab2 = await context.ensureTab();
      expect(tab1).toBe(tab2);
      expect(context.tabs()).toHaveLength(1);
    });
  });

  describe('closeTab', () => {
    it('should close current tab by default', async () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      await context.newTab();
      const url = await context.closeTab(undefined);
      expect(url).toBe('about:blank');
      expect(mockPage.close).toHaveBeenCalled();
    });

    it('should close tab by index', async () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      await context.newTab();
      const url = await context.closeTab(0);
      expect(url).toBe('about:blank');
    });

    it('should throw error for invalid index', async () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      await expect(context.closeTab(999)).rejects.toThrow('Tab 999 not found');
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

  describe('dispose', () => {
    it('should close browser context', async () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      await context.newTab();
      await context.dispose();
      // Context should be disposed
      expect(context.tabs()).toEqual([]);
    });
  });

  describe('network filtering', () => {
    it('should block all origins except allowed when allowedOrigins is set', async () => {
      const context = new Context({
        tools: [],
        config: {
          network: {
            allowedOrigins: ['example.com'],
          },
        } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      await context.newTab();

      expect(mockBrowserContext.route).toHaveBeenCalledWith(
        '**',
        expect.any(Function)
      );
      expect(mockBrowserContext.route).toHaveBeenCalledWith(
        '*://example.com/**',
        expect.any(Function)
      );
    });

    it('should block specific origins when blockedOrigins is set', async () => {
      const context = new Context({
        tools: [],
        config: {
          network: {
            blockedOrigins: ['ads.example.com'],
          },
        } as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      await context.newTab();

      expect(mockBrowserContext.route).toHaveBeenCalledWith(
        '*://ads.example.com/**',
        expect.any(Function)
      );
    });
  });

  describe('disposeAll', () => {
    it('should dispose all contexts', async () => {
      const context1 = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      const context2 = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      await Context.disposeAll();
      // All contexts should be disposed
      expect(context1.tabs()).toEqual([]);
      expect(context2.tabs()).toEqual([]);
    });
  });
});
