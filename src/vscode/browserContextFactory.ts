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

import { assertReusedContextStorageStateSupported, assertStorageStateDoesNotResetUserProfile } from '../browserContextFactory.js';
import type { BrowserContextFactory, ClientInfo } from '../browserContextFactory.js';
import type { FullConfig } from '../config.js';
import type { BrowserContext } from 'playwright-core';
import { validateBrowserConnectConnectionString } from './validation.js';

export const vscodeProfileConflictRemedy = 'Drop --storage-state and sign in in the profile, or use a fresh isolated browser outside the VS Code provider.';

export class VSCodeBrowserContextFactory implements BrowserContextFactory {
  name = 'vscode';
  description = 'Connect to a browser running in the Playwright VS Code extension';
  readonly sharedContext = true;
  readonly appliesStorageState = true;
  readonly sessionsUnsupportedReason = 'the VS Code extension supplies the browser\'s existing context, which every session would share (same tabs, cookies and storage).';

  constructor(private _config: FullConfig, private _playwright: typeof import('playwright'), private _connectionString: string) {}

  async createContext(clientInfo: ClientInfo, abortSignal: AbortSignal): Promise<{ browserContext: BrowserContext; close: () => Promise<void>; }> {
    assertStorageStateDoesNotResetUserProfile(this._config, vscodeProfileConflictRemedy);
    let launchOptions: Record<string, unknown> = { ...this._config.browser.launchOptions };
    if (this._config.browser.chromiumSandboxDefaulted)
      delete launchOptions.chromiumSandbox;
    if (this._config.browser.userDataDir) {
      launchOptions = {
        ...launchOptions,
        ...this._config.browser.contextOptions,
        userDataDir: this._config.browser.userDataDir,
      };
    }
    const connectionError = validateBrowserConnectConnectionString(this._connectionString);
    if (connectionError)
      throw new Error(connectionError);
    const connectionString = new URL(this._connectionString);
    connectionString.searchParams.set('launch-options', JSON.stringify(launchOptions));

    const browserType = this._playwright.chromium;
    const browser = await browserType.connect(connectionString.toString());

    let context: BrowserContext;
    try {
      const existing = browser.contexts()[0];
      if (existing) {
        assertReusedContextStorageStateSupported(this._config);
        context = existing;
      } else {
        context = await browser.newContext(this._config.browser.contextOptions);
      }
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }

    return {
      browserContext: context,
      close: async () => {
        await browser.close();
      }
    };
  }
}
