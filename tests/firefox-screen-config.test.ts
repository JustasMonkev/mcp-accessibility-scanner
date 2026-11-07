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

import { expect, it, vi } from 'vitest';
import { contextFactory } from '../src/browserContextFactory.js';
import { resolveCLIConfig, resolveConfig } from '../src/config.js';
import { createConnection } from '../src/index.js';

const mobileOptions = { isMobile: true, viewport: { width: 393, height: 659 }, screen: { width: 393, height: 852 }, deviceScaleFactor: 3 };

it.each([
  { isolated: true, screen: { width: 393, height: 852 } },
  { isolated: false, screen: { width: 393, height: 852 } },
  { isolated: true, screen: { width: 394, height: 659 } },
  { isolated: false, screen: { width: 394, height: 659 } },
])('rejects differing local Firefox mobile screen dimensions before launch (%j)', async ({ isolated, screen }) => {
  const config = await resolveConfig({ browser: { browserName: 'firefox', isolated, contextOptions: { ...mobileOptions, screen } } });
  expect(() => contextFactory(config)).toThrow(/Firefox 159.*mobile.*screen.*viewport.*Chromium.*WebKit.*No browser was started/);
  expect(config.browser.contextOptions).toMatchObject({ ...mobileOptions, screen });
});

it('rejects the effective iPhone descriptor selected through CLI configuration', async () => {
  const config = await resolveCLIConfig({ browser: 'firefox', device: 'iPhone 15', isolated: true });
  expect(config.browser.contextOptions).toMatchObject(mobileOptions);
  expect(() => contextFactory(config)).toThrow(/Firefox 159.*mobile.*screen/);
});

it.each([
  { name: 'desktop', options: { ...mobileOptions, isMobile: false } },
  { name: 'default desktop mode', options: { ...mobileOptions, isMobile: undefined } },
  { name: 'equal mobile screen and viewport', options: { ...mobileOptions, screen: mobileOptions.viewport } },
  { name: 'implicit mobile screen', options: { ...mobileOptions, screen: undefined } },
])('preserves Firefox $name configurations', async ({ options }) => {
  const config = await resolveConfig({ browser: { browserName: 'firefox', isolated: true, contextOptions: options } });
  expect(() => contextFactory(config)).not.toThrow();
  expect(config.browser.contextOptions.isMobile).toBe(options.isMobile);
});

it.each(['chromium', 'webkit'] as const)('preserves distinct mobile screen dimensions for %s', async browserName => {
  const config = await resolveConfig({ browser: { browserName, isolated: true, contextOptions: mobileOptions } });
  expect(() => contextFactory(config)).not.toThrow();
  expect(config.browser.contextOptions).toMatchObject(mobileOptions);
});

it.each([
  { remoteEndpoint: 'ws://fixture.test' },
  { cdpEndpoint: 'http://127.0.0.1:9222' },
  { cdpLaunch: { command: process.execPath, args: ['fixture.js'] } },
])('does not apply a local screen restriction to an external provider (%j)', async connection => {
  const config = await resolveConfig({ browser: { browserName: 'firefox', ...connection, contextOptions: mobileOptions } });
  expect(() => contextFactory(config)).not.toThrow();
});

it('preserves a supplied context getter without applying local mobile screen restrictions', async () => {
  const contextGetter = vi.fn(async () => { throw new Error('Context getter must remain lazy'); });
  const server = await createConnection({ browser: { browserName: 'firefox', contextOptions: mobileOptions } }, contextGetter);
  try {
    expect(contextGetter).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
  expect(contextGetter).not.toHaveBeenCalled();
});
