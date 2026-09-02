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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { resolveConfig, resolveCLIConfig, outputFile, parseCdpHeaders, resolveOutputDir } from '../src/config.js';
import type { Config } from '../config.js';

async function writeConfigFile(config: Config): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-config-test-'));
  const configFile = path.join(dir, 'config.json');
  await fs.promises.writeFile(configFile, JSON.stringify(config), 'utf-8');
  return configFile;
}

describe('Config', () => {
  describe('resolveConfig', () => {
    it('should resolve default config when empty config provided', async () => {
      const config = await resolveConfig({});

      expect(config.browser.browserName).toBe('chromium');
      expect(config.timeouts.navigationTimeout).toBe(60000);
      expect(config.timeouts.defaultTimeout).toBe(5000);
      expect(config.timeouts.settle).toBe(500);
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
          settle: 250,
        },
      };

      const config = await resolveConfig(customConfig);

      expect(config.timeouts.navigationTimeout).toBe(30000);
      expect(config.timeouts.defaultTimeout).toBe(10000);
      expect(config.timeouts.settle).toBe(250);
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

  describe('sandbox defaults', () => {
    const savedSandbox = process.env.PLAYWRIGHT_MCP_SANDBOX;

    afterEach(() => {
      vi.restoreAllMocks();
      if (savedSandbox === undefined)
        delete process.env.PLAYWRIGHT_MCP_SANDBOX;
      else
        process.env.PLAYWRIGHT_MCP_SANDBOX = savedSandbox;
    });

    it('disables only the default sandbox for bundled Chromium on Linux', async () => {
      vi.spyOn(os, 'platform').mockReturnValue('linux');

      expect((await resolveCLIConfig({ browser: 'chromium' })).browser.launchOptions.chromiumSandbox).toBe(false);
      expect((await resolveCLIConfig({ browser: 'chrome' })).browser.launchOptions.chromiumSandbox).toBe(true);
      expect((await resolveConfig({
        browser: { launchOptions: { channel: 'chromium', chromiumSandbox: true } },
      })).browser.launchOptions.chromiumSandbox).toBe(true);

      process.env.PLAYWRIGHT_MCP_SANDBOX = 'true';
      expect((await resolveCLIConfig({ browser: 'chromium' })).browser.launchOptions.chromiumSandbox).toBe(true);
    });
  });

  it('reads the settle timeout from the environment and lets CLI override it', async () => {
    const previous = process.env.PLAYWRIGHT_MCP_TIMEOUT_SETTLE;
    process.env.PLAYWRIGHT_MCP_TIMEOUT_SETTLE = '250';
    try {
      expect((await resolveCLIConfig({})).timeouts.settle).toBe(250);
      expect((await resolveCLIConfig({ settleTimeout: 100 })).timeouts.settle).toBe(100);
    } finally {
      if (previous === undefined)
        delete process.env.PLAYWRIGHT_MCP_TIMEOUT_SETTLE;
      else
        process.env.PLAYWRIGHT_MCP_TIMEOUT_SETTLE = previous;
    }
  });

  describe('snapshot boxes', () => {
    const saved = process.env.PLAYWRIGHT_MCP_SNAPSHOT_BOXES;

    afterEach(() => {
      if (saved === undefined)
        delete process.env.PLAYWRIGHT_MCP_SNAPSHOT_BOXES;
      else
        process.env.PLAYWRIGHT_MCP_SNAPSHOT_BOXES = saved;
    });

    it('accepts a default in the config object', async () => {
      expect((await resolveConfig({ snapshot: { boxes: true } })).snapshot?.boxes).toBe(true);
    });

    it('applies config file, environment, and CLI precedence', async () => {
      const configFile = await writeConfigFile({ snapshot: { boxes: true } });
      expect((await resolveCLIConfig({ config: configFile })).snapshot?.boxes).toBe(true);

      process.env.PLAYWRIGHT_MCP_SNAPSHOT_BOXES = '0';
      expect((await resolveCLIConfig({ config: configFile })).snapshot?.boxes).toBe(false);
      expect((await resolveCLIConfig({ config: configFile, snapshotBoxes: true })).snapshot?.boxes).toBe(true);
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

    it('preserves commas inside an environment header value', async () => {
      delete process.env.PLAYWRIGHT_MCP_CDP_TIMEOUT;
      process.env.PLAYWRIGHT_MCP_CDP_HEADERS = 'X-Forwarded-For: 203.0.113.1, 10.0.0.1';

      const config = await resolveCLIConfig({ cdpEndpoint: 'http://127.0.0.1:9222' });

      expect(config.browser.cdpHeaders).toEqual({ 'X-Forwarded-For': '203.0.113.1, 10.0.0.1' });
    });

    it('parses newline-separated environment headers', async () => {
      delete process.env.PLAYWRIGHT_MCP_CDP_TIMEOUT;
      process.env.PLAYWRIGHT_MCP_CDP_HEADERS = 'Authorization: Bearer abc\nX-Env: prod\n';

      const config = await resolveCLIConfig({ cdpEndpoint: 'http://127.0.0.1:9222' });

      expect(config.browser.cdpHeaders).toEqual({
        'Authorization': 'Bearer abc',
        'X-Env': 'prod',
      });
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

  describe('resolveCLIConfig mobile', () => {
    const envKeys = [
      'PLAYWRIGHT_MCP_CDP_ENDPOINT',
      'PLAYWRIGHT_MCP_DEVICE',
      'PLAYWRIGHT_MCP_MOBILE',
    ];
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

    it('uses a Chromium mobile device by default', async () => {
      const config = await resolveCLIConfig({ mobile: true });

      expect(config.browser.contextOptions.isMobile).toBe(true);
      expect(config.browser.contextOptions.userAgent).toContain('Pixel 10');
    });

    it('uses a WebKit mobile device for WebKit', async () => {
      const config = await resolveCLIConfig({ mobile: true, browser: 'webkit' });

      expect(config.browser.contextOptions.isMobile).toBe(true);
      expect(config.browser.contextOptions.viewport).toEqual({ width: 402, height: 681 });
    });

    it('uses the config-file browser when selecting the mobile device', async () => {
      const configFile = await writeConfigFile({ browser: { browserName: 'webkit' } });

      const config = await resolveCLIConfig({ config: configFile, mobile: true });

      expect(config.browser.browserName).toBe('webkit');
      expect(config.browser.contextOptions.isMobile).toBe(true);
      expect(config.browser.contextOptions.userAgent).toContain('iPhone');
    });

    it('lets explicit CLI context options override the inferred mobile device', async () => {
      const config = await resolveCLIConfig({ mobile: true, viewportSize: '800,600' });

      expect(config.browser.contextOptions.isMobile).toBe(true);
      expect(config.browser.contextOptions.viewport).toEqual({ width: 800, height: 600 });
    });

    it('reads mobile emulation from the environment', async () => {
      process.env.PLAYWRIGHT_MCP_MOBILE = '1';

      const config = await resolveCLIConfig({});

      expect(config.browser.contextOptions.isMobile).toBe(true);
      expect(config.browser.contextOptions.userAgent).toContain('Pixel 10');
    });

    it('rejects mobile emulation with Firefox', async () => {
      await expect(resolveCLIConfig({ mobile: true, browser: 'firefox' }))
          .rejects.toThrow('--mobile is not supported with the Firefox browser.');
    });

    it('rejects mobile emulation with a config-file Firefox browser', async () => {
      const configFile = await writeConfigFile({ browser: { browserName: 'firefox' } });

      await expect(resolveCLIConfig({ config: configFile, mobile: true }))
          .rejects.toThrow('--mobile is not supported with the Firefox browser.');
    });

    it('rejects mobile emulation with an explicit device', async () => {
      await expect(resolveCLIConfig({ mobile: true, device: 'iPhone 15' }))
          .rejects.toThrow('Cannot use --mobile together with --device');
    });

    it('rejects mobile emulation with an environment device', async () => {
      process.env.PLAYWRIGHT_MCP_DEVICE = 'iPhone 15';

      await expect(resolveCLIConfig({ mobile: true }))
          .rejects.toThrow('Cannot use --mobile together with --device');
    });

    it('rejects mobile emulation with a merged CDP endpoint', async () => {
      process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT = 'http://127.0.0.1:9222';

      await expect(resolveCLIConfig({ mobile: true }))
          .rejects.toThrow('Mobile emulation is not supported with cdpEndpoint.');
    });

    it('rejects mobile emulation with a config-file remote endpoint', async () => {
      const configFile = await writeConfigFile({ browser: { remoteEndpoint: 'ws://127.0.0.1:3000' } });

      await expect(resolveCLIConfig({ config: configFile, mobile: true }))
          .rejects.toThrow('Mobile emulation is not supported with remoteEndpoint.');
    });

    it('rejects mobile emulation with CDP launch', async () => {
      await expect(resolveCLIConfig({ mobile: true, cdpLaunchCommand: 'echo' }))
          .rejects.toThrow('Mobile emulation is not supported with --cdp-launch-command.');
    });

    it('rejects mobile emulation with extension mode', async () => {
      await expect(resolveCLIConfig({ mobile: true, extension: true }))
          .rejects.toThrow('Mobile emulation is not supported with --extension.');
    });
  });

  describe('outputFile', () => {
    it('should generate output file path with filename', async () => {
      const config = await resolveConfig({});
      const result = await outputFile(config, 'test.txt');

      expect(result).toContain('test.txt');
    });

    it('should use outputDir when specified', async () => {
      const config = await resolveConfig({
        outputDir: '/tmp/custom/output',
      });

      const result = await outputFile(config, 'test.txt');

      expect(result).toContain('/tmp/custom/output');
      expect(result).toContain('test.txt');
    });

    it('should sanitize file paths', async () => {
      const config = await resolveConfig({});

      const result = await outputFile(config, 'test/../../../etc/passwd');

      // Should sanitize to prevent directory traversal
      expect(result).not.toContain('../');
    });

    it('keeps every artifact of one server in one fallback directory', async () => {
      // The timestamped fallback used to be recomputed per call, scattering
      // one audit's screenshots, reports, traces and session logs across a
      // different temp directory per millisecond tick.
      const config = await resolveConfig({});

      const first = await outputFile(config, 'screenshot.png');
      // Cross a millisecond tick so a recomputed timestamp would differ.
      await new Promise(resolve => setTimeout(resolve, 5));
      const second = await outputFile(config, 'report.json');

      expect(path.dirname(second)).toBe(path.dirname(first));
    });

    it('keeps one fallback directory across a config serialization boundary', async () => {
      // The VS Code integration JSON-serializes the config into a spawned
      // provider process (src/vscode/host.ts); the round-trip mints a new
      // object the WeakMap memo has never seen. Materializing the resolved
      // fallback into the serialized copy keeps the child's artifacts in the
      // parent's directory instead of a second temp root.
      const config = await resolveConfig({});
      const parentFile = await outputFile(config, 'parent.txt');

      const childConfig = JSON.parse(JSON.stringify({ ...config, outputDir: resolveOutputDir(config) }));
      await new Promise(resolve => setTimeout(resolve, 5));
      const childFile = await outputFile(childConfig, 'child.txt');

      expect(path.dirname(childFile)).toBe(path.dirname(parentFile));
    });

    it('gives two server configurations distinct fallback directories', async () => {
      // Two servers in one process must not interleave artifacts: the
      // fallback is memoized per resolved config, not process-wide.
      const first = await outputFile(await resolveConfig({}), 'file.txt');
      await new Promise(resolve => setTimeout(resolve, 5));
      const second = await outputFile(await resolveConfig({}), 'file.txt');

      expect(path.dirname(first)).not.toBe(path.dirname(second));
    });

    it('rejects a blank outputDir at resolution instead of redirecting artifacts to a temp directory', async () => {
      // An explicitly-empty outputDir must not be coerced into the omitted
      // default: the user configured a destination, and "" silently falling
      // back to the temp root would strand the artifacts they asked to keep.
      // Rejected at startup — honoring "" would only fail on mkdir('') at
      // the first artifact write, deep into a run.
      await expect(resolveConfig({ outputDir: '' })).rejects.toThrow('outputDir must not be blank');
      await expect(resolveConfig({ outputDir: '   ' })).rejects.toThrow('outputDir must not be blank');
      await expect(resolveCLIConfig({ outputDir: '' })).rejects.toThrow('outputDir must not be blank');
    });

    it('keeps the temp-directory fallback when outputDir is omitted', async () => {
      const config = await resolveConfig({});
      expect(config.outputDir).toBeUndefined();
      const result = await outputFile(config, 'artifact.txt');
      expect(path.dirname(result)).toContain('playwright-mcp-output');
    });
  });
});
