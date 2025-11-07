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
import keyboardTools from '../src/tools/keyboard.js';
import { Response } from '../src/response.js';
import type { Context } from '../src/context.js';
import type { Tab } from '../src/tab.js';

describe('Keyboard Tools', () => {
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
      waitForCompletion: vi.fn().mockImplementation(async (cb) => await cb()),
    } as any;

    mockContext = {
      currentTabOrDie: () => mockTab,
      config: {},
    } as any;

    response = new Response(mockContext, 'test_tool', {});
  });

  describe('browser_press_key tool', () => {
    const pressKeyTool = keyboardTools.find(t => t.schema.name === 'browser_press_key')!;

    it('should exist', () => {
      expect(pressKeyTool).toBeDefined();
      expect(pressKeyTool.schema.name).toBe('browser_press_key');
    });

    it('should have correct schema', () => {
      expect(pressKeyTool.schema.title).toBe('Press key');
      expect(pressKeyTool.schema.type).toBe('destructive');
    });

    it('should press single character key', async () => {
      await pressKeyTool.handle(mockContext, { key: 'a' }, response);

      expect(mockPage.keyboard.press).toHaveBeenCalledWith('a');
      expect(response.code()).toContain('keyboard.press');
      expect(response.code()).toContain("'a'");
    });

    it('should press special keys', async () => {
      const specialKeys = ['Enter', 'Escape', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

      for (const key of specialKeys) {
        mockPage.keyboard.press.mockClear();
        response = new Response(mockContext, 'test_tool', {});

        await pressKeyTool.handle(mockContext, { key }, response);

        expect(mockPage.keyboard.press).toHaveBeenCalledWith(key);
        expect(response.code()).toContain(key);
      }
    });

    it('should include snapshot after key press', async () => {
      const setIncludeSnapshotSpy = vi.spyOn(response, 'setIncludeSnapshot');

      await pressKeyTool.handle(mockContext, { key: 'Tab' }, response);

      expect(setIncludeSnapshotSpy).toHaveBeenCalled();
    });

    it('should report key press', async () => {
      await pressKeyTool.handle(mockContext, { key: 'Enter' }, response);

      expect(response.result()).toContain('Pressed key: Enter');
    });
  });

  describe('Tool capabilities', () => {
    it('should all have core capability', () => {
      keyboardTools.forEach(tool => {
        expect(tool.capability).toBe('core');
      });
    });
  });
});
