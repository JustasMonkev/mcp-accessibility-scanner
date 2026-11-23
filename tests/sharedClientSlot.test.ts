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

import { describe, expect, it } from 'vitest';
import { SharedClientSlot } from '../src/mcp/sharedClientSlot.js';

import type { Client } from '@modelcontextprotocol/client';

// A client whose close() stays pending until the test finishes it.
function makeFakeClient() {
  let finishClose: (() => void) | undefined;
  const fake = {
    closeCalls: 0,
    closed: false,
    finishClose: () => finishClose?.(),
    close: async () => {
      fake.closeCalls++;
      await new Promise<void>(resolve => { finishClose = resolve; });
      fake.closed = true;
    },
  };
  return fake;
}

describe('SharedClientSlot', () => {
  it('dispose waits for a close that release() started', async () => {
    const slot = new SharedClientSlot();
    const outgoing = makeFakeClient();
    const incoming = makeFakeClient();
    await slot.replace(async () => outgoing as unknown as Client);
    // The publishing caller's lease keeps `outgoing` open; the replacement
    // retires it instead of closing it.
    await slot.replace(async () => incoming as unknown as Client);
    expect(outgoing.closeCalls).toBe(0);

    // Releasing the last lease starts the close, which stays pending.
    void slot.release(outgoing as unknown as Client);
    expect(outgoing.closeCalls).toBe(1);

    let disposed = false;
    const disposing = slot.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(incoming.closeCalls).toBe(1);
    incoming.finishClose();
    await new Promise(resolve => setTimeout(resolve, 0));
    // `incoming` is closed, but `outgoing` is still closing.
    expect(incoming.closed).toBe(true);
    expect(disposed).toBe(false);

    outgoing.finishClose();
    await disposing;
    expect(outgoing.closed).toBe(true);
    expect(outgoing.closeCalls).toBe(1);
  });

  it('refuses to connect or publish a replacement once disposed', async () => {
    const slot = new SharedClientSlot();
    const current = { closeCalls: 0, close: async () => { current.closeCalls++; } };
    await slot.replace(async () => current as unknown as Client);
    let connects = 0;

    const disposing = slot.dispose();
    const queued = slot.replace(async () => {
      connects++;
      return { close: async () => {} } as unknown as Client;
    });
    await disposing;

    await expect(queued).rejects.toThrow('disposed');
    expect(connects).toBe(0);
    await expect(slot.replace(undefined)).resolves.toBeUndefined();
    expect(slot.acquire()).toBeUndefined();
    expect(current.closeCalls).toBe(1);
  });

  it('closes a candidate that finishes connecting after dispose() instead of publishing it', async () => {
    const slot = new SharedClientSlot();
    const candidate = { closeCalls: 0, close: async () => { candidate.closeCalls++; } };
    let finishConnect!: () => void;
    const connected = new Promise<void>(resolve => { finishConnect = resolve; });
    let published = false;

    const replacing = slot.replace(async () => {
      await connected;
      return candidate as unknown as Client;
    }, { publish: () => { published = true; } });
    await new Promise(resolve => setTimeout(resolve, 0));
    const disposing = slot.dispose();
    finishConnect();

    await expect(replacing).rejects.toThrow('disposed');
    await disposing;
    expect(published).toBe(false);
    expect(candidate.closeCalls).toBe(1);
    expect(slot.acquire()).toBeUndefined();
  });
});
