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

import { describe, it, expect } from 'vitest';
import { resolveConfig, outputFile } from '../src/config.js';
import type { Config } from '../config.js';

describe('Config', () => {
  describe('resolveConfig', () => {
    it('should resolve default config when empty config provided', async () => {
      const config = await resolveConfig({});

      expect(config.browser.browserName).toBe('chromium');
      expect(config.timeouts.navigationTimeout).toBe(60000);
      expect(config.timeouts.defaultTimeout).toBe(5000);
      expect(config.saveTrace).toBe(false);
    });

    it('should merge custom browser config', async () => {
      const customConfig: Config = {
        browser: {
          browserName: 'firefox',
          launchOptions: {
            headless: true,
          },
        },
      };

      const config = await resolveConfig(customConfig);

      expect(config.browser.browserName).toBe('firefox');
      expect(config.browser.launchOptions.headless).toBe(true);
    });

    it('should merge custom timeout config', async () => {
      const customConfig: Config = {
        timeouts: {
          navigationTimeout: 30000,
          defaultTimeout: 10000,
        },
      };

      const config = await resolveConfig(customConfig);

      expect(config.timeouts.navigationTimeout).toBe(30000);
      expect(config.timeouts.defaultTimeout).toBe(10000);
    });

    it('should merge network config', async () => {
      const customConfig: Config = {
        network: {
          allowedOrigins: ['example.com'],
          blockedOrigins: ['ads.example.com'],
        },
      };

      const config = await resolveConfig(customConfig);

      expect(config.network.allowedOrigins).toEqual(['example.com']);
      expect(config.network.blockedOrigins).toEqual(['ads.example.com']);
    });

    it('should handle save trace option', async () => {
      const customConfig: Config = {
        saveTrace: true,
      };

      const config = await resolveConfig(customConfig);

      expect(config.saveTrace).toBe(true);
    });

    it('should preserve default values when not overridden', async () => {
      const customConfig: Config = {
        browser: {
          browserName: 'webkit',
        },
      };

      const config = await resolveConfig(customConfig);

      expect(config.browser.browserName).toBe('webkit');
      expect(config.timeouts.navigationTimeout).toBe(60000);
      expect(config.saveTrace).toBe(false);
    });
  });

  describe('outputFile', () => {
    it('should generate output file path with filename', async () => {
      const config = await resolveConfig({});
      const result = await outputFile(config, '/tmp', 'test.txt');

      expect(result).toContain('test.txt');
    });

    it('should use outputDir when specified', async () => {
      const config = await resolveConfig({
        outputDir: '/custom/output',
      });

      const result = await outputFile(config, '/tmp', 'test.txt');

      expect(result).toContain('/custom/output');
      expect(result).toContain('test.txt');
    });

    it('should sanitize file paths', async () => {
      const config = await resolveConfig({});

      const result = await outputFile(config, '/tmp', 'test/../../../etc/passwd');

      // Should sanitize to prevent directory traversal
      expect(result).not.toContain('../');
    });
  });
});
