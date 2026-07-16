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

import fs from 'fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { waitForCompletion, generateLocator, callOnPageNoTrace } from '../src/tools/utils.js';
import type { Tab } from '../src/tab.js';
import { EventEmitter } from 'events';

vi.mock('playwright-core/lib/coreBundle', () => ({
  default: {
    iso: {
      asLocator: (lang: string, selector: string) => `locator('${selector}')`,
    },
  },
}));

const hasBundledChromium = fs.existsSync(chromium.executablePath());
async function canLaunchBundledChromium(): Promise<boolean> {
  if (!hasBundledChromium)
    return false;

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: false,
    });
    return true;
  } catch {
    return false;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

const canRunLocatorIntegration = await canLaunchBundledChromium();

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
    it('should resolve via the public normalize() API (playwright-core >= 1.61)', async () => {
      const normalized = { toString: () => `getByRole('button', { name: 'Submit' })` };
      const mockLocator = {
        normalize: vi.fn().mockResolvedValue(normalized),
        // Should be ignored when normalize() is available.
        _resolveSelector: vi.fn().mockResolvedValue({ resolvedSelector: 'ignored' }),
      } as any;

      const result = await generateLocator(mockLocator);

      expect(mockLocator.normalize).toHaveBeenCalled();
      expect(mockLocator._resolveSelector).not.toHaveBeenCalled();
      expect(result).toBe(`getByRole('button', { name: 'Submit' })`);
    });

    it('should fall back to _resolveSelector when normalize() throws', async () => {
      const mockLocator = {
        normalize: vi.fn().mockRejectedValue(new Error('ref not found')),
        _resolveSelector: vi.fn().mockResolvedValue({ resolvedSelector: 'button[name="submit"]' }),
      } as any;

      const result = await generateLocator(mockLocator);

      expect(mockLocator.normalize).toHaveBeenCalled();
      expect(mockLocator._resolveSelector).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should generate locator string', async () => {
      const mockLocator = {
        _resolveSelector: vi.fn().mockResolvedValue({
          resolvedSelector: 'button[name="submit"]',
        }),
      } as any;

      const result = await generateLocator(mockLocator);

      expect(mockLocator._resolveSelector).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should fall back to locator string when private selector resolution is unavailable', async () => {
      const mockLocator = {
        toString: () => 'locator(\'button\')',
      } as any;

      const result = await generateLocator(mockLocator);

      expect(result).toBe('locator(\'button\')');
    });

    it('should fall back to unresolved locator text when no useful string is available', async () => {
      const mockLocator = {
        toString: () => '[object Object]',
      } as any;

      await expect(generateLocator(mockLocator)).resolves.toBe('locator(\'<unresolved>\')');
    });

    it.skipIf(!canRunLocatorIntegration)('should resolve aria-ref locators to runnable locator code', async () => {
      let browser: Browser | undefined;
      try {
        browser = await chromium.launch({
          headless: true,
          chromiumSandbox: false,
        });
        const page = await browser.newPage();
        await page.setContent('<button type="button">Submit</button>');

        const snapshot = await page.ariaSnapshot({ mode: 'ai' });
        const ref = snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
        if (!ref)
          throw new Error(`Could not find aria ref in snapshot:\n${snapshot}`);

        const locator = page.locator(`aria-ref=${ref}`).describe('Submit button');
        const locatorSource = await generateLocator(locator);

        expect(locatorSource).not.toBe('Submit button');
        expect(locatorSource).toContain('getByRole');
        expect(locatorSource).toContain('button');
        expect(locatorSource).toContain('Submit');
      } finally {
        await browser?.close().catch(() => undefined);
      }
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
