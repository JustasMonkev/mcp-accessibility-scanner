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
import { installNetworkPolicyRoutes } from '../src/networkPolicy.js';
import type { FullConfig } from '../src/config.js';

function createMockContext() {
  return {
    route: vi.fn().mockResolvedValue(undefined),
    unroute: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('installNetworkPolicyRoutes', () => {
  it('returns null and touches nothing when no policy is configured', async () => {
    const context = createMockContext();

    const uninstall = await installNetworkPolicyRoutes({ network: undefined } as FullConfig, context);

    expect(uninstall).toBeNull();
    expect(context.route).not.toHaveBeenCalled();
  });

  it('unwinds already-registered handlers when a later registration fails', async () => {
    // With the allowlist's abort-all route in but its continue routes missing,
    // everything is blocked — and on a reused context the fragment would
    // linger for whoever uses the context next.
    const context = createMockContext();
    context.route
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Route registration failed'));
    const config = { network: { allowedOrigins: ['app.example'] } } as FullConfig;

    await expect(installNetworkPolicyRoutes(config, context)).rejects.toThrow('Route registration failed');

    expect(context.unroute).toHaveBeenCalledTimes(1);
    expect(context.unroute).toHaveBeenCalledWith('**', context.route.mock.calls[0][1]);
  });

  it('returns an uninstaller that removes exactly the handlers it registered', async () => {
    const context = createMockContext();
    const config = { network: { allowedOrigins: ['app.example'], blockedOrigins: ['tracker.example'] } } as FullConfig;

    const uninstall = await installNetworkPolicyRoutes(config, context);
    expect(uninstall).not.toBeNull();
    expect(context.route.mock.calls.map((call: any[]) => call[0]))
        .toEqual(['**', '*://app.example/**', '*://tracker.example/**']);

    await uninstall!();

    expect(context.unroute.mock.calls).toEqual(context.route.mock.calls);
  });
});
