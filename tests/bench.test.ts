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
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { verifyScreenReader } from '../bench/screen-reader.mjs';

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

it.each(['--out', '--server', '--lib', '--only'])('rejects a blank %s value', flag => {
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

it('rejects an unmatched scenario prefix without launching the MCP server', () => {
  const result = spawnSync(process.execPath, [
    'bench/mcp-bench.mjs', '--only', 'not-a-scenario',
    '--server', '/missing/cli.js', '--lib', '/missing/lib',
  ], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('No scenarios match --only not-a-scenario');
  expect(result.stderr).not.toContain('MODULE_NOT_FOUND');
});

function screenReaderRun(checkNames = true, check = 'missing-accessible-name') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bench-test-'));
  temporaryDirectories.push(directory);
  const reportPath = path.join(directory, 'screen-reader.json');
  const reportUri = pathToFileURL(reportPath).href;
  const fixture = {
    path: '/screen-reader.html',
    options: { checkNames, checkReadingOrder: true, maxElements: 4, maxFindingsPerCheck: 2 },
    expected: { elements: 4, selectors: { [check]: ['button#a', 'button#b', 'button#c'] } },
  };
  const enabled = check === 'reading-order-mismatch' || checkNames;
  const countByCheck = { [check]: enabled ? 3 : 0 };
  const findings = enabled ? ['a', 'b'].map(id => ({
    check, selector: `button#${id}`, ref: id,
    role: 'button', name: null, problem: 'No accessible name', fix: 'Add a name', wcag: '4.1.2',
  })) : [];
  const truncatedChecks = enabled ? [check] : [];
  const origin = 'http://127.0.0.1:1234';
  const totalFindings = enabled ? 3 : 0;
  const report = {
    version: 'v1',
    metadata: { url: `${origin}${fixture.path}`, options: fixture.options, generatedAt: '2026-01-01T00:00:00.000Z' },
    elements: { total: 4, analyzed: 4, unresolved: 0, unmeasuredNames: 0, truncated: false },
    countByCheck, totalFindings, truncatedChecks, findings,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report));
  const result = {
    content: [{ type: 'resource_link', uri: reportUri }],
    structuredContent: {
      kind: 'audit_screen_reader',
      page: { url: `${origin}${fixture.path}` },
      report: { uri: reportUri, mimeType: 'application/json' },
      reportUri,
      summary: {
        elementsTotal: 4, elementsAnalyzed: 4, elementsUnresolved: 0,
        elementsWithoutMeasuredName: 0, elementsTruncated: 0,
        totalFindings, countByCheck, truncatedChecks,
      },
      findings,
    },
  };
  return { result, report, reportPath, fixture, origin };
}

it.each([true, false])('verifies full coverage, capped findings and persisted report with names %s', checkNames => {
  const { result, fixture, origin } = screenReaderRun(checkNames);
  expect(() => verifyScreenReader(result, fixture, origin)).not.toThrow();
});

it('verifies reading-order findings independently of name checks', () => {
  const { result, fixture, origin } = screenReaderRun(false, 'reading-order-mismatch');
  expect(() => verifyScreenReader(result, fixture, origin)).not.toThrow();
});

it.each([
  ['dropped elements', (run: ReturnType<typeof screenReaderRun>) => { run.result.structuredContent.summary.elementsAnalyzed--; }],
  ['unresolved elements', (run: ReturnType<typeof screenReaderRun>) => { run.result.structuredContent.summary.elementsUnresolved++; }],
  ['unmeasured names', (run: ReturnType<typeof screenReaderRun>) => { run.result.structuredContent.summary.elementsWithoutMeasuredName++; }],
  ['lost full finding count', (run: ReturnType<typeof screenReaderRun>) => { run.result.structuredContent.summary.countByCheck['missing-accessible-name']--; }],
  ['dropped capped findings', (run: ReturnType<typeof screenReaderRun>) => { run.result.structuredContent.findings.pop(); }],
  ['wrong finding target', (run: ReturnType<typeof screenReaderRun>) => { run.result.structuredContent.findings[0].selector = 'button#wrong'; }],
  ['duplicate ref', (run: ReturnType<typeof screenReaderRun>) => { run.result.structuredContent.findings[1].ref = 'a'; }],
])('rejects %s instead of recording an apparent speedup', (_, mutate) => {
  const run = screenReaderRun();
  mutate(run);
  expect(() => verifyScreenReader(run.result, run.fixture, run.origin)).toThrow();
});

it('rejects persisted report contents that disagree with the MCP result', () => {
  const { result, fixture, origin, report, reportPath } = screenReaderRun();
  report.elements.analyzed = 3;
  fs.writeFileSync(reportPath, JSON.stringify(report));
  expect(() => verifyScreenReader(result, fixture, origin)).toThrow();
});

it('rejects missing report files', () => {
  const { result, fixture, origin, reportPath } = screenReaderRun();
  fs.unlinkSync(reportPath);
  expect(() => verifyScreenReader(result, fixture, origin)).toThrow();
});

it.each(['-1', '1.5', 'NaN', '2147483648', '1e21'])('rejects invalid settle delay %s before launching a browser', value => {
  const result = spawnSync(process.execPath, ['bench/mcp-bench.mjs', '--settle-ms', value], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('--settle-ms needs an integer >= 0');
});
