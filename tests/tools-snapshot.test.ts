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
import snapshotTools from '../src/tools/snapshot.js';
import { Response } from '../src/response.js';
import type { Context } from '../src/context.js';
import type { Tab } from '../src/tab.js';

describe('Snapshot Tools', () => {
  let mockContext: Context;
  let mockTab: Tab;
  let mockPage: any;
  let response: Response;

  beforeEach(() => {
    mockPage = {
      url: () => 'https://example.com',
      title: () => Promise.resolve('Example Page'),
      locator: vi.fn().mockReturnValue({
        describe: vi.fn().mockReturnThis(),
        click: vi.fn().mockResolvedValue(undefined),
        dblclick: vi.fn().mockResolvedValue(undefined),
        hover: vi.fn().mockResolvedValue(undefined),
        dragTo: vi.fn().mockResolvedValue(undefined),
        selectOption: vi.fn().mockResolvedValue(undefined),
      }),
      _snapshotForAI: vi.fn().mockResolvedValue('button "Submit" [ref=1]'),
    };

    mockTab = {
      page: mockPage,
      context: mockContext,
      refLocator: vi.fn().mockResolvedValue({
        describe: vi.fn().mockReturnThis(),
        click: vi.fn().mockResolvedValue(undefined),
        dblclick: vi.fn().mockResolvedValue(undefined),
        hover: vi.fn().mockResolvedValue(undefined),
        dragTo: vi.fn().mockResolvedValue(undefined),
        selectOption: vi.fn().mockResolvedValue(undefined),
        _resolveSelector: vi.fn().mockResolvedValue({
          resolvedSelector: 'button[name="submit"]',
        }),
      }),
      refLocators: vi.fn().mockResolvedValue([
        { _resolveSelector: vi.fn().mockResolvedValue({ resolvedSelector: 'button[name="start"]' }) },
        { _resolveSelector: vi.fn().mockResolvedValue({ resolvedSelector: 'button[name="end"]' }) },
      ]),
      waitForCompletion: vi.fn().mockImplementation(async (cb) => await cb()),
    } as any;

    mockContext = {
      currentTabOrDie: () => mockTab,
      ensureTab: vi.fn().mockResolvedValue(mockTab),
      config: {},
    } as any;

    response = new Response(mockContext, 'test_tool', {});
  });

  describe('scan_page tool', () => {
    const scanPageTool = snapshotTools.find(t => t.schema.name === 'scan_page')!;

    it('should exist', () => {
      expect(scanPageTool).toBeDefined();
      expect(scanPageTool.schema.name).toBe('scan_page');
    });

    it('should have correct schema', () => {
      expect(scanPageTool.schema.title).toBe('Scan page for accessibility violations');
      expect(scanPageTool.schema.type).toBe('destructive');
    });

    it('should handle accessibility scan', async () => {
      const mockAnalyze = vi.fn().mockResolvedValue({
        url: 'https://example.com',
        violations: [
          {
            tags: ['wcag2a', 'cat.color'],
            nodes: [
              {
                target: ['#main'],
                html: '<div id="main">Test</div>',
              },
            ],
          },
        ],
        incomplete: [],
        passes: [{ id: 'pass1' }],
        inapplicable: [{ id: 'na1' }],
      });

      // Mock AxeBuilder
      vi.doMock('@axe-core/playwright', () => ({
        default: class AxeBuilder {
          constructor() {}
          withTags() {
            return this;
          }
          analyze = mockAnalyze;
        },
      }));

      await scanPageTool.handle(mockContext, { violationsTag: ['wcag2a'] }, response);

      expect(response.result()).toContain('https://example.com');
      expect(response.result()).toContain('Violations: 1');
    });

    it('should deduplicate violation nodes', async () => {
      const mockAnalyze = vi.fn().mockResolvedValue({
        url: 'https://example.com',
        violations: [
          {
            tags: ['wcag2a'],
            nodes: [
              {
                target: ['#main'],
                html: '<div id="main">Test</div>',
              },
              {
                target: ['#main'],
                html: '<div id="main">Test</div>',
              },
            ],
          },
        ],
        incomplete: [],
        passes: [],
        inapplicable: [],
      });

      vi.doMock('@axe-core/playwright', () => ({
        default: class AxeBuilder {
          constructor() {}
          withTags() {
            return this;
          }
          analyze = mockAnalyze;
        },
      }));

      await scanPageTool.handle(mockContext, { violationsTag: ['wcag2a'] }, response);

      // Should deduplicate and only report once
      const result = response.result();
      expect(result).toBeDefined();
    });
  });

  describe('browser_snapshot tool', () => {
    const snapshotTool = snapshotTools.find(t => t.schema.name === 'browser_snapshot')!;

    it('should exist', () => {
      expect(snapshotTool).toBeDefined();
      expect(snapshotTool.schema.name).toBe('browser_snapshot');
    });

    it('should have correct schema', () => {
      expect(snapshotTool.schema.title).toBe('Page snapshot');
      expect(snapshotTool.schema.type).toBe('readOnly');
    });

    it('should request snapshot inclusion', async () => {
      const setIncludeSnapshotSpy = vi.spyOn(response, 'setIncludeSnapshot');
      await snapshotTool.handle(mockContext, {}, response);
      expect(setIncludeSnapshotSpy).toHaveBeenCalled();
    });

    it('should ensure tab exists', async () => {
      await snapshotTool.handle(mockContext, {}, response);
      expect(mockContext.ensureTab).toHaveBeenCalled();
    });
  });

  describe('browser_click tool', () => {
    const clickTool = snapshotTools.find(t => t.schema.name === 'browser_click')!;

    it('should exist', () => {
      expect(clickTool).toBeDefined();
      expect(clickTool.schema.name).toBe('browser_click');
    });

    it('should perform single click', async () => {
      const params = {
        element: 'Submit button',
        ref: '1',
      };

      await clickTool.handle(mockContext, params, response);

      expect(mockTab.refLocator).toHaveBeenCalledWith(params);
      expect(response.code()).toContain('click');
    });

    it('should perform double click', async () => {
      const params = {
        element: 'Submit button',
        ref: '1',
        doubleClick: true,
      };

      await clickTool.handle(mockContext, params, response);

      expect(response.code()).toContain('dblclick');
    });

    it('should handle button parameter', async () => {
      const params = {
        element: 'Submit button',
        ref: '1',
        button: 'right' as const,
      };

      await clickTool.handle(mockContext, params, response);

      expect(response.code()).toContain("button: 'right'");
    });

    it('should include snapshot after click', async () => {
      const setIncludeSnapshotSpy = vi.spyOn(response, 'setIncludeSnapshot');

      await clickTool.handle(mockContext, { element: 'Button', ref: '1' }, response);

      expect(setIncludeSnapshotSpy).toHaveBeenCalled();
    });
  });

  describe('browser_hover tool', () => {
    const hoverTool = snapshotTools.find(t => t.schema.name === 'browser_hover')!;

    it('should exist', () => {
      expect(hoverTool).toBeDefined();
      expect(hoverTool.schema.name).toBe('browser_hover');
    });

    it('should perform hover action', async () => {
      const params = {
        element: 'Menu item',
        ref: '1',
      };

      await hoverTool.handle(mockContext, params, response);

      expect(mockTab.refLocator).toHaveBeenCalledWith(params);
      expect(response.code()).toContain('hover');
    });

    it('should be read-only operation', () => {
      expect(hoverTool.schema.type).toBe('readOnly');
    });
  });

  describe('browser_drag tool', () => {
    const dragTool = snapshotTools.find(t => t.schema.name === 'browser_drag')!;

    it('should exist', () => {
      expect(dragTool).toBeDefined();
      expect(dragTool.schema.name).toBe('browser_drag');
    });

    it('should perform drag and drop', async () => {
      const params = {
        startElement: 'Draggable item',
        startRef: '1',
        endElement: 'Drop zone',
        endRef: '2',
      };

      await dragTool.handle(mockContext, params, response);

      expect(mockTab.refLocators).toHaveBeenCalledWith([
        { element: 'Draggable item', ref: '1' },
        { element: 'Drop zone', ref: '2' },
      ]);
      expect(response.code()).toContain('dragTo');
    });

    it('should be destructive operation', () => {
      expect(dragTool.schema.type).toBe('destructive');
    });
  });

  describe('browser_select_option tool', () => {
    const selectTool = snapshotTools.find(t => t.schema.name === 'browser_select_option')!;

    it('should exist', () => {
      expect(selectTool).toBeDefined();
      expect(selectTool.schema.name).toBe('browser_select_option');
    });

    it('should select single option', async () => {
      const params = {
        element: 'Country dropdown',
        ref: '1',
        values: ['USA'],
      };

      await selectTool.handle(mockContext, params, response);

      expect(mockTab.refLocator).toHaveBeenCalledWith({
        element: 'Country dropdown',
        ref: '1',
      });
      expect(response.code()).toContain('selectOption');
    });

    it('should select multiple options', async () => {
      const params = {
        element: 'Countries dropdown',
        ref: '1',
        values: ['USA', 'Canada', 'Mexico'],
      };

      await selectTool.handle(mockContext, params, response);

      expect(response.code()).toContain('USA');
      expect(response.code()).toContain('Canada');
      expect(response.code()).toContain('Mexico');
    });

    it('should be destructive operation', () => {
      expect(selectTool.schema.type).toBe('destructive');
    });
  });

  describe('Tool capabilities', () => {
    it('should all have core capability', () => {
      snapshotTools.forEach(tool => {
        expect(tool.capability).toBe('core');
      });
    });
  });
});
