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

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as mcpServer from '../mcp/server.js';
import { BrowserServerBackend } from '../browserServerBackend.js';
import { VSCodeBrowserContextFactory } from './browserContextFactory.js';
import type { FullConfig } from '../config.js';

async function main(config: FullConfig, connectionString: string, lib: string) {
  const playwright = await import(lib).then(mod => mod.default ?? mod);
  const factory = new VSCodeBrowserContextFactory(config, playwright, connectionString);
  await mcpServer.connect(
      {
        name: 'Playwright MCP',
        nameInConfig: 'playwright-vscode',
        create: () => new BrowserServerBackend(config, factory),
        version: 'unused'
      },
      new StdioServerTransport(),
      false
  );
}

await main(
    JSON.parse(process.argv[2]),
    process.argv[3],
    process.argv[4]
);
