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
import { caseSchema, decide } from '../bench/latency-case.mts';

describe('latency investigation', () => {
  const block = (suspect: number, repair?: number) => ({ reference: 100, suspect, repair });
  it.each([
    [block(125), 'no-alert'], [block(126), 'needs-investigation'],
    [block(200, 125), 'recovery-verified'], [block(200, 150), 'still-regressed'],
  ] as const)('classifies repeated launch blocks', (row, state) => {
    expect(decide([row, row, row])).toBe(state);
  });
  it('keeps mixed evidence open at either stage', () => {
    expect(decide([block(130), block(200), block(100)])).toBe('inconclusive');
    expect(decide([block(200, 130), block(200, 100), block(200, 100)])).toBe('inconclusive');
  });
  it('uses the absolute floor for small calls', () => {
    expect(decide(Array(3).fill({ reference: 1, suspect: 11 }))).toBe('no-alert');
  });
  it('rejects incomplete or invalid observations', () => {
    expect(() => decide([block(200)])).toThrow();
    expect(() => decide([block(200, 100), block(200), block(200)])).toThrow();
    expect(() => decide([block(Infinity), block(200), block(200)])).toThrow();
  });
  it('rejects unknown keys, unbounded workloads, and non-commit inputs', () => {
    const valid = { workload: 'console', reference: '5e681ab', suspect: '9ec0e20' };
    expect(caseSchema.safeParse(valid).success).toBe(true);
    for (const override of [{ threshold: 5 }, { workload: '*' }, { suspect: 'main' }])
      expect(caseSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });
});
