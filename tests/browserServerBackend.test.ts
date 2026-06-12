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

import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { resolveConfig } from '../src/config.js';

const unusedFactory = {
  createContext: async () => {
    throw new Error('browser should not be launched in this test');
  },
} as any;

describe('BrowserServerBackend.callTool', () => {
  it('rejects unknown tools with an InvalidParams protocol error', async () => {
    const config = await resolveConfig({});
    const backend = new BrowserServerBackend(config, unusedFactory);
    await expect(backend.callTool('does_not_exist', {}))
        .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('reports invalid tool input as a readable execution error', async () => {
    const config = await resolveConfig({});
    const backend = new BrowserServerBackend(config, unusedFactory);
    await expect(backend.callTool('browser_navigate', { url: 123 }))
        .rejects.toThrow(/Invalid input for tool "browser_navigate"/);
  });
});
