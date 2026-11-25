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

const disposedError = () => new Error('The client slot was disposed before the replacement could be published.');

export class SharedClientSlot {
  private _current: Client | undefined;
  private _chain: Promise<unknown> = Promise.resolve();
  private _leases = new Map<Client, { count: number, retired: boolean }>();
  private _closing = new Set<Promise<void>>();
  private _disposed = false;

  // Once dispose() has been called it hands out nothing: its queued cleanup
  // closes the current client regardless of leases.
  acquire(): Client | undefined {
    if (this._disposed || !this._current)
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
      await this._close(client);
    }
  }

  // Tracks the close until it settles, so dispose() waits for a close that
  // release() started after removing the client from `_leases`.
  private _close(client: Client): Promise<void> {
    const closing = client.close().catch(logUnhandledError).finally(() => this._closing.delete(closing));
    this._closing.add(closing);
    return closing;
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
  //
  // Once dispose() has been called the slot publishes nothing more: a
  // replacement that has not started is rejected without calling `connect`,
  // and a candidate that finishes connecting afterwards is closed and
  // rejected. Clearing (`connect` undefined) then resolves to undefined, as
  // dispose() clears the slot itself. A backend's owned slot is disposed by
  // serverClosed(), so a switch still queued then fails instead of starting
  // a provider nobody would close; the process-wide slot is disposed only by
  // exit cleanup, after which a switch fails the same way.
  async replace(connect: (() => Promise<Client>) | undefined, options: { lease?: boolean, publish?: (next: Client | undefined) => void } = {}): Promise<Client | undefined> {
    return await this._enqueue(async () => {
      if (this._disposed && !connect)
        return undefined;
      if (this._disposed)
        throw disposedError();
      const next = connect ? await connect() : undefined;
      if (this._disposed && next) {
        await this._close(next);
        throw disposedError();
      }
      await this._swap(next, options);
      return next;
    });
  }

  // Clears the slot as one serialized step with `prepare`, which readies
  // whatever the caller moves to instead (a resource of its own, not
  // published here). The clear runs only once `prepare` succeeds, so a failed
  // preparation leaves the current client in place, and a replacement queued
  // meanwhile waits for this step rather than being cleared by it. Like
  // replace(), a step that starts once dispose() has been called is rejected
  // without calling `prepare`; a preparation that finishes after dispose()
  // returns its result, as dispose() clears the slot itself.
  async clearAfter<T>(prepare: () => Promise<T>): Promise<T> {
    return await this._enqueue(async () => {
      if (this._disposed)
        throw disposedError();
      const prepared = await prepare();
      if (!this._disposed)
        await this._swap(undefined, {});
      return prepared;
    });
  }

  private _enqueue<T>(step: () => Promise<T>): Promise<T> {
    const result = this._chain.then(step);
    this._chain = result.catch(() => {});
    return result;
  }

  private async _swap(next: Client | undefined, options: { lease?: boolean, publish?: (next: Client | undefined) => void }): Promise<void> {
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
  }

  async dispose(): Promise<void> {
    this._disposed = true;
    await this._enqueue(async () => {
      const clients = [...this._leases.keys()];
      this._leases.clear();
      this._current = undefined;
      for (const client of clients)
        void this._close(client);
      await Promise.all([...this._closing]);
    });
  }
}
