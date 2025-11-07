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
import waitTools from '../src/tools/wait.js';
import { Response } from '../src/response.js';
import type { Context } from '../src/context.js';
import type { Tab } from '../src/tab.js';

describe('Wait Tools', () => {
  let mockContext: Context;
  let mockTab: Tab;
  let mockPage: any;
  let response: Response;

  beforeEach(() => {
    mockPage = {
      url: () => 'https://example.com',
      waitForFunction: vi.fn().mockResolvedValue(undefined),
    };

    mockTab = {
      page: mockPage,
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    } as any;

    mockContext = {
      currentTabOrDie: () => mockTab,
      config: {},
    } as any;

    response = new Response(mockContext, 'test_tool', {});
  });

  describe('browser_wait_for tool', () => {
    const waitTool = waitTools.find(t => t.schema.name === 'browser_wait_for')!;

    it('should exist', () => {
      expect(waitTool).toBeDefined();
      expect(waitTool.schema.name).toBe('browser_wait_for');
    });

    it('should have correct schema', () => {
      expect(waitTool.schema.title).toBe('Wait for');
      expect(waitTool.schema.type).toBe('readOnly');
    });

    it('should wait for specified time', async () => {
      await waitTool.handle(mockContext, { time: 2000 }, response);

      expect(mockTab.waitForTimeout).toHaveBeenCalledWith(2000);
      expect(response.result()).toContain('Waited for 2000 ms');
    });

    it('should wait for text to appear', async () => {
      await waitTool.handle(mockContext, { text: 'Success' }, response);

      expect(mockPage.waitForFunction).toHaveBeenCalled();
      expect(response.result()).toContain('Waited for text "Success" to appear');
    });

    it('should wait for text to disappear', async () => {
      await waitTool.handle(mockContext, { textGone: 'Loading' }, response);

      expect(mockPage.waitForFunction).toHaveBeenCalled();
      expect(response.result()).toContain('Waited for text "Loading" to disappear');
    });

    it('should wait for both time and text', async () => {
      await waitTool.handle(mockContext, { time: 1000, text: 'Ready' }, response);

      expect(mockTab.waitForTimeout).toHaveBeenCalledWith(1000);
      expect(mockPage.waitForFunction).toHaveBeenCalled();
    });

    it('should include snapshot after waiting', async () => {
      const setIncludeSnapshotSpy = vi.spyOn(response, 'setIncludeSnapshot');

      await waitTool.handle(mockContext, { time: 1000 }, response);

      expect(setIncludeSnapshotSpy).toHaveBeenCalled();
    });

    it('should generate wait code', async () => {
      await waitTool.handle(mockContext, { time: 2000 }, response);

      expect(response.code()).toContain('waitForTimeout');
      expect(response.code()).toContain('2000');
    });
  });

  describe('Tool capabilities', () => {
    it('should all have core capability', () => {
      waitTools.forEach(tool => {
        expect(tool.capability).toBe('core');
      });
    });
  });
});
