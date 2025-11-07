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
      },
      lastTitle: () => 'Example Page',
      isCurrentTab: () => true,
    } as any;

    mockTab2 = {
      page: {
        url: () => 'https://other.com',
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
    } as any;

    response = new Response(mockContext, 'test_tool', {});
  });

  describe('browser_tab_list tool', () => {
    const listTool = tabsTools.find(t => t.schema.name === 'browser_tab_list')!;

    it('should exist', () => {
      expect(listTool).toBeDefined();
      expect(listTool.schema.name).toBe('browser_tab_list');
    });

    it('should have correct schema', () => {
      expect(listTool.schema.title).toBe('List tabs');
      expect(listTool.schema.type).toBe('readOnly');
    });

    it('should list all tabs', async () => {
      await listTool.handle(mockContext, {}, response);

      const result = response.serialize();
      expect(result.content[0].text).toContain('Example Page');
      expect(result.content[0].text).toContain('Other Page');
    });

    it('should set include tabs flag', async () => {
      const setIncludeTabsSpy = vi.spyOn(response, 'setIncludeTabs');

      await listTool.handle(mockContext, {}, response);

      expect(setIncludeTabsSpy).toHaveBeenCalled();
    });
  });

  describe('browser_tab_new tool', () => {
    const newTabTool = tabsTools.find(t => t.schema.name === 'browser_tab_new')!;

    it('should exist', () => {
      expect(newTabTool).toBeDefined();
      expect(newTabTool.schema.name).toBe('browser_tab_new');
    });

    it('should create new tab without URL', async () => {
      await newTabTool.handle(mockContext, {}, response);

      expect(mockContext.newTab).toHaveBeenCalled();
      expect(response.result()).toContain('Created new tab');
    });

    it('should create new tab and navigate', async () => {
      mockTab2.navigate = vi.fn().mockResolvedValue(undefined);

      await newTabTool.handle(mockContext, { url: 'https://new.com' }, response);

      expect(mockContext.newTab).toHaveBeenCalled();
      expect(mockTab2.navigate).toHaveBeenCalledWith('https://new.com');
    });

    it('should include snapshot after creation', async () => {
      const setIncludeSnapshotSpy = vi.spyOn(response, 'setIncludeSnapshot');

      await newTabTool.handle(mockContext, {}, response);

      expect(setIncludeSnapshotSpy).toHaveBeenCalled();
    });
  });

  describe('browser_tab_select tool', () => {
    const selectTool = tabsTools.find(t => t.schema.name === 'browser_tab_select')!;

    it('should exist', () => {
      expect(selectTool).toBeDefined();
      expect(selectTool.schema.name).toBe('browser_tab_select');
    });

    it('should select tab by index', async () => {
      await selectTool.handle(mockContext, { index: 1 }, response);

      expect(mockContext.selectTab).toHaveBeenCalledWith(1);
      expect(response.result()).toContain('Selected tab 1');
    });

    it('should include snapshot after selection', async () => {
      const setIncludeSnapshotSpy = vi.spyOn(response, 'setIncludeSnapshot');

      await selectTool.handle(mockContext, { index: 0 }, response);

      expect(setIncludeSnapshotSpy).toHaveBeenCalled();
    });
  });

  describe('browser_tab_close tool', () => {
    const closeTool = tabsTools.find(t => t.schema.name === 'browser_tab_close')!;

    it('should exist', () => {
      expect(closeTool).toBeDefined();
      expect(closeTool.schema.name).toBe('browser_tab_close');
    });

    it('should close current tab when no index provided', async () => {
      await closeTool.handle(mockContext, {}, response);

      expect(mockContext.closeTab).toHaveBeenCalledWith(undefined);
      expect(response.result()).toContain('Closed tab');
    });

    it('should close tab by index', async () => {
      await closeTool.handle(mockContext, { index: 1 }, response);

      expect(mockContext.closeTab).toHaveBeenCalledWith(1);
      expect(response.result()).toContain('Closed tab 1');
    });

    it('should include snapshot after closing', async () => {
      const setIncludeSnapshotSpy = vi.spyOn(response, 'setIncludeSnapshot');

      await closeTool.handle(mockContext, {}, response);

      expect(setIncludeSnapshotSpy).toHaveBeenCalled();
    });
  });

  describe('Tool capabilities', () => {
    it('should all have core capability', () => {
      tabsTools.forEach(tool => {
        expect(tool.capability).toBe('core');
      });
    });
  });
});
