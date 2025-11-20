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
import { createGuid, createHash } from '../src/utils/guid.js';

describe('Utils', () => {
  describe('createGuid', () => {
    it('should generate unique identifiers', () => {
      const id1 = createGuid();
      const id2 = createGuid();
      const id3 = createGuid();

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });

    it('should return strings', () => {
      const id = createGuid();
      expect(typeof id).toBe('string');
    });

    it('should generate non-empty strings', () => {
      const id = createGuid();
      expect(id.length).toBeGreaterThan(0);
    });

    it('should generate hex strings', () => {
      const ids = Array.from({ length: 10 }, () => createGuid());

      ids.forEach(id => {
        expect(id).toMatch(/^[a-f0-9]+$/);
        expect(id.length).toBe(32); // 16 bytes = 32 hex chars
      });
    });
  });

  describe('createHash', () => {
    it('should generate hash from data', () => {
      const hash = createHash('test data');
      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
    });

    it('should generate consistent hashes', () => {
      const hash1 = createHash('test');
      const hash2 = createHash('test');
      expect(hash1).toBe(hash2);
    });

    it('should generate different hashes for different data', () => {
      const hash1 = createHash('test1');
      const hash2 = createHash('test2');
      expect(hash1).not.toBe(hash2);
    });

    it('should generate 7 character hashes', () => {
      const hash = createHash('test data');
      expect(hash.length).toBe(7);
    });
  });
});
