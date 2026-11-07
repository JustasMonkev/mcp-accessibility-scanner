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
import { createConnection } from '../src/index.js';

it.each(['launch', 'context'])('accepts a custom context getter with Firefox certificates and a %s proxy', async level => {
  const proxy = { server: 'http://fixture-proxy.test:3128' };
  const clientCertificates = [{ origin: 'https://fixture.test', certPath: '/fixture.crt', keyPath: '/fixture.key' }];
  const contextGetter = vi.fn(async () => { throw new Error('Context getter must remain lazy'); });
  const server = await createConnection({ browser: {
    browserName: 'firefox',
    launchOptions: level === 'launch' ? { proxy } : {},
    contextOptions: { clientCertificates, ...(level === 'context' && { proxy }) },
  } }, contextGetter);
  try {
    expect(contextGetter).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
  expect(contextGetter).not.toHaveBeenCalled();
});
