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
import consoleTools from '../src/tools/console.js';
import { Response } from '../src/response.js';
import type { Context } from '../src/context.js';
import type { Tab } from '../src/tab.js';

describe('Console Tools', () => {
  let mockContext: Context;
  let mockTab: Tab;
  let response: Response;

  beforeEach(() => {
    mockTab = {
      consoleMessages: vi.fn().mockReturnValue([
        {
          type: 'log',
          text: 'Info message',
          toString: () => '[LOG] Info message @ test.js:10',
        },
        {
          type: 'error',
          text: 'Error occurred',
          toString: () => '[ERROR] Error occurred @ app.js:25',
        },
        {
          type: 'warning',
          text: 'Warning message',
          toString: () => '[WARNING] Warning message @ util.js:5',
        },
      ]),
      modalStates: vi.fn().mockReturnValue([]),
    } as any;

    mockContext = {
      currentTabOrDie: () => mockTab,
      config: {},
    } as any;

    response = new Response(mockContext, 'test_tool', {});
  });

  describe('browser_console_messages tool', () => {
    const consoleTool = consoleTools.find(t => t.schema.name === 'browser_console_messages')!;

    it('should exist', () => {
      expect(consoleTool).toBeDefined();
      expect(consoleTool.schema.name).toBe('browser_console_messages');
    });

    it('should have correct schema', () => {
      expect(consoleTool.schema.title).toBe('Get console messages');
      expect(consoleTool.schema.type).toBe('readOnly');
    });

    it('should retrieve all console messages', async () => {
      await consoleTool.handle(mockContext, {}, response);

      expect(mockTab.consoleMessages).toHaveBeenCalled();
      expect(response.result()).toContain('Info message');
      expect(response.result()).toContain('Error occurred');
      expect(response.result()).toContain('Warning message');
    });

    it('should format messages correctly', async () => {
      await consoleTool.handle(mockContext, {}, response);

      const result = response.result();
      expect(result).toContain('[LOG]');
      expect(result).toContain('[ERROR]');
      expect(result).toContain('[WARNING]');
    });

    it('should handle empty console messages', async () => {
      mockTab.consoleMessages = vi.fn().mockReturnValue([]);

      await consoleTool.handle(mockContext, {}, response);

      expect(response.result()).toBe('');
    });
  });

  describe('Tool capabilities', () => {
    it('should all have core capability', () => {
      consoleTools.forEach(tool => {
        expect(tool.capability).toBe('core');
      });
    });
  });
});
