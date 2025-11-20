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
import tabsTools from '../src/tools/tabs.js';
import { Response } from '../src/response.js';
import type { Context } from '../src/context.js';
import type { Tab } from '../src/tab.js';

describe('Tabs Tools', () => {
  let mockContext: Context;
  let mockTab1: Tab;
  let mockTab2: Tab;
  let response: Response;

  beforeEach(() => {
    mockTab1 = {
      page: {
        url: () => 'https://example.com',
        setDefaultNavigationTimeout: vi.fn(),
        setDefaultTimeout: vi.fn(),
      },
      lastTitle: () => 'Example Page',
      isCurrentTab: () => true,
    } as any;

    mockTab2 = {
      page: {
        url: () => 'https://other.com',
        setDefaultNavigationTimeout: vi.fn(),
        setDefaultTimeout: vi.fn(),
      },
      lastTitle: () => 'Other Page',
      isCurrentTab: () => false,
    } as any;

    mockContext = {
      currentTabOrDie: () => mockTab1,
      tabs: () => [mockTab1, mockTab2],
      newTab: vi.fn().mockResolvedValue(mockTab2),
      selectTab: vi.fn().mockResolvedValue(mockTab2),
      closeTab: vi.fn().mockResolvedValue('https://closed.com'),
      ensureTab: vi.fn().mockResolvedValue(mockTab1),
      config: {
        imageResponses: 'include',
      },
    } as any;

    response = new Response(mockContext, 'test_tool', {});
  });

  describe('browser_tabs tool', () => {
    const tabsTool = tabsTools.find(t => t.schema.name === 'browser_tabs')!;

    it('should exist', () => {
      expect(tabsTool).toBeDefined();
      expect(tabsTool.schema.name).toBe('browser_tabs');
    });

    it('should have correct schema', () => {
      expect(tabsTool.schema.title).toBe('Manage tabs');
      expect(tabsTool.schema.type).toBe('destructive');
    });

    it('should have core-tabs capability', () => {
      expect(tabsTool.capability).toBe('core-tabs');
    });

    it('should list tabs', async () => {
      await tabsTool.handle(mockContext, { action: 'list' }, response);

      expect(mockContext.ensureTab).toHaveBeenCalled();
      const serialized = response.serialize();
      expect(serialized.content[0].text).toContain('Open tabs');
    });

    it('should create new tab', async () => {
      await tabsTool.handle(mockContext, { action: 'new' }, response);

      expect(mockContext.newTab).toHaveBeenCalled();
    });

    it('should select tab by index', async () => {
      await tabsTool.handle(mockContext, { action: 'select', index: 1 }, response);

      expect(mockContext.selectTab).toHaveBeenCalledWith(1);
    });

    it('should throw error when selecting without index', async () => {
      await expect(
          tabsTool.handle(mockContext, { action: 'select' }, response)
      ).rejects.toThrow('Tab index is required');
    });

    it('should close tab by index', async () => {
      await tabsTool.handle(mockContext, { action: 'close', index: 1 }, response);

      expect(mockContext.closeTab).toHaveBeenCalledWith(1);
    });

    it('should close current tab when no index provided', async () => {
      await tabsTool.handle(mockContext, { action: 'close' }, response);

      expect(mockContext.closeTab).toHaveBeenCalledWith(undefined);
    });
  });

  describe('browser_navigation_timeout tool', () => {
    const navTimeoutTool = tabsTools.find(t => t.schema.name === 'browser_navigation_timeout')!;

    it('should exist', () => {
      expect(navTimeoutTool).toBeDefined();
      expect(navTimeoutTool.schema.name).toBe('browser_navigation_timeout');
    });

    it('should set navigation timeout for all tabs', async () => {
      await navTimeoutTool.handle(mockContext, { timeout: 60000 }, response);

      expect(mockTab1.page.setDefaultNavigationTimeout).toHaveBeenCalledWith(60000);
      expect(mockTab2.page.setDefaultNavigationTimeout).toHaveBeenCalledWith(60000);
      expect(response.result()).toContain('60000ms');
    });
  });

  describe('browser_default_timeout tool', () => {
    const defaultTimeoutTool = tabsTools.find(t => t.schema.name === 'browser_default_timeout')!;

    it('should exist', () => {
      expect(defaultTimeoutTool).toBeDefined();
      expect(defaultTimeoutTool.schema.name).toBe('browser_default_timeout');
    });

    it('should set default timeout for all tabs', async () => {
      await defaultTimeoutTool.handle(mockContext, { timeout: 30000 }, response);

      expect(mockTab1.page.setDefaultTimeout).toHaveBeenCalledWith(30000);
      expect(mockTab2.page.setDefaultTimeout).toHaveBeenCalledWith(30000);
      expect(response.result()).toContain('30000ms');
    });
  });

  describe('Tool capabilities', () => {
    it('should all have core-tabs capability', () => {
      tabsTools.forEach(tool => {
        expect(tool.capability).toBe('core-tabs');
      });
    });

    it('should export 3 tools', () => {
      expect(tabsTools).toHaveLength(3);
    });
  });
});
