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

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { contextFactory } from '../src/browserContextFactory.js';
import { resolveConfig } from '../src/config.js';
import { Context } from '../src/context.js';
import { ProxyBackend } from '../src/mcp/proxyBackend.js';
import { wrapInProcess } from '../src/mcp/server.js';
import { VSCodeProxyBackend } from '../src/vscode/host.js';

it.each(['direct', 'connect-tool', 'vscode'])('releases cancelled time and text waits through %s MCP routing', async mode => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-wait-cancel-'));
  const config = await resolveConfig({
    browser: { isolated: true, launchOptions: { channel: 'chromium', headless: true } },
    outputDir: directory,
    timeouts: { settle: 0 },
  });
  const browserBackend = new BrowserServerBackend(config, contextFactory(config));
  const connect = () => wrapInProcess(browserBackend);
  const backend = mode === 'direct' ? browserBackend
    : mode === 'connect-tool' ? new ProxyBackend([{ name: 'default', description: 'Default', connect }])
      : new VSCodeProxyBackend(config, connect);
  const client = new Client({ name: 'wait-cancellation-test', version: '1' });
  try {
    await client.connect(await wrapInProcess(backend));
    for (const conditions of [{ time: 5 }, { time: 5, text: 'Ready', textGone: 'Loading' }]) {
      const opened = await client.callTool({ name: 'browser_session_open', arguments: {} });
      const browserSessionId = opened.structuredContent?.browserSessionId;
      expect(typeof browserSessionId).toBe('string');
      const navigate = await client.callTool({ name: 'browser_navigate', arguments: {
        browserSessionId, url: 'data:text/html,<p>Loading</p>',
      } });
      expect(navigate.isError).not.toBe(true);
      const controller = new AbortController();
      const pending = client.callTool({ name: 'browser_wait_for', arguments: { browserSessionId, ...conditions } }, { signal: controller.signal })
          .then(() => undefined, error => error);
      const busy = await client.callTool({ name: 'browser_session_close', arguments: { browserSessionId } });
      expect(JSON.stringify(busy.content)).toContain('still has a tool call running');
      controller.abort(new Error('Cancelled by caller'));
      expect(await pending).toBeInstanceOf(Error);
      await expect.poll(async () => {
        const closed = await client.callTool({ name: 'browser_session_close', arguments: { browserSessionId } });
        return closed.isError === true;
      }, { timeout: 2000 }).toBe(false);
    }
  } finally {
    await client.close();
    backend.serverClosed();
    await Context.disposeAll();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
