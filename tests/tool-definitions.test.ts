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
import { defineTool, defineTabTool } from '../src/tools/tool.js';
import { z } from 'zod';
import type { Response } from '../src/response.js';

describe('Tool Definitions', () => {
  describe('defineTool', () => {
    it('should define a tool with schema and handler', () => {
      const schema = z.object({
        param: z.string(),
      });

      const handler = vi.fn();

      const tool = defineTool({
        capability: 'core',
        schema: {
          name: 'test_tool',
          title: 'Test Tool',
          description: 'A test tool',
          inputSchema: schema,
          type: 'readOnly',
        },
        handle: handler,
      });

      expect(tool.capability).toBe('core');
      expect(tool.schema.name).toBe('test_tool');
      expect(tool.handle).toBe(handler);
    });

    it('should preserve tool properties', () => {
      const schema = z.object({});

      const tool = defineTool({
        capability: 'core',
        schema: {
          name: 'my_tool',
          title: 'My Tool',
          description: 'Description',
          inputSchema: schema,
          type: 'destructive',
        },
        handle: async () => {},
      });

      expect(tool.schema.title).toBe('My Tool');
      expect(tool.schema.description).toBe('Description');
      expect(tool.schema.type).toBe('destructive');
    });
  });

  describe('defineTabTool', () => {
    it('should define a tab tool that wraps handler', () => {
      const schema = z.object({
        param: z.string(),
      });

      const tabHandler = vi.fn();

      const tool = defineTabTool({
        capability: 'core',
        schema: {
          name: 'tab_tool',
          title: 'Tab Tool',
          description: 'A tab tool',
          inputSchema: schema,
          type: 'readOnly',
        },
        handle: tabHandler,
      });

      expect(tool.capability).toBe('core');
      expect(tool.schema.name).toBe('tab_tool');
      expect(typeof tool.handle).toBe('function');
    });

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

      await tool.handle(mockContext as any, {}, mockResponse);

      expect(mockContext.currentTabOrDie).toHaveBeenCalled();
      expect(tabHandler).toHaveBeenCalledWith(mockTab, {}, mockResponse);
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
      expect(tabHandler).toHaveBeenCalledWith(mockTab, {}, mockResponse);
    });
  });
});
