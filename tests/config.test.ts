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

import { afterEach, describe, it, expect } from 'vitest';
import { resolveConfig, resolveCLIConfig, outputFile, parseCdpHeaders } from '../src/config.js';
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

  describe('parseCdpHeaders', () => {
    it('parses "Name: Value" entries, keeping colons inside the value', () => {
      expect(parseCdpHeaders(['X-Forwarded-Proto: value:with:colons'])).toEqual({
        'X-Forwarded-Proto': 'value:with:colons',
      });
    });

    it('parses multiple header entries', () => {
      expect(parseCdpHeaders(['Authorization: Bearer abc', 'X-Env: prod'])).toEqual({
        'Authorization': 'Bearer abc',
        'X-Env': 'prod',
      });
    });

    it('returns undefined for empty input', () => {
      expect(parseCdpHeaders(undefined)).toBeUndefined();
      expect(parseCdpHeaders([])).toBeUndefined();
    });

    it('throws on entries without a colon separator', () => {
      expect(() => parseCdpHeaders(['NoColonHere'])).toThrow(/expected "Name: Value" format/);
    });

    it('throws when the header name is empty', () => {
      expect(() => parseCdpHeaders([': value'])).toThrow(/header name is empty/);
    });
  });

  describe('resolveCLIConfig CDP headers', () => {
    const envKeys = ['PLAYWRIGHT_MCP_CDP_HEADERS', 'PLAYWRIGHT_MCP_CDP_TIMEOUT'];
    const saved: Record<string, string | undefined> = {};
    for (const key of envKeys)
      saved[key] = process.env[key];

    afterEach(() => {
      for (const key of envKeys) {
        if (saved[key] === undefined)
          delete process.env[key];
        else
          process.env[key] = saved[key];
      }
    });

    it('parses --cdp-header CLI options into a header map', async () => {
      const config = await resolveCLIConfig({
        cdpEndpoint: 'http://127.0.0.1:9222',
        cdpHeader: ['Authorization: Bearer token:with:colons'],
        cdpTimeout: 4321,
      });

      expect(config.browser.cdpHeaders).toEqual({ Authorization: 'Bearer token:with:colons' });
      expect(config.browser.cdpTimeout).toBe(4321);
    });

    it('reads CDP headers and timeout from environment variables', async () => {
      delete process.env.PLAYWRIGHT_MCP_CDP_HEADERS;
      delete process.env.PLAYWRIGHT_MCP_CDP_TIMEOUT;
      process.env.PLAYWRIGHT_MCP_CDP_HEADERS = 'X-Forwarded-Proto: value:with:colons';
      process.env.PLAYWRIGHT_MCP_CDP_TIMEOUT = '9000';

      const config = await resolveCLIConfig({ cdpEndpoint: 'http://127.0.0.1:9222' });

      expect(config.browser.cdpHeaders).toEqual({ 'X-Forwarded-Proto': 'value:with:colons' });
      expect(config.browser.cdpTimeout).toBe(9000);
    });

    it('lets --cdp-header override the environment value', async () => {
      process.env.PLAYWRIGHT_MCP_CDP_HEADERS = 'X-Env: from-env';

      const config = await resolveCLIConfig({
        cdpEndpoint: 'http://127.0.0.1:9222',
        cdpHeader: ['X-Cli: from-cli'],
      });

      expect(config.browser.cdpHeaders).toEqual({ 'X-Cli': 'from-cli' });
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
        outputDir: '/tmp/custom/output',
      });

      const result = await outputFile(config, '/tmp', 'test.txt');

      expect(result).toContain('/tmp/custom/output');
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
