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

// One installation per context, shared by every caller: the storage-state
// reuse path installs the policy before it reloads pages (Context has not run
// yet), Context ensures it afterwards, and sibling sessions sharing a reused
// context must not stack duplicate handlers. Keyed weakly on the context
// object, and by promise so concurrent callers await one installation instead
// of racing two; a failed installation is forgotten so the next caller
// retries. The policy is identical for every caller — it comes from the
// server-wide config — so "already installed" can never mean "installed with
// different rules".
const policyInstallations = new WeakMap<playwright.BrowserContext, Promise<void>>();

/**
 * Installs the configured origin allowlist/blocklist as routes on the
 * context, once — later calls (and concurrent ones) join the first. The
 * handlers stay for the context's lifetime: they are never uninstalled, so
 * there is no window between a temporary installation coming off and the
 * permanent one going in during which a queued request could reach a blocked
 * origin, and a sibling session's view of the shared context never loses its
 * protection.
 */
export function ensureNetworkPolicyRoutes(config: FullConfig, context: playwright.BrowserContext): Promise<void> {
  let installation = policyInstallations.get(context);
  if (!installation) {
    installation = installRoutes(config, context);
    policyInstallations.set(context, installation);
    installation.catch(() => policyInstallations.delete(context));
  }
  return installation;
}

async function installRoutes(config: FullConfig, context: playwright.BrowserContext): Promise<void> {
  const installed: { pattern: string, handler: RouteHandler }[] = [];
  const register = async (pattern: string, handler: RouteHandler) => {
    await context.route(pattern, handler);
    installed.push({ pattern, handler });
  };
  try {
    if (config.network?.allowedOrigins?.length) {
      await register('**', route => route.abort('blockedbyclient'));
      for (const origin of config.network.allowedOrigins)
        await register(`*://${origin}/**`, route => route.continue());
    }
    if (config.network?.blockedOrigins?.length) {
      for (const origin of config.network.blockedOrigins)
        await register(`*://${origin}/**`, route => route.abort('blockedbyclient'));
    }
  } catch (error) {
    // A partial policy is worse than none: with the allowlist's abort-all
    // route in but its continue routes missing, everything is blocked — and
    // on a reused context the fragment would linger for whoever uses the
    // context next. Unwind exactly what was registered (never more — a
    // sibling session may have its own handlers) before surfacing the
    // failure.
    for (const { pattern, handler } of installed)
      await context.unroute(pattern, handler).catch(() => {});
    throw error;
  }
}
