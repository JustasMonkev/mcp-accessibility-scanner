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

import type { Client } from '@modelcontextprotocol/client';

const errorsDebug = debug('pw:mcp:errors');

/**
 * Process-scoped holder for a proxy backend's switched downstream client.
 *
 * Stateless HTTP serving builds a fresh proxy backend per request and closes
 * it with the response, so a `browser_connect` switch stored only on that
 * backend would evaporate as soon as its response ended: the switch reported
 * success, yet the next handshake-free request initialized a new proxy on the
 * default provider again. This slot hoists the switched client — and the live
 * connection behind it (in-process backend or spawned child) — to the server
 * factory's scope: per-request backends adopt whatever the slot holds at
 * initialize() and must not close an adopted client with their response.
 *
 * Adoptions are leased: acquire() hands out the published client with its
 * adopter count raised, and release() lowers it when the adopting request is
 * done with the client (its response closed, or it switched away). A
 * replace() that retires a client whose count has not drained defers the
 * close to the last release — a request mid-listTools/callTool on the old
 * client must finish on a live transport, not fail because a sibling request
 * switched providers underneath it.
 *
 * replace() serializes switches: the next client is fully connected before it
 * is published, and the previously published client is closed exactly once —
 * only after the swap, and only once every adopter has released it — so a
 * concurrent request reading the slot observes either the old client still
 * live or the new one ready, never a half-open one. A failed connect leaves
 * the previous selection in place.
 */
export class SharedClientSlot {
  private _current: Client | undefined;
  private _chain: Promise<unknown> = Promise.resolve();
  // Adopter count and retirement flag per client this slot has published. An
  // entry leaves the map exactly when its client is closed (drained after
  // retirement, closed inline by replace(), or swept by dispose()), so a
  // straggling release can never double-close.
  private _leases = new Map<Client, { count: number, retired: boolean }>();

  /**
   * Adopts the process-scoped switched client for one request, raising its
   * adopter count; undefined while the default (per-request) provider is
   * selected. Every acquired client must be released exactly once — on
   * serverClosed(), or earlier when the request switches away from it.
   */
  acquire(): Client | undefined {
    if (!this._current)
      return undefined;
    const lease = this._leases.get(this._current);
    if (lease)
      lease.count++;
    return this._current;
  }

  /**
   * Releases one adoption of `client`. When the client has been retired by a
   * replace() and this was its last adopter, the deferred close runs now; the
   * returned promise settles once that close (if any) has finished. Unknown
   * or already-closed clients are ignored.
   */
  async release(client: Client): Promise<void> {
    const lease = this._leases.get(client);
    if (!lease)
      return;
    lease.count = Math.max(0, lease.count - 1);
    if (lease.retired && lease.count === 0) {
      this._leases.delete(client);
      await client.close().catch(errorsDebug);
    }
  }

  /**
   * Switches the slot to the client produced by `connect`, or back to the
   * default selection (no shared client) when `connect` is undefined.
   * Returns the newly published client — already carrying one adopter lease
   * for the caller, so no concurrent replace can close it before the caller
   * registers as its user — or undefined for the default selection.
   */
  async replace(connect: (() => Promise<Client>) | undefined): Promise<Client | undefined> {
    const result = this._chain.then(async () => {
      const next = connect ? await connect() : undefined;
      const previous = this._current;
      this._current = next;
      if (next)
        this._leases.set(next, { count: 1, retired: false });
      if (previous) {
        const lease = this._leases.get(previous);
        if (lease && lease.count > 0) {
          // An in-flight request still routes through the outgoing client;
          // the last release closes it.
          lease.retired = true;
        } else {
          this._leases.delete(previous);
          await previous.close().catch(errorsDebug);
        }
      }
      return next;
    });
    // A rejected switch (failed connect) must not poison later switches.
    this._chain = result.catch(() => {});
    return await result;
  }

  /**
   * Process-shutdown cleanup: closes the published client and any retired
   * clients still draining, WITHOUT waiting for their adopters — no request
   * outlives the process, and waiting on a lease a hung request will never
   * release would stall shutdown forever. Serialized behind in-flight
   * switches so a client mid-connect is not orphaned half-open. Leases are
   * swept before the closes, so a straggling release stays a no-op.
   */
  async dispose(): Promise<void> {
    const result = this._chain.then(async () => {
      const clients = [...this._leases.keys()];
      this._leases.clear();
      this._current = undefined;
      await Promise.all(clients.map(client => client.close().catch(errorsDebug)));
    });
    this._chain = result.catch(() => {});
    return await result;
  }
}
