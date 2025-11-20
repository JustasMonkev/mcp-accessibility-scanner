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
import commonTools from '../src/tools/common.js';
import { Response } from '../src/response.js';
import type { Context } from '../src/context.js';
import type { Tab } from '../src/tab.js';

describe('Common Tools', () => {
  let mockContext: Context;
  let mockTab: Tab;
  let mockPage: any;
  let response: Response;

  beforeEach(() => {
    mockPage = {
      url: () => 'https://example.com',
      setViewportSize: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockTab = {
      page: mockPage,
      modalStates: vi.fn().mockReturnValue([]),
      waitForCompletion: vi.fn().mockImplementation(async cb => await cb()),
    } as any;

    mockContext = {
      currentTabOrDie: () => mockTab,
      currentTab: () => mockTab,
      closeBrowserContext: vi.fn().mockResolvedValue(undefined),
      config: {},
    } as any;

    response = new Response(mockContext, 'test_tool', {});
  });

  describe('browser_close tool', () => {
    const closeTool = commonTools.find(t => t.schema.name === 'browser_close')!;

    it('should exist', () => {
      expect(closeTool).toBeDefined();
      expect(closeTool.schema.name).toBe('browser_close');
    });

    it('should have correct schema', () => {
      expect(closeTool.schema.title).toBe('Close browser');
      expect(closeTool.schema.type).toBe('readOnly');
    });

    it('should close browser context', async () => {
      await closeTool.handle(mockContext, {}, response);

      expect(mockContext.closeBrowserContext).toHaveBeenCalled();
    });

    it('should generate close code', async () => {
      await closeTool.handle(mockContext, {}, response);

      expect(response.code()).toContain('page.close');
    });
  });

  describe('browser_resize tool', () => {
    const resizeTool = commonTools.find(t => t.schema.name === 'browser_resize')!;

    it('should exist', () => {
      expect(resizeTool).toBeDefined();
      expect(resizeTool.schema.name).toBe('browser_resize');
    });

    it('should have correct schema', () => {
      expect(resizeTool.schema.title).toBe('Resize browser window');
      expect(resizeTool.schema.type).toBe('readOnly');
    });

    it('should resize viewport', async () => {
      await resizeTool.handle(mockContext, { width: 1920, height: 1080 }, response);

      expect(mockTab.waitForCompletion).toHaveBeenCalled();
      expect(mockPage.setViewportSize).toHaveBeenCalledWith({ width: 1920, height: 1080 });
    });

    it('should generate resize code', async () => {
      await resizeTool.handle(mockContext, { width: 800, height: 600 }, response);

      expect(response.code()).toContain('setViewportSize');
      expect(response.code()).toContain('800');
      expect(response.code()).toContain('600');
    });
  });

  describe('Tool capabilities', () => {
    it('should all have core capability', () => {
      commonTools.forEach(tool => {
        expect(tool.capability).toBe('core');
      });
    });
  });
});
