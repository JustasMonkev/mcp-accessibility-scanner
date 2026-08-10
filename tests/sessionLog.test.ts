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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { SessionLog } from '../src/sessionLog.js';

describe('session log folders', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives sessions created in the same millisecond distinct folders', async () => {
    // A purely timestamp-based name made two connections arriving in the
    // same millisecond share a folder: interleaved session.md entries and
    // overwritten snapshot ordinals.
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-session-folders-'));
    vi.spyOn(Date, 'now').mockReturnValue(1735689600000);
    // SessionLog.create() announces every session folder with
    // `console.error('Session: <folder>')`; silence the five copies so the
    // test output stays clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const config = await resolveConfig({ saveSession: true, outputDir });
      await Promise.all(Array.from({ length: 5 }, () => SessionLog.create(config)));

      const folders = fs.readdirSync(outputDir);
      expect(folders).toHaveLength(5);
      for (const folder of folders)
        expect(folder).toMatch(/^session-1735689600000-[a-f0-9]{8}$/);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
