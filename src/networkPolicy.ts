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

import type * as playwright from 'playwright';
import type { FullConfig } from './config.js';

/**
 * Installs the configured origin allowlist/blocklist as routes on the context.
 * The single source of the policy's route shape: Context installs it after the
 * factory returns, and the storage-state reuse path mirrors it for the page
 * reloads it performs before that — two hand-maintained copies would drift.
 * Returns whether any route was installed, so a caller that installs the
 * policy temporarily knows whether there is anything to remove.
 */
export async function installNetworkPolicyRoutes(config: FullConfig, context: playwright.BrowserContext): Promise<boolean> {
  let installed = false;
  if (config.network?.allowedOrigins?.length) {
    await context.route('**', route => route.abort('blockedbyclient'));
    for (const origin of config.network.allowedOrigins)
      await context.route(`*://${origin}/**`, route => route.continue());
    installed = true;
  }
  if (config.network?.blockedOrigins?.length) {
    for (const origin of config.network.blockedOrigins)
      await context.route(`*://${origin}/**`, route => route.abort('blockedbyclient'));
    installed = true;
  }
  return installed;
}
