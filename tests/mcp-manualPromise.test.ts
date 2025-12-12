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

import { describe, it, expect } from 'vitest';
import { ManualPromise, LongStandingScope } from '../src/mcp/manualPromise.js';

describe('mcp/manualPromise', () => {
  describe('ManualPromise', () => {
    it('resolves and tracks completion', async () => {
      const p = new ManualPromise<number>();
      p.resolve(42);
      await expect(p).resolves.toBe(42);
      expect(p.isDone()).toBe(true);
    });

    it('rejects and tracks completion', async () => {
      const p = new ManualPromise<void>();
      p.reject(new Error('boom'));
      await expect(p).rejects.toThrow('boom');
      expect(p.isDone()).toBe(true);
    });
  });

  describe('LongStandingScope', () => {
    it('race resolves with underlying promise', async () => {
      const scope = new LongStandingScope();
      const result = await scope.race(Promise.resolve('ok'));
      expect(result).toBe('ok');
    });

    it('race rejects when scope is rejected', async () => {
      const scope = new LongStandingScope();
      scope.reject(new Error('terminated'));
      await expect(scope.race(new Promise(() => {}))).rejects.toThrow('terminated');
    });

    it('safeRace returns default value on close', async () => {
      const scope = new LongStandingScope();
      const pending = new Promise<number>(() => {});
      const raced = scope.safeRace(pending, 7);
      scope.close(new Error('closed'));
      await expect(raced).resolves.toBe(7);
    });
  });
});
