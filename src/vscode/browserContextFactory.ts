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

import { applyStorageStateToReusedContext, assertStorageStateDoesNotResetUserProfile } from '../browserContextFactory.js';
import type { BrowserContextFactory, ClientInfo } from '../browserContextFactory.js';
import type { FullConfig } from '../config.js';
import type { BrowserContext } from 'playwright-core';

// Shared with the host's browser_connect validation so the two never drift:
// the host checks the combination before tearing down the working provider,
// and the factory keeps the same check as the last line of defense.
export const vscodeProfileConflictRemedy = 'Drop --user-data-dir (the state is applied inside the extension\'s own browser profile), or drop the storage state and sign in in that profile instead.';

export class VSCodeBrowserContextFactory implements BrowserContextFactory {
  name = 'vscode';
  description = 'Connect to a browser running in the Playwright VS Code extension';
  // A fresh context is created with the state; a reused extension context gets
  // it applied via setStorageState(), like the other reused-context factories.
  readonly appliesStorageState = true;
  // Each createContext() reuses the extension browser's existing context when
  // one is present, so two sessions would end up in the same context (same
  // tabs, cookies and storage) — never a separate one per handle.
  readonly sessionsUnsupportedReason = 'the VS Code extension supplies the browser\'s existing context, which every session would share (same tabs, cookies and storage).';

  constructor(private _config: FullConfig, private _playwright: typeof import('playwright'), private _connectionString: string) {}

  async createContext(clientInfo: ClientInfo, abortSignal: AbortSignal): Promise<{ browserContext: BrowserContext; close: () => Promise<void>; }> {
    // A configured --user-data-dir is forwarded to the extension's launch
    // below, so the context the extension hands back lives inside the user's
    // own profile — applying the storage state there would clear that
    // profile's cookies and origin storage, which the persistent factory
    // already refuses to do. Checked before connecting, so the contradiction
    // fails fast without ever reaching the browser.
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
    const connectionString = new URL(this._connectionString);
    connectionString.searchParams.set('launch-options', JSON.stringify(launchOptions));

    const browserType = this._playwright.chromium; // it could also be firefox or webkit, we just need some browser type to call `connect` on
    const browser = await browserType.connect(connectionString.toString());

    let context: BrowserContext;
    try {
      const existing = browser.contexts()[0];
      if (existing) {
        // Without this, a configured storage state would be silently ignored on
        // the reuse path while newContext() below applies it — authenticated
        // scans would run anonymously depending on which branch was taken.
        await applyStorageStateToReusedContext(this._config, existing);
        context = existing;
      } else {
        context = await browser.newContext(this._config.browser.contextOptions);
      }
    } catch (error) {
      // No close() has been handed out yet, so the connection must not outlive
      // the failure (e.g. an unreadable storage-state file).
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
