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
import { waitForCompletion, generateLocator, callOnPageNoTrace } from '../src/tools/utils.js';
import type { Tab } from '../src/tab.js';
import { EventEmitter } from 'events';

describe('Tool Utils', () => {
  let mockTab: Tab;
  let mockPage: any;

  beforeEach(() => {
    mockPage = new EventEmitter();
    mockPage.url = () => 'https://example.com';
    mockPage.waitForLoadState = vi.fn().mockResolvedValue(undefined);
    mockPage.evaluate = vi.fn().mockResolvedValue(undefined);
    mockPage._wrapApiCall = vi.fn().mockImplementation(cb => cb());

    mockTab = {
      page: mockPage,
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    } as any;
  });

  describe('waitForCompletion', () => {
    it('should wait for callback to complete', async () => {
      const callback = vi.fn().mockResolvedValue('result');

      const result = await waitForCompletion(mockTab, callback);

      expect(callback).toHaveBeenCalled();
      expect(result).toBe('result');
    });

    it('should wait for pending requests to finish', async () => {
      const callback = vi.fn().mockImplementation(() => {
        const request = { url: 'https://api.example.com' };
        mockPage.emit('request', request);
        setTimeout(() => mockPage.emit('requestfinished', request), 10);
        return Promise.resolve('result');
      });

      const result = await waitForCompletion(mockTab, callback);

      expect(result).toBe('result');
    });

    it('should ignore sub-frame navigation', async () => {
      const callback = vi.fn().mockImplementation(() => {
        const subFrame = { parentFrame: () => ({}) };
        mockPage.emit('framenavigated', subFrame);
        return Promise.resolve('result');
      });

      await waitForCompletion(mockTab, callback);

      // Should not wait for load state for sub-frames
      expect(mockTab.waitForTimeout).toHaveBeenCalled();
    });

    it('should timeout after 10 seconds', async () => {
      vi.useFakeTimers();

      const callback = vi.fn().mockImplementation(() => {
        const request = { url: 'https://slow-api.example.com' };
        mockPage.emit('request', request);
        // Never finish the request
        return Promise.resolve('result');
      });

      const promise = waitForCompletion(mockTab, callback);

      vi.advanceTimersByTime(10000);

      await promise;

      expect(callback).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('should wait 1 second after completion', async () => {
      const callback = vi.fn().mockResolvedValue('result');

      await waitForCompletion(mockTab, callback);

      expect(mockTab.waitForTimeout).toHaveBeenCalledWith(1000);
    });
  });

  describe('generateLocator', () => {
    it('should generate locator string', async () => {
      const mockLocator = {
        _resolveSelector: vi.fn().mockResolvedValue({
          resolvedSelector: 'button[name="submit"]',
        }),
      } as any;

      // Mock the asLocator function
      vi.mock('playwright-core/lib/utils', () => ({
        asLocator: (lang: string, selector: string) => `locator('${selector}')`,
      }));

      const result = await generateLocator(mockLocator);

      expect(mockLocator._resolveSelector).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should throw error for invalid locator', async () => {
      const mockLocator = {
        _resolveSelector: vi.fn().mockRejectedValue(new Error('Selector not found')),
      } as any;

      await expect(generateLocator(mockLocator)).rejects.toThrow('Ref not found');
    });
  });

  describe('callOnPageNoTrace', () => {
    it('should call function on page without tracing', async () => {
      const callback = vi.fn().mockResolvedValue('result');

      const result = await callOnPageNoTrace(mockPage, callback);

      expect(callback).toHaveBeenCalledWith(mockPage);
      expect(result).toBe('result');
      expect(mockPage._wrapApiCall).toHaveBeenCalled();
    });

    it('should pass through errors', async () => {
      const callback = vi.fn().mockRejectedValue(new Error('Test error'));

      await expect(callOnPageNoTrace(mockPage, callback)).rejects.toThrow('Test error');
    });

    it('should mark call as internal', async () => {
      const callback = vi.fn().mockResolvedValue('result');

      await callOnPageNoTrace(mockPage, callback);

      expect(mockPage._wrapApiCall).toHaveBeenCalledWith(
          expect.any(Function),
          { internal: true }
      );
    });
  });
});
