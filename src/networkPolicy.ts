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

type RouteHandler = (route: playwright.Route) => void;

/**
 * Installs the configured origin allowlist/blocklist as routes on the context.
 * The single source of the policy's route shape: Context installs it after the
 * factory returns, and the storage-state reuse path mirrors it for the page
 * reloads it performs before that — two hand-maintained copies would drift.
 * Returns an uninstaller that removes exactly the handlers this call added
 * (or null when the config carries no policy). Sessions can share a reused
 * context — and with it, another session's identical long-lived policy routes
 * — so a temporary installation must never remove more than its own handlers:
 * unrouteAll() would strip the sibling's protection along with the temporary
 * routes.
 */
export async function installNetworkPolicyRoutes(config: FullConfig, context: playwright.BrowserContext): Promise<(() => Promise<void>) | null> {
  const installed: { pattern: string, handler: RouteHandler }[] = [];
  const register = async (pattern: string, handler: RouteHandler) => {
    await context.route(pattern, handler);
    installed.push({ pattern, handler });
  };
  if (config.network?.allowedOrigins?.length) {
    await register('**', route => route.abort('blockedbyclient'));
    for (const origin of config.network.allowedOrigins)
      await register(`*://${origin}/**`, route => route.continue());
  }
  if (config.network?.blockedOrigins?.length) {
    for (const origin of config.network.blockedOrigins)
      await register(`*://${origin}/**`, route => route.abort('blockedbyclient'));
  }
  if (!installed.length)
    return null;
  return async () => {
    for (const { pattern, handler } of installed)
      await context.unroute(pattern, handler).catch(() => {});
  };
}
