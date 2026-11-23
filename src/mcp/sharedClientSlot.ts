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

import { logUnhandledError } from '../utils/log.js';

import type { Client } from '@modelcontextprotocol/client';

export class SharedClientSlot {
  private _current: Client | undefined;
  private _chain: Promise<unknown> = Promise.resolve();
  private _leases = new Map<Client, { count: number, retired: boolean }>();

  acquire(): Client | undefined {
    if (!this._current)
      return undefined;
    const lease = this._leases.get(this._current);
    if (lease)
      lease.count++;
    return this._current;
  }

  async release(client: Client): Promise<void> {
    const lease = this._leases.get(client);
    if (!lease)
      return;
    lease.count = Math.max(0, lease.count - 1);
    if (lease.retired && lease.count === 0) {
      this._leases.delete(client);
      await client.close().catch(logUnhandledError);
    }
  }

  // Holds a lease on `client` while `use` runs, so a replacement published
  // meanwhile retires it instead of closing it under the pending request; the
  // close then runs once `use` settles. The lease is taken synchronously, so
  // read `client` and call this in the same tick. A client this slot does not
  // track (never published here, or already closed) is used without a lease.
  async withLease<T>(client: Client, use: () => Promise<T>): Promise<T> {
    const lease = this._leases.get(client);
    if (lease)
      lease.count++;
    try {
      return await use();
    } finally {
      if (lease)
        void this.release(client);
    }
  }

  // Replacements run one at a time, in call order. The candidate is connected
  // before anything is published, so a failed connect leaves the current
  // client in place. `publish` runs synchronously with the swap, before the
  // previous client is retired. A caller that is the slot's sole user passes
  // `lease: false`: it keeps no lease on the published client, which is then
  // closed as soon as it is replaced, or once the last `withLease` request on
  // it settles.
  async replace(connect: (() => Promise<Client>) | undefined, options: { lease?: boolean, publish?: (next: Client | undefined) => void } = {}): Promise<Client | undefined> {
    const result = this._chain.then(async () => {
      const next = connect ? await connect() : undefined;
      const previous = this._current;
      this._current = next;
      if (next)
        this._leases.set(next, { count: options.lease === false ? 0 : 1, retired: false });
      options.publish?.(next);
      if (previous) {
        const lease = this._leases.get(previous);
        if (lease && lease.count > 0) {
          lease.retired = true;
        } else {
          this._leases.delete(previous);
          await previous.close().catch(logUnhandledError);
        }
      }
      return next;
    });
    this._chain = result.catch(() => {});
    return await result;
  }

  async dispose(): Promise<void> {
    const result = this._chain.then(async () => {
      const clients = [...this._leases.keys()];
      this._leases.clear();
      this._current = undefined;
      await Promise.all(clients.map(client => client.close().catch(logUnhandledError)));
    });
    this._chain = result.catch(() => {});
    return await result;
  }
}
