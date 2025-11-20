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
import navigateTools from '../src/tools/navigate.js';
import { Response } from '../src/response.js';
import type { Context } from '../src/context.js';
import type { Tab } from '../src/tab.js';

describe('Navigate Tools', () => {
  let mockContext: Context;
  let mockTab: Tab;
  let mockPage: any;
  let response: Response;

  beforeEach(() => {
    mockPage = {
      url: () => 'https://example.com',
      goBack: vi.fn().mockResolvedValue(null),
    };

    mockTab = {
      page: mockPage,
      navigate: vi.fn().mockResolvedValue(undefined),
      modalStates: vi.fn().mockReturnValue([]),
    } as any;

    mockContext = {
      currentTabOrDie: () => mockTab,
      ensureTab: vi.fn().mockResolvedValue(mockTab),
      config: {},
    } as any;

    response = new Response(mockContext, 'test_tool', {});
  });

  describe('browser_navigate tool', () => {
    const navigateTool = navigateTools.find(t => t.schema.name === 'browser_navigate')!;

    it('should exist', () => {
      expect(navigateTool).toBeDefined();
      expect(navigateTool.schema.name).toBe('browser_navigate');
    });

    it('should have correct schema', () => {
      expect(navigateTool.schema.title).toBe('Navigate to a URL');
      expect(navigateTool.schema.type).toBe('destructive');
    });

    it('should navigate to URL', async () => {
      await navigateTool.handle(mockContext, { url: 'https://example.com' }, response);

      expect(mockContext.ensureTab).toHaveBeenCalled();
      expect(mockTab.navigate).toHaveBeenCalledWith('https://example.com');
    });

    it('should include snapshot after navigation', async () => {
      const setIncludeSnapshotSpy = vi.spyOn(response, 'setIncludeSnapshot');

      await navigateTool.handle(mockContext, { url: 'https://example.com' }, response);

      expect(setIncludeSnapshotSpy).toHaveBeenCalled();
    });

    it('should generate navigation code', async () => {
      await navigateTool.handle(mockContext, { url: 'https://example.com' }, response);

      expect(response.code()).toContain('page.goto');
      expect(response.code()).toContain('https://example.com');
    });
  });

  describe('browser_navigate_back tool', () => {
    const backTool = navigateTools.find(t => t.schema.name === 'browser_navigate_back')!;

    it('should exist', () => {
      expect(backTool).toBeDefined();
      expect(backTool.schema.name).toBe('browser_navigate_back');
    });

    it('should have correct schema', () => {
      expect(backTool.schema.title).toBe('Go back');
      expect(backTool.schema.type).toBe('readOnly');
    });

    it('should navigate back', async () => {
      await backTool.handle(mockContext, {}, response);

      expect(mockPage.goBack).toHaveBeenCalled();
    });

    it('should include snapshot after navigation', async () => {
      const setIncludeSnapshotSpy = vi.spyOn(response, 'setIncludeSnapshot');

      await backTool.handle(mockContext, {}, response);

      expect(setIncludeSnapshotSpy).toHaveBeenCalled();
    });

    it('should generate back navigation code', async () => {
      await backTool.handle(mockContext, {}, response);

      expect(response.code()).toContain('page.goBack');
    });
  });

  describe('Tool capabilities', () => {
    it('should all have core capability', () => {
      navigateTools.forEach(tool => {
        expect(tool.capability).toBe('core');
      });
    });

    it('should export expected number of tools', () => {
      expect(navigateTools).toHaveLength(2);
    });
  });
});
