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
import { execFileSync, spawnSync } from 'node:child_process';
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
    scenarios: [
      { name: 'shared', median: 10 },
      { name: 'removed', median: 100 },
      { name: 'micro-shared', median: 1000, micro: true },
    ],
  }));
  fs.writeFileSync(after, JSON.stringify({
    label: 'after',
    totalMedianMs: 1020,
    scenarios: [
      { name: 'shared', median: 20 },
      { name: 'added', median: 1000 },
      { name: 'micro-shared', median: 2000, micro: true },
    ],
  }));

  const output = execFileSync(process.execPath, ['bench/mcp-bench.mjs', '--compare', before, after], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
  });

  const totalRow = output.split('\n').find(line => line.includes('TOTAL (end-to-end tool calls)'));
  expect(totalRow?.split('|').map(cell => cell.trim())).toEqual([
    '', 'TOTAL (end-to-end tool calls)', '10.0', '20.0', '+100.0%', '0.50x', '',
  ]);
  expect(output).toMatch(/^\| shared\s+\|/m);
  expect(output).not.toMatch(/^\| added\s+\|/m);
  expect(output).not.toMatch(/^\| removed\s+\|/m);
  expect(output).not.toContain('110.0');
  expect(output).not.toContain('1020.0');
});

it.each(['--server', '--lib'])('rejects an unpaired %s override', flag => {
  const result = spawnSync(process.execPath, ['bench/mcp-bench.mjs', flag, '/tmp/revision'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
  });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('--server and --lib must be provided together.');
});

it.each(['--out', '--server', '--lib'])('rejects a blank %s value', flag => {
  const result = spawnSync(process.execPath, ['bench/mcp-bench.mjs', flag, '  '], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
  });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('needs a value');
});

it('rejects an invalid report directory before starting the benchmark', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bench-test-'));
  temporaryDirectories.push(directory);
  const result = spawnSync(process.execPath, [
    'bench/mcp-bench.mjs', '--out', path.join(directory, 'missing', 'report.json'),
  ], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
  });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('ENOENT');
});

it('rejects a report path whose parent is a file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bench-test-'));
  temporaryDirectories.push(directory);
  const parent = path.join(directory, 'file');
  fs.writeFileSync(parent, 'not a directory');
  const result = spawnSync(process.execPath, [
    'bench/mcp-bench.mjs', '--out', path.join(parent, 'report.json'),
  ], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
  });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('--out parent must be a directory');
});
