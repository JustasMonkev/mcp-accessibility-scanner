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

import coreBundle from 'playwright-core/lib/coreBundle';
import type { Browser, BrowserContext, CDPSession } from 'playwright';
import type { FullConfig } from './config.js';

const policyInstallations = new WeakMap<BrowserContext, Promise<void>>();
const browserPolicies = new WeakMap<Browser, Promise<CDPSession>>();

export function assertNetworkPolicySupported(config: FullConfig, ownsBrowser = true): void {
  if (!hasNetworkPolicy(config))
    return;
  if (config.browser.browserName !== 'chromium' || !ownsBrowser || config.browser.cdpEndpoint || config.browser.cdpLaunch || config.browser.remoteEndpoint)
    throw new Error('Origin restrictions require a locally launched Chromium browser. Restricted Firefox/WebKit, CDP, remote, extension, VS Code and custom-context connections are unsupported; no network policy was installed on the external browser.');
}

function hasNetworkPolicy(config: FullConfig): boolean {
  return !!(config.network?.allowedOrigins?.length || config.network?.blockedOrigins?.length);
}

function isAllowed(config: FullConfig, url: string): boolean {
  const matches = (origin: string) => coreBundle.iso.urlMatches(undefined, url, `*://${origin}/**`);
  return !config.network.blockedOrigins?.some(matches) && (!config.network.allowedOrigins?.length || config.network.allowedOrigins.some(matches));
}

export function ensureNetworkPolicyRoutes(config: FullConfig, context: BrowserContext): Promise<void> {
  if (!hasNetworkPolicy(config))
    return Promise.resolve();
  let installation = policyInstallations.get(context);
  if (!installation) {
    installation = installPolicy(config, context);
    policyInstallations.set(context, installation);
    installation.catch(() => policyInstallations.delete(context));
  }
  return installation;
}

async function installPolicy(config: FullConfig, context: BrowserContext): Promise<void> {
  assertNetworkPolicySupported(config);
  const browser = context.browser();
  if (!browser || browser.browserType().name() !== 'chromium')
    throw new Error('Origin restrictions require a locally launched Chromium browser.');
  let installation = browserPolicies.get(browser);
  if (!installation) {
    installation = installBrowserPolicy(config, browser);
    browserPolicies.set(browser, installation);
    installation.catch(() => browserPolicies.delete(browser));
  }
  await installation;
  await context.routeWebSocket('**', async socket => {
    if (isAllowed(config, socket.url()))
      socket.connectToServer();
    else
      await socket.close({ code: 1008, reason: 'Blocked by origin policy' });
  });
}

async function installBrowserPolicy(config: FullConfig, browser: Browser): Promise<CDPSession> {
  const session = await browser.newBrowserCDPSession();
  session.on('Fetch.requestPaused', event => {
    const command = isAllowed(config, event.request.url)
      ? session.send('Fetch.continueRequest', { requestId: event.requestId })
      : session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
    void command.catch(() => {});
  });
  try {
    await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    return session;
  } catch (error) {
    await session.detach().catch(() => {});
    throw error;
  }
}
