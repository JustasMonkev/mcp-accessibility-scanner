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

import { describe, expect, it, vi } from 'vitest';
import { ensureNetworkPolicyRoutes } from '../src/networkPolicy.js';
import type { FullConfig } from '../src/config.js';

function createMockContext() {
  return {
    route: vi.fn().mockResolvedValue(undefined),
    unroute: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('ensureNetworkPolicyRoutes', () => {
  it('touches nothing when no policy is configured', async () => {
    const context = createMockContext();

    await ensureNetworkPolicyRoutes({ network: undefined } as FullConfig, context);

    expect(context.route).not.toHaveBeenCalled();
  });

  it('installs the policy once per context, permanently', async () => {
    // The factory ensures the policy before its storage-state reloads and
    // Context ensures it again afterwards; the handlers must go in exactly
    // once and never come off — an uninstall between the two would leave a
    // window for a queued page request to reach a blocked origin.
    const context = createMockContext();
    const config = { network: { allowedOrigins: ['app.example'], blockedOrigins: ['tracker.example'] } } as FullConfig;

    await ensureNetworkPolicyRoutes(config, context);
    await ensureNetworkPolicyRoutes(config, context);

    expect(context.route.mock.calls.map((call: any[]) => call[0]))
        .toEqual(['**', '*://app.example/**', '*://tracker.example/**']);
    expect(context.unroute).not.toHaveBeenCalled();
  });

  it('shares one installation between concurrent callers', async () => {
    const context = createMockContext();
    const config = { network: { blockedOrigins: ['tracker.example'] } } as FullConfig;

    await Promise.all([
      ensureNetworkPolicyRoutes(config, context),
      ensureNetworkPolicyRoutes(config, context),
    ]);

    expect(context.route).toHaveBeenCalledTimes(1);
  });

  it('unwinds already-registered handlers when a later registration fails, and retries next time', async () => {
    // With the allowlist's abort-all route in but its continue routes missing,
    // everything is blocked — and on a reused context the fragment would
    // linger for whoever uses the context next.
    const context = createMockContext();
    context.route
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Route registration failed'))
        .mockResolvedValue(undefined);
    const config = { network: { allowedOrigins: ['app.example'] } } as FullConfig;

    await expect(ensureNetworkPolicyRoutes(config, context)).rejects.toThrow('Route registration failed');
    expect(context.unroute).toHaveBeenCalledTimes(1);
    expect(context.unroute).toHaveBeenCalledWith('**', context.route.mock.calls[0][1]);

    // The failed installation is forgotten, so the next caller gets a fresh
    // attempt rather than joining a rejected promise forever.
    await ensureNetworkPolicyRoutes(config, context);
    expect(context.route).toHaveBeenCalledTimes(4);
  });
});
