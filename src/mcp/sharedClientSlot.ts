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
 * replace() serializes switches: the next client is fully connected before it
 * is published, and the previously published client is closed exactly once,
 * only after the swap — so a concurrent request reading the slot observes
 * either the old client still live or the new one ready, never a half-open
 * one. A failed connect leaves the previous selection in place.
 */
export class SharedClientSlot {
  private _current: Client | undefined;
  private _chain: Promise<unknown> = Promise.resolve();

  /**
   * The process-scoped switched client, or undefined while the default
   * (per-request) provider is selected.
   */
  current(): Client | undefined {
    return this._current;
  }

  /**
   * Switches the slot to the client produced by `connect`, or back to the
   * default selection (no shared client) when `connect` is undefined.
   * Returns the newly published client, or undefined for the default
   * selection.
   */
  async replace(connect: (() => Promise<Client>) | undefined): Promise<Client | undefined> {
    const result = this._chain.then(async () => {
      const next = connect ? await connect() : undefined;
      const previous = this._current;
      this._current = next;
      await previous?.close().catch(errorsDebug);
      return next;
    });
    // A rejected switch (failed connect) must not poison later switches.
    this._chain = result.catch(() => {});
    return await result;
  }
}
