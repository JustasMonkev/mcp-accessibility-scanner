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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Context, currentToolNameStorage } from '../src/context.js';
import { Tab } from '../src/tab.js';
import type { BrowserContextFactory } from '../src/browserContextFactory.js';
import { EventEmitter } from 'events';

function createMockPage(): any {
  const page: any = new EventEmitter();
  page.setDefaultNavigationTimeout = vi.fn();
  page.setDefaultTimeout = vi.fn();
  return page;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

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

      const token = context.setRunningTool('test_tool');
      context.clearRunningTool(token);
      expect(context.isRunningTool()).toBe(false);
    });
  });

  describe('output protection', () => {
    it('passes the current async call\'s tool name to the context factory', async () => {
      const context = new Context({
        tools: [],
        config: {} as any,
        browserContextFactory: mockBrowserContextFactory,
        sessionLog: undefined,
        clientInfo: { rootPath: '/tmp' } as any,
      });

      await currentToolNameStorage.run('browser_navigate', () => context.ensureTab());

      expect(mockBrowserContextFactory.createContext).toHaveBeenCalledWith(
          expect.anything(), expect.anything(), 'browser_navigate');
    });

    it('reports in-flight downloads as protected output paths', async () => {
      const outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-ctx-download-'));
      try {
        const context = new Context({
          tools: [],
          config: { timeouts: {}, outputDir } as any,
          browserContextFactory: mockBrowserContextFactory,
          sessionLog: undefined,
          clientInfo: { rootPath: undefined } as any,
        });
        const page = createMockPage();
        const tab = new Tab(context, page, () => {});
        (context as any)._tabs.push(tab);

        // A download whose saveAs never resolves stays in-flight.
        page.emit('download', {
          suggestedFilename: () => 'export.csv',
          saveAs: () => new Promise<void>(() => {}),
        });
        // The download path is allocated asynchronously (mkdir), so wait for it
        // to register before asserting.
        for (let i = 0; i < 50 && tab.pendingDownloadOutputFiles().length === 0; i++)
          await tick();

        expect(context.protectedOutputDirs()).toContain(path.join(outputDir, 'export.csv'));
      } finally {
        await fs.promises.rm(outputDir, { recursive: true, force: true });
      }
    });
  });
});
