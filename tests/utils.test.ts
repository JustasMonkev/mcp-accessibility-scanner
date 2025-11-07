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

import { describe, it, expect, beforeEach } from 'vitest';
import { guid } from '../src/utils/guid.js';

describe('Utils', () => {
  describe('guid', () => {
    it('should generate unique identifiers', () => {
      const id1 = guid();
      const id2 = guid();
      const id3 = guid();

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });

    it('should return strings', () => {
      const id = guid();
      expect(typeof id).toBe('string');
    });

    it('should generate non-empty strings', () => {
      const id = guid();
      expect(id.length).toBeGreaterThan(0);
    });

    it('should use specific prefix format', () => {
      const ids = Array.from({ length: 100 }, () => guid());

      ids.forEach(id => {
        expect(id).toMatch(/^[a-z0-9]+$/);
      });
    });
  });
});
