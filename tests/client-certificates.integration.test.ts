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

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { contextFactory } from '../src/browserContextFactory.js';
import { resolveConfig } from '../src/config.js';
import { runClientCertificateProxyProbe } from './client-certificate-proxy-probe.mjs';

const browserName = process.env.MCP_TEST_BROWSER_NAME || 'chromium';
if (!['chromium', 'firefox'].includes(browserName))
  throw new Error(`MCP_TEST_BROWSER_NAME must be chromium or firefox for this loopback certificate fixture; got ${JSON.stringify(browserName)}`);
const canRun = !!process.env.MCP_TEST_BROWSER_NAME || existsSync(chromium.executablePath());
const require = createRequire(import.meta.url);

afterEach(() => vi.unstubAllEnvs());

it.skipIf(!canRun)(`preserves mTLS and proxy routing or rejects unsupported persistent Firefox (${browserName}) #235`, async () => {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'])
    vi.stubEnv(key, undefined);
  const results = await runClientCertificateProxyProbe({ contextFactory, resolveConfig, browserName });
  process.stdout.write(JSON.stringify({
    node: process.version, platform: process.platform,
    playwright: require('playwright/package.json').version,
    playwrightCore: require('playwright-core/package.json').version,
    results,
  }) + '\n');
  expect(results.filter(result => 'clientCertificateVerified' in result)).toHaveLength(browserName === 'firefox' ? 13 : 16);
}, 120_000);
