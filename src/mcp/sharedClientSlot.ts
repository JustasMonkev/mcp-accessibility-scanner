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
      await client.close().catch(errorsDebug);
    }
  }

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
          lease.retired = true;
        } else {
          this._leases.delete(previous);
          await previous.close().catch(errorsDebug);
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
      await Promise.all(clients.map(client => client.close().catch(errorsDebug)));
    });
    this._chain = result.catch(() => {});
    return await result;
  }
}
