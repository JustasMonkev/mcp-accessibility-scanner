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

import debug from 'debug';
import * as playwright from 'playwright';
import { startHttpServer } from '../mcp/http.js';
import { CDPRelayServer } from './cdpRelay.js';

import type { ExtensionBrowserOptions } from './cdpRelay.js';
import type { BrowserContextFactory, ClientInfo, ContextHandle } from '../browserContextFactory.js';

const debugLogger = debug('pw:mcp:relay');

export class ExtensionContextFactory implements BrowserContextFactory {
  readonly sharedContext = true;
  get attachNeedsUser(): boolean {
    return !process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  }
  readonly appliesStorageState = false;
  readonly sessionsUnsupportedReason = '--extension works through the browser you are already running and uses its existing context, which every session would share (same tabs, cookies and storage).';
  private readonly _browser: ExtensionBrowserOptions;

  constructor(browser: ExtensionBrowserOptions) {
    this._browser = browser;
  }

  async createContext(clientInfo: ClientInfo, abortSignal: AbortSignal, toolName: string | undefined): Promise<ContextHandle> {
    const browser = await this._obtainBrowser(clientInfo, abortSignal, toolName);
    return {
      browserContext: browser.contexts()[0],
      close: async () => {
        debugLogger('close() called for browser context');
        await browser.close();
      }
    };
  }

  private async _obtainBrowser(clientInfo: ClientInfo, abortSignal: AbortSignal, toolName: string | undefined): Promise<playwright.Browser> {
    const relay = await this._startRelay(abortSignal);
    try {
      await relay.ensureExtensionConnectionForMCPContext(clientInfo, abortSignal, toolName);
      const browser = await playwright.chromium.connectOverCDP(relay.cdpEndpoint());
      browser.on('disconnected', () => relay.stop());
      return browser;
    } catch (error) {
      relay.stop();
      throw error;
    }
  }

  private async _startRelay(abortSignal: AbortSignal) {
    const httpServer = await startHttpServer({});
    if (abortSignal.aborted) {
      httpServer.close();
      throw new Error(abortSignal.reason);
    }
    const cdpRelayServer = new CDPRelayServer(httpServer, this._browser);
    const stop = () => cdpRelayServer.stop();
    abortSignal.addEventListener('abort', stop, { once: true });
    httpServer.once('close', () => abortSignal.removeEventListener('abort', stop));
    debugLogger(`CDP relay server started, extension endpoint: ${cdpRelayServer.extensionEndpoint()}.`);
    return cdpRelayServer;
  }
}
