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

import { describe, expect, it, vi } from 'vitest';
import { ProxyBackend } from '../src/mcp/proxyBackend.js';

describe('ProxyBackend', () => {
  it('forwards progress metadata to downstream tool calls', async () => {
    const backend = new ProxyBackend([{
      name: 'default',
      description: 'Default provider',
      connect: vi.fn(),
    } as any]);

    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: '### Result\nok' }],
    }));
    (backend as any)._currentClient = { callTool };

    await backend.callTool('audit_site', { startUrl: 'https://example.com' }, {
      _meta: { progressToken: 'progress-123' },
    } as any);

    expect(callTool).toHaveBeenCalledWith({
      name: 'audit_site',
      arguments: { startUrl: 'https://example.com' },
      _meta: { progressToken: 'progress-123' },
    });
  });
});
