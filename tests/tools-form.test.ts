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
import formTools from '../src/tools/form.js';
import { Response } from '../src/response.js';
import type { Context } from '../src/context.js';
import type { Tab } from '../src/tab.js';

describe('Form Tools', () => {
  let mockContext: Context;
  let mockTab: Tab;
  let mockPage: any;
  let response: Response;

  beforeEach(() => {
    mockPage = {
      url: () => 'https://example.com',
      keyboard: {
        press: vi.fn().mockResolvedValue(undefined),
      },
    };

    mockTab = {
      page: mockPage,
      refLocator: vi.fn().mockResolvedValue({
        describe: vi.fn().mockReturnThis(),
        fill: vi.fn().mockResolvedValue(undefined),
        pressSequentially: vi.fn().mockResolvedValue(undefined),
        press: vi.fn().mockResolvedValue(undefined),
        _resolveSelector: vi.fn().mockResolvedValue({
          resolvedSelector: 'input[name="email"]',
        }),
      }),
      waitForCompletion: vi.fn().mockImplementation(async (cb) => await cb()),
    } as any;

    mockContext = {
      currentTabOrDie: () => mockTab,
      config: {},
    } as any;

    response = new Response(mockContext, 'test_tool', {});
  });

  describe('browser_type tool', () => {
    const typeTool = formTools.find(t => t.schema.name === 'browser_type')!;

    it('should exist', () => {
      expect(typeTool).toBeDefined();
      expect(typeTool.schema.name).toBe('browser_type');
    });

    it('should have correct schema', () => {
      expect(typeTool.schema.title).toBe('Type');
      expect(typeTool.schema.type).toBe('destructive');
    });

    it('should type text normally by default', async () => {
      const params = {
        element: 'Email input',
        ref: '1',
        text: 'user@example.com',
      };

      const locator = await mockTab.refLocator(params);
      await typeTool.handle(mockContext, params, response);

      expect(mockTab.refLocator).toHaveBeenCalledWith({
        element: 'Email input',
        ref: '1',
      });
      expect(response.code()).toContain('fill');
      expect(response.code()).toContain('user@example.com');
    });

    it('should type slowly when requested', async () => {
      const params = {
        element: 'Email input',
        ref: '1',
        text: 'user@example.com',
        slowly: true,
      };

      await typeTool.handle(mockContext, params, response);

      expect(response.code()).toContain('pressSequentially');
    });

    it('should submit after typing when requested', async () => {
      const params = {
        element: 'Email input',
        ref: '1',
        text: 'user@example.com',
        submit: true,
      };

      await typeTool.handle(mockContext, params, response);

      expect(response.code()).toContain('press');
      expect(response.code()).toContain('Enter');
    });

    it('should include snapshot after typing', async () => {
      const setIncludeSnapshotSpy = vi.spyOn(response, 'setIncludeSnapshot');

      await typeTool.handle(mockContext, {
        element: 'Input',
        ref: '1',
        text: 'test',
      }, response);

      expect(setIncludeSnapshotSpy).toHaveBeenCalled();
    });
  });

  describe('Tool capabilities', () => {
    it('should all have core capability', () => {
      formTools.forEach(tool => {
        expect(tool.capability).toBe('core');
      });
    });
  });
});
