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

import { Client } from '@modelcontextprotocol/client';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { createConnection } from '../src/index.js';
import { InProcessTransport } from '../src/mcp/inProcessTransport.js';

it.each(['browser_close', 'disconnect'] as const)('releases a supplied context on %s without closing its browser or sibling context (#296)', async action => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const sibling = await browser.newContext();
    const siblingPage = await sibling.newPage();
    let contextClosed = false;
    context.on('close', () => contextClosed = true);
    const server = await createConnection({}, async () => context);
    const client = new Client({ name: 'context-ownership-test', version: '1' });
    try {
      await siblingPage.setContent('<h1>Independent sibling</h1>');
      await client.connect(new InProcessTransport(server));
      const navigation = await client.callTool({ name: 'browser_navigate', arguments: { url: 'data:text/html,<h1>Supplied context</h1>' } });
      expect(navigation.isError).not.toBe(true);
      if (action === 'browser_close')
        await client.callTool({ name: 'browser_close', arguments: {} });
      else
        await client.close();
      await expect.poll(() => contextClosed).toBe(true);
      expect(browser.isConnected()).toBe(true);
      expect(await siblingPage.locator('h1').textContent()).toBe('Independent sibling');
    } finally {
      const cleanup = await Promise.allSettled([client.close(), server.close()]);
      for (const result of cleanup) {
        if (result.status === 'rejected')
          throw result.reason;
      }
    }
  } finally {
    await browser.close();
  }
});
