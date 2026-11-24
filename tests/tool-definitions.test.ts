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

import { describe, it, expect, vi } from 'vitest';
import { defineTabTool } from '../src/tools/tool.js';
import { z } from 'zod';
import type { Response } from '../src/response.js';
import type { Context } from '../src/context.js';

describe('Tool Definitions', () => {
  describe('defineTabTool', () => {
    it('should call tab handler with current tab', async () => {
      const mockTab = {
        modalStates: vi.fn().mockReturnValue([]),
        modalStatesMarkdown: vi.fn().mockReturnValue([]),
      };

      const mockContext = {
        currentTabOrDie: vi.fn().mockReturnValue(mockTab),
      };

      const mockResponse = {} as Response;

      const tabHandler = vi.fn();

      const tool = defineTabTool({
        capability: 'core',
        schema: {
          name: 'tab_tool',
          title: 'Tab Tool',
          description: 'A tab tool',
          inputSchema: z.object({}),
          type: 'readOnly',
        },
        handle: tabHandler,
      });

      const signal = new AbortController().signal;
      await tool.handle(mockContext as Context, {}, mockResponse, signal);

      expect(mockContext.currentTabOrDie).toHaveBeenCalled();
      expect(tabHandler).toHaveBeenCalledWith(mockTab, {}, mockResponse, signal);
    });

    it('should add error when modal state present and tool does not handle it', async () => {
      const mockTab = {
        modalStates: vi.fn().mockReturnValue([{ type: 'dialog' }]),
        modalStatesMarkdown: vi.fn().mockReturnValue(['Dialog present']),
      };

      const mockContext = {
        currentTabOrDie: vi.fn().mockReturnValue(mockTab),
      };

      const mockResponse = {
        addError: vi.fn(),
      } as any;

      const tabHandler = vi.fn();

      const tool = defineTabTool({
        capability: 'core',
        schema: {
          name: 'tab_tool',
          title: 'Tab Tool',
          description: 'A tab tool',
          inputSchema: z.object({}),
          type: 'readOnly',
        },
        handle: tabHandler,
      });

      await tool.handle(mockContext as any, {}, mockResponse);

      expect(mockResponse.addError).toHaveBeenCalled();
      expect(tabHandler).not.toHaveBeenCalled();
    });

    it('should add error when modal state required but not present', async () => {
      const mockTab = {
        modalStates: vi.fn().mockReturnValue([]),
        modalStatesMarkdown: vi.fn().mockReturnValue([]),
      };

      const mockContext = {
        currentTabOrDie: vi.fn().mockReturnValue(mockTab),
      };

      const mockResponse = {
        addError: vi.fn(),
      } as any;

      const tabHandler = vi.fn();

      const tool = defineTabTool({
        capability: 'core',
        schema: {
          name: 'tab_tool',
          title: 'Tab Tool',
          description: 'A tab tool',
          inputSchema: z.object({}),
          type: 'readOnly',
        },
        clearsModalState: 'dialog',
        handle: tabHandler,
      });

      await tool.handle(mockContext as any, {}, mockResponse);

      expect(mockResponse.addError).toHaveBeenCalled();
      expect(tabHandler).not.toHaveBeenCalled();
    });

    it('should call handler when modal state matches', async () => {
      const mockTab = {
        modalStates: vi.fn().mockReturnValue([{ type: 'dialog' }]),
        modalStatesMarkdown: vi.fn().mockReturnValue([]),
      };

      const mockContext = {
        currentTabOrDie: vi.fn().mockReturnValue(mockTab),
      };

      const mockResponse = {
        addError: vi.fn(),
      } as any;

      const tabHandler = vi.fn();

      const tool = defineTabTool({
        capability: 'core',
        schema: {
          name: 'tab_tool',
          title: 'Tab Tool',
          description: 'A tab tool',
          inputSchema: z.object({}),
          type: 'readOnly',
        },
        clearsModalState: 'dialog',
        handle: tabHandler,
      });

      await tool.handle(mockContext as any, {}, mockResponse);

      expect(mockResponse.addError).not.toHaveBeenCalled();
      expect(tabHandler).toHaveBeenCalledWith(mockTab, {}, mockResponse, undefined);
    });
  });
});
