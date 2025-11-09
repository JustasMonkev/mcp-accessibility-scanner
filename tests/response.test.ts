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
import { Response } from '../src/response.js';
import type { Context } from '../src/context.js';
import type { Tab } from '../src/tab.js';

describe('Response', () => {
  let mockContext: Context;
  let mockTab: Tab;

  beforeEach(() => {
    mockTab = {
      page: { url: () => 'https://example.com' },
      lastTitle: () => 'Example Page',
      isCurrentTab: () => true,
      captureSnapshot: vi.fn().mockResolvedValue({
        url: 'https://example.com',
        title: 'Example Page',
        ariaSnapshot: 'button "Submit"',
        modalStates: [],
        consoleMessages: [],
        downloads: [],
      }),
      updateTitle: vi.fn().mockResolvedValue(undefined),
    } as any;

    mockContext = {
      currentTab: () => mockTab,
      currentTabOrDie: () => mockTab,
      tabs: () => [mockTab],
      config: {
        imageResponses: 'include',
      },
    } as any;
  });

  describe('constructor', () => {
    it('should create a response with tool name and args', () => {
      const response = new Response(mockContext, 'test_tool', { param: 'value' });
      expect(response.toolName).toBe('test_tool');
      expect(response.toolArgs).toEqual({ param: 'value' });
    });
  });

  describe('addResult', () => {
    it('should add result text', () => {
      const response = new Response(mockContext, 'test_tool', {});
      response.addResult('Test result');
      expect(response.result()).toBe('Test result');
    });

    it('should concatenate multiple results', () => {
      const response = new Response(mockContext, 'test_tool', {});
      response.addResult('Result 1');
      response.addResult('Result 2');
      expect(response.result()).toBe('Result 1\nResult 2');
    });
  });

  describe('addError', () => {
    it('should add error text', () => {
      const response = new Response(mockContext, 'test_tool', {});
      response.addError('Error occurred');
      expect(response.result()).toBe('Error occurred');
    });

    it('should mark response as error', () => {
      const response = new Response(mockContext, 'test_tool', {});
      expect(response.isError()).toBeUndefined();
      response.addError('Error occurred');
      expect(response.isError()).toBe(true);
    });
  });

  describe('addCode', () => {
    it('should add code snippet', () => {
      const response = new Response(mockContext, 'test_tool', {});
      response.addCode('await page.click("button")');
      expect(response.code()).toBe('await page.click("button")');
    });

    it('should concatenate multiple code snippets', () => {
      const response = new Response(mockContext, 'test_tool', {});
      response.addCode('await page.click("button")');
      response.addCode('await page.type("input", "text")');
      expect(response.code()).toBe('await page.click("button")\nawait page.type("input", "text")');
    });
  });

  describe('addImage', () => {
    it('should add image to response', () => {
      const response = new Response(mockContext, 'test_tool', {});
      const imageBuffer = Buffer.from('test');
      response.addImage({ contentType: 'image/png', data: imageBuffer });
      expect(response.images()).toHaveLength(1);
      expect(response.images()[0]).toEqual({
        contentType: 'image/png',
        data: imageBuffer,
      });
    });

    it('should add multiple images', () => {
      const response = new Response(mockContext, 'test_tool', {});
      response.addImage({ contentType: 'image/png', data: Buffer.from('img1') });
      response.addImage({ contentType: 'image/jpeg', data: Buffer.from('img2') });
      expect(response.images()).toHaveLength(2);
    });
  });

  describe('setIncludeSnapshot', () => {
    it('should enable snapshot inclusion', async () => {
      const response = new Response(mockContext, 'test_tool', {});
      response.setIncludeSnapshot();
      await response.finish();
      expect(mockTab.captureSnapshot).toHaveBeenCalled();
    });
  });

  describe('setIncludeTabs', () => {
    it('should enable tabs listing', () => {
      const response = new Response(mockContext, 'test_tool', {});
      response.setIncludeTabs();
      const serialized = response.serialize();
      expect(serialized.content[0].text).toContain('Open tabs');
    });
  });

  describe('finish', () => {
    it('should capture snapshot if requested', async () => {
      const response = new Response(mockContext, 'test_tool', {});
      response.setIncludeSnapshot();
      await response.finish();
      expect(mockTab.captureSnapshot).toHaveBeenCalled();
    });

    it('should update all tab titles', async () => {
      const response = new Response(mockContext, 'test_tool', {});
      await response.finish();
      expect(mockTab.updateTitle).toHaveBeenCalled();
    });
  });

  describe('serialize', () => {
    it('should serialize basic response', () => {
      const response = new Response(mockContext, 'test_tool', {});
      response.addResult('Test result');
      const serialized = response.serialize();
      expect(serialized.content).toHaveLength(1);
      expect(serialized.content[0].type).toBe('text');
      expect(serialized.content[0].text).toContain('Test result');
    });

    it('should include code section when code is added', () => {
      const response = new Response(mockContext, 'test_tool', {});
      response.addCode('await page.click("button")');
      const serialized = response.serialize();
      expect(serialized.content[0].text).toContain('Ran Playwright code');
      expect(serialized.content[0].text).toContain('await page.click("button")');
    });

    it('should include images when present', () => {
      const response = new Response(mockContext, 'test_tool', {});
      response.addImage({ contentType: 'image/png', data: Buffer.from('test') });
      const serialized = response.serialize();
      expect(serialized.content).toHaveLength(2);
      expect(serialized.content[1].type).toBe('image');
      expect(serialized.content[1].mimeType).toBe('image/png');
    });

    it('should omit images when configured', () => {
      mockContext.config.imageResponses = 'omit';
      const response = new Response(mockContext, 'test_tool', {});
      response.addImage({ contentType: 'image/png', data: Buffer.from('test') });
      const serialized = response.serialize();
      expect(serialized.content).toHaveLength(1);
    });

    it('should include error flag when error occurred', () => {
      const response = new Response(mockContext, 'test_tool', {});
      response.addError('Error message');
      const serialized = response.serialize();
      expect(serialized.isError).toBe(true);
    });

    it('should include snapshot when captured', async () => {
      const response = new Response(mockContext, 'test_tool', {});
      response.setIncludeSnapshot();
      await response.finish();
      const serialized = response.serialize();
      expect(serialized.content[0].text).toContain('Page state');
      expect(serialized.content[0].text).toContain('Example Page');
    });

    it('should include console messages in snapshot', async () => {
      mockTab.captureSnapshot = vi.fn().mockResolvedValue({
        url: 'https://example.com',
        title: 'Example Page',
        ariaSnapshot: '',
        modalStates: [],
        consoleMessages: [
          { type: 'log', text: 'Test message', toString: () => '[LOG] Test message' }
        ],
        downloads: [],
      });

      const response = new Response(mockContext, 'test_tool', {});
      response.setIncludeSnapshot();
      await response.finish();
      const serialized = response.serialize();
      expect(serialized.content[0].text).toContain('New console messages');
      expect(serialized.content[0].text).toContain('Test message');
    });

    it('should include downloads in snapshot', async () => {
      mockTab.captureSnapshot = vi.fn().mockResolvedValue({
        url: 'https://example.com',
        title: 'Example Page',
        ariaSnapshot: '',
        modalStates: [],
        consoleMessages: [],
        downloads: [{
          download: { suggestedFilename: () => 'file.pdf' } as any,
          finished: true,
          outputFile: '/tmp/file.pdf'
        }],
      });

      const response = new Response(mockContext, 'test_tool', {});
      response.setIncludeSnapshot();
      await response.finish();
      const serialized = response.serialize();
      expect(serialized.content[0].text).toContain('Downloads');
      expect(serialized.content[0].text).toContain('file.pdf');
    });
  });

  describe('tabSnapshot', () => {
    it('should return undefined before finish', () => {
      const response = new Response(mockContext, 'test_tool', {});
      expect(response.tabSnapshot()).toBeUndefined();
    });

    it('should return snapshot after finish', async () => {
      const response = new Response(mockContext, 'test_tool', {});
      response.setIncludeSnapshot();
      await response.finish();
      expect(response.tabSnapshot()).toBeDefined();
      expect(response.tabSnapshot()?.url).toBe('https://example.com');
    });
  });
});
