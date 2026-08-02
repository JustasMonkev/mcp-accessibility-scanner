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
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

it('compares totals over only the shared end-to-end scenarios', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bench-test-'));
  temporaryDirectories.push(directory);
  const before = path.join(directory, 'before.json');
  const after = path.join(directory, 'after.json');
  fs.writeFileSync(before, JSON.stringify({
    label: 'before',
    totalMedianMs: 110,
    scenarios: [{ name: 'shared', median: 10 }, { name: 'removed', median: 100 }],
  }));
  fs.writeFileSync(after, JSON.stringify({
    label: 'after',
    totalMedianMs: 1020,
    scenarios: [{ name: 'shared', median: 20 }, { name: 'added', median: 1000 }],
  }));

  const output = execFileSync(process.execPath, ['bench/mcp-bench.mjs', '--compare', before, after], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
  });

  expect(output).toContain('| TOTAL (end-to-end tool calls) | 10.0');
  expect(output).toContain('| 20.0');
  expect(output).not.toContain('110.0');
  expect(output).not.toContain('1020.0');
});
