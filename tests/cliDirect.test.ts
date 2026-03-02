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

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { parseToolInput, toolResultAsText } from '../src/cliDirect.js';

describe('cliDirect', () => {
  describe('parseToolInput', () => {
    it('returns empty object when no input is provided', async () => {
      await expect(parseToolInput({})).resolves.toEqual({});
    });

    it('parses object json from --input', async () => {
      await expect(parseToolInput({ input: '{"url":"https://example.com"}' })).resolves.toEqual({ url: 'https://example.com' });
    });

    it('parses object json from --input-file', async () => {
      const filePath = path.join(os.tmpdir(), `mcp-accessibility-scanner-cli-input-${Date.now()}.json`);
      await fs.writeFile(filePath, '{"key":"value"}', 'utf8');
      await expect(parseToolInput({ inputFile: filePath })).resolves.toEqual({ key: 'value' });
      await fs.unlink(filePath);
    });

    it('rejects when both input flags are used', async () => {
      await expect(parseToolInput({ input: '{}', inputFile: '/tmp/input.json' })).rejects.toThrow('Use either --input or --input-file, not both.');
    });

    it('rejects non-object json input', async () => {
      await expect(parseToolInput({ input: '["not-an-object"]' })).rejects.toThrow('Tool input JSON must be an object.');
    });
  });

  describe('toolResultAsText', () => {
    it('returns only text content entries in order', () => {
      const text = toolResultAsText({
        content: [
          { type: 'text', text: 'first' } as any,
          { type: 'image', data: 'abc', mimeType: 'image/png' } as any,
          { type: 'text', text: 'second' } as any,
        ],
      } as any);
      expect(text).toBe('first\nsecond');
    });
  });
});
