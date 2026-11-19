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

import crypto from 'node:crypto';

// Draw identifiers from a batch of CSPRNG output, as crypto.randomUUID() does,
// instead of allocating a Buffer and entering the RNG for every call. Each byte
// is handed out once; the pool is refilled after it has been consumed.
const randomPool = Buffer.allocUnsafeSlow(4096);
let randomOffset = randomPool.length;

function randomHex(bytes: number): string {
  if (randomOffset + bytes > randomPool.length) {
    crypto.randomFillSync(randomPool);
    randomOffset = 0;
  }
  const start = randomOffset;
  randomOffset += bytes;
  return randomPool.toString('hex', start, randomOffset);
}

export function createGuid(): string {
  return randomHex(16);
}

export function createShortGuid(): string {
  return randomHex(4);
}

export function createHash(data: string): string {
  return crypto.hash('sha256', data).slice(0, 7);
}
