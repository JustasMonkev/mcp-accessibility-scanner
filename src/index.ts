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

import { BrowserServerBackend } from './browserServerBackend.js';
import { resolveConfig } from './config.js';
import { contextFactory } from './browserContextFactory.js';
import * as mcpServer from './mcp/server.js';
import { serverInstructions } from './tools.js';
import { packageJSON } from './utils/package.js';

import type { Config } from '../config.js';
import type { BrowserContext } from 'playwright';
import type { BrowserContextFactory } from './browserContextFactory.js';
import type { Server } from '@modelcontextprotocol/server';

export async function createConnection(userConfig: Config = {}, contextGetter?: () => Promise<BrowserContext>): Promise<Server> {
  if (userConfig.browser?.profileDirName)
    throw new Error('browser.profileDirName is only applied by the CLI\'s extension mode (--extension or --connect-tool); createConnection launches no extension relay to consume it. Remove the field.');
  const config = await resolveConfig(userConfig);
  const factory = contextGetter ? new SimpleBrowserContextFactory(contextGetter) : contextFactory(config);
  return mcpServer.createServer('Playwright', packageJSON.version, new BrowserServerBackend(config, factory), false, { title: 'Accessibility Scanner', instructions: serverInstructions });
}

class SimpleBrowserContextFactory implements BrowserContextFactory {
  name = 'custom';
  description = 'Connect to a browser using a custom context getter';
  // The getter is caller-supplied and typically hands back one long-lived
  // context; nothing guarantees a separate context per call, so explicit
  // browser sessions cannot promise separation here.
  readonly sessionsUnsupportedReason = 'this server was created with a custom browser context getter, which supplies a single browser context that every session would share.';

  private readonly _contextGetter: () => Promise<BrowserContext>;

  constructor(contextGetter: () => Promise<BrowserContext>) {
    this._contextGetter = contextGetter;
  }

  async createContext(): Promise<{ browserContext: BrowserContext, close: () => Promise<void> }> {
    const browserContext = await this._contextGetter();
    return {
      browserContext,
      close: () => browserContext.close()
    };
  }
}
