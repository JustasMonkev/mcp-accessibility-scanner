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
import { truncateDataUrl, truncateDataUrls } from '../src/utils/dataUrl.js';

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

  describe('data URL truncation', () => {
    it('should truncate direct data URL payloads', () => {
      expect(truncateDataUrl('data:text/html;base64,PHAgLz4=')).toBe('data:text/html;base64,...');
    });

    it('should not truncate ordinary prose that starts with data:', () => {
      expect(truncateDataUrls('data: total, average')).toBe('data: total, average');
      expect(truncateDataUrl('data: total, average')).toBe('data: total, average');
    });

    it('should not truncate direct strings without a data URL prefix', () => {
      expect(truncateDataUrl('12345image/png,payload')).toBe('12345image/png,payload');
    });

    it('should truncate raw SVG data URL payloads without leaking markup', () => {
      const payload = '<svg viewBox="0 0 10 10"><text>&Hello</text></svg>';
      const text = `- /url: data:image/svg+xml,${payload}\n- button "Next"`;

      const result = truncateDataUrls(text);

      expect(result).toContain('data:image/svg+xml,...\n- button "Next"');
      expect(result).not.toContain(payload);
      expect(result).not.toContain('<svg');
      expect(result).not.toContain('<text>');
    });

    it('should truncate data URLs embedded in query strings', () => {
      const payload = Buffer.from('<p>hello</p>').toString('base64');
      const text = `https://api.example/upload?src=data:text/html;base64,${payload}&id=123`;

      expect(truncateDataUrls(text)).toBe('https://api.example/upload?src=data:text/html;base64,...&id=123');
    });

    it('should truncate data URLs with literal prefixes and encoded commas', () => {
      const payload = encodeURIComponent(Buffer.from('<p>hello</p>').toString('base64'));
      const text = `https://api.example/upload?src=data:text/html;base64%2C${payload}&id=123`;

      expect(truncateDataUrls(text)).toBe('https://api.example/upload?src=data:text/html;base64%2C...&id=123');
    });

    it('should truncate data URLs with literal prefixes and encoded metadata', () => {
      const payload = encodeURIComponent(Buffer.from('<p>hello</p>').toString('base64'));
      const text = `https://api.example/upload?src=data:text%2Fhtml%3Bbase64%2C${payload}&id=123`;

      expect(truncateDataUrls(text)).toBe('https://api.example/upload?src=data:text%2Fhtml%3Bbase64%2C...&id=123');
    });

    it('should not parse data URL metadata across query boundaries', () => {
      const text = 'https://api.example/search?type=data:text/html;base64&tags=a,b';

      expect(truncateDataUrls(text)).toBe(text);
    });

    it('should preserve query params after raw data URLs embedded in query strings', () => {
      const payload = '<svg><text>Hello</text></svg>';
      const text = `https://api.example/upload?src=data:image/svg+xml,${payload}&id=123`;

      expect(truncateDataUrls(text)).toBe('https://api.example/upload?src=data:image/svg+xml,...&id=123');
    });

    it('should keep raw data URL payload query-like ampersands redacted', () => {
      const text = 'https://api.example/upload?src=data:text/html,<a href="/?a=1&b=2">link</a>&id=123';

      const result = truncateDataUrls(text);

      expect(result).toBe('https://api.example/upload?src=data:text/html,...&id=123');
      expect(result).not.toContain('&b=2');
      expect(result).not.toContain('link</a>');
    });

    it('should truncate percent-encoded data URLs embedded in query strings', () => {
      const payload = encodeURIComponent(Buffer.from('<p>hello</p>').toString('base64'));
      const text = `https://api.example/upload?src=data%3Atext%2Fhtml%3Bbase64%2C${payload}&id=123`;

      expect(truncateDataUrls(text)).toBe('https://api.example/upload?src=data%3Atext%2Fhtml%3Bbase64%2C...&id=123');
    });

    it('should truncate data URLs inside encoded wrappers', () => {
      const payload = encodeURIComponent(Buffer.from('<p>hello</p>').toString('base64'));
      const text = `https://api.example/upload?src=%22data%3Atext%2Fhtml%3Bbase64%2C${payload}%22&id=123`;

      const result = truncateDataUrls(text);

      expect(result).toBe('https://api.example/upload?src=%22data%3Atext%2Fhtml%3Bbase64%2C...%22&id=123');
      expect(result).not.toContain(payload);
    });

    it('should preserve encoded wrappers around non-markup raw data URLs', () => {
      const text = 'https://api.example/upload?src=%22data%3Atext%2Fplain%2Chello%22&id=123';

      expect(truncateDataUrls(text)).toBe('https://api.example/upload?src=%22data%3Atext%2Fplain%2C...%22&id=123');
    });

    it('should preserve suffix text after unquoted raw data URLs', () => {
      const text = '[LOG] data:image/svg+xml,<svg></svg> done @ app.js:7';

      expect(truncateDataUrls(text)).toBe('[LOG] data:image/svg+xml,... done @ app.js:7');
    });

    it('should preserve suffix text after unquoted raw text data URLs', () => {
      const text = '[LOG] data:text/plain,hello done @ app.js:7';

      expect(truncateDataUrls(text)).toBe('[LOG] data:text/plain,... done @ app.js:7');
    });

    it('should preserve suffix text after quoted raw data URLs', () => {
      const text = '[LOG] "data:image/svg+xml,<svg></svg>" done @ app.js:7';

      expect(truncateDataUrls(text)).toBe('[LOG] "data:image/svg+xml,..." done @ app.js:7');
    });

    it('should preserve source locations after unquoted raw data URLs', () => {
      const text = '[LOG] Test @ data:image/svg+xml,<svg></svg>:1';

      expect(truncateDataUrls(text)).toBe('[LOG] Test @ data:image/svg+xml,...:1');
    });

    it('should keep source-like colons inside raw markup payloads redacted', () => {
      const text = '[LOG] Test @ data:image/svg+xml,<svg><text>1:2</text></svg>:1';

      const result = truncateDataUrls(text);

      expect(result).toBe('[LOG] Test @ data:image/svg+xml,...:1');
      expect(result).not.toContain('1:2');
      expect(result).not.toContain('</text>');
    });

    it('should keep source-like colons inside raw text payloads redacted', () => {
      const text = '[LOG] data:text/plain,secret:1<large-tail> done @ app.js:7';

      const result = truncateDataUrls(text);

      expect(result).toBe('[LOG] data:text/plain,... done @ app.js:7');
      expect(result).not.toContain('secret');
      expect(result).not.toContain('large-tail');
    });

    it('should truncate data URLs with escaped spaces in metadata', () => {
      const payload = Buffer.from('<p>hello</p>').toString('base64');
      const text = `data:text/plain;name=hello%20world;base64,${payload}`;

      expect(truncateDataUrl(text)).toBe('data:text/plain;name=hello%20world;base64,...');
    });

    it('should cap oversized data URL metadata before the ellipsis', () => {
      const largeParameter = 'a'.repeat(1024);

      expect(truncateDataUrl(`data:text/html;name=${largeParameter},x`)).toBe('data:text/html,...');
      expect(truncateDataUrl(`data:text/html;name=${largeParameter};base64,eA==`)).toBe('data:text/html;base64,...');
    });

    it('should preserve snapshot refs after raw data URLs in accessible names', () => {
      const text = '- button "data:image/svg+xml,<svg></svg>" [ref=e1]';

      expect(truncateDataUrls(text)).toBe('- button "data:image/svg+xml,..." [ref=e1]');
    });

    it('should redact query-like ampersands in quoted raw data URL payloads', () => {
      const text = '- link "data:text/html,<a href="/?a=1&b=2">link</a>" [ref=e1]';

      const result = truncateDataUrls(text);

      expect(result).toBe('- link "data:text/html,..." [ref=e1]');
      expect(result).not.toContain('&b=2');
      expect(result).not.toContain('link</a>');
    });

    it('should preserve wrappers around raw data URLs', () => {
      const text = '- img "url(data:image/svg+xml,<svg></svg>)" [ref=e1]';

      expect(truncateDataUrls(text)).toBe('- img "url(data:image/svg+xml,...)" [ref=e1]');
    });

    it('should preserve refs after encoded raw markup data URLs', () => {
      const text = '- button "data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E" [ref=e1]';

      expect(truncateDataUrls(text)).toBe('- button "data:image/svg+xml,..." [ref=e1]');
    });

    it('should preserve wrappers around non-markup raw data URLs', () => {
      const text = '[LOG] url(data:text/plain,hello) done';

      expect(truncateDataUrls(text)).toBe('[LOG] url(data:text/plain,...) done');
    });
  });
});
