/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const oxlintEntry = path.join(repoRoot, 'node_modules', 'oxlint', 'bin', 'oxlint');
const plugin = path.join(repoRoot, 'tools', 'oxlint', 'comments', 'index.ts');

type Diagnostic = { message: string, filename: string, labels: { span: { line: number } }[] };
type Report = { file: string, line: number, message: string };

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string>, allowed: Record<string, number> = {}): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'no-comments-'));
  directories.push(directory);
  await fs.writeFile(path.join(directory, '.oxlintrc.json'), JSON.stringify({
    categories: { correctness: 'off' },
    jsPlugins: [plugin],
    rules: { 'comments/no-comments': 'error' },
    overrides: Object.entries(allowed).map(([file, count]) => ({ files: [file], rules: { 'comments/no-comments': ['error', { allowed: count }] } })),
  }));
  for (const [name, source] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.writeFile(path.join(directory, name), source);
  }
  return directory;
}

async function runOxlint(cwd: string, files: string[]): Promise<Report[]> {
  const { stdout } = await promisify(execFile)(process.execPath, [oxlintEntry, '--format', 'json', ...files], { cwd }).catch((error: { stdout: string }) => error);
  const { diagnostics } = JSON.parse(stdout) as { diagnostics: Diagnostic[] };
  return diagnostics
      .map(diagnostic => ({ file: diagnostic.filename, line: diagnostic.labels[0].span.line, message: diagnostic.message }))
      .sort((left, right) => left.line - right.line);
}

async function lint(files: Record<string, string>, allowed: Record<string, number> = {}): Promise<Report[]> {
  return runOxlint(await fixture(files, allowed), Object.keys(files));
}

describe('comments/no-comments', () => {
  it('reports every comment in a file with no allowance', async () => {
    const reports = await lint({ 'src/a.ts': 'const a = 1; // trailing\n// standalone\n/* block */\nexport { a };\n' });

    expect(reports.map(report => report.line)).toEqual([1, 2, 3]);
    expect(reports[0].message).toContain('Comments are not allowed here');
  });

  it('allows licence notices, shebangs, lint and type directives, and knip annotations', async () => {
    const reports = await lint({
      'src/a.ts': [
        '#!/usr/bin/env node',
        '/*',
        ' * Copyright (c) MCP Accessibility Scanner contributors.',
        ' */',
        '// eslint-disable-next-line no-console',
        'console.log(1);',
        '/* oxlint-disable no-console */',
        '// @ts-expect-error untyped global',
        'globalThis.x = 1;',
        '/** @public */',
        'export const a = 1;',
        '',
      ].join('\n'),
      'src/spdx-line.ts': '// SPDX-License-Identifier: MIT\nexport const b = 1;\n',
      'src/spdx-block.ts': '/* SPDX-License-Identifier: Apache-2.0 */\nexport const c = 1;\n',
      'src/license-tag.ts': '/*! @license MIT */\nexport const d = 1;\n',
    });

    expect(reports).toEqual([]);
  });

  it('exempts a directive but not prose that mentions one', async () => {
    const reports = await lint({
      'src/a.ts': [
        '// @ts-expect-error untyped global',
        'globalThis.x = 1;',
        '// This used to need @ts-ignore but no longer does.',
        '// eslint-disabled while the rule is tuned',
        '/* oxlint-disable-next-line no-console */',
        'export const a = 1;',
        '',
      ].join('\n'),
    });

    expect(reports.map(report => report.line)).toEqual([3, 4]);
  });

  it('reports a licence-looking comment that is not part of the leading notice', async () => {
    const reports = await lint({ 'src/a.ts': 'export const a = 1;\n/* Copyright is assigned on merge */\n// SPDX-License-Identifier: MIT\n' });

    expect(reports.map(report => report.line)).toEqual([2, 3]);
  });

  it('holds a file to its allowance, reporting once when it grows', async () => {
    const source = '// one\n// two\n// three\nexport const a = 1;\n';

    expect(await lint({ 'src/a.ts': source }, { 'src/a.ts': 3 })).toEqual([]);
    const reports = await lint({ 'src/a.ts': source }, { 'src/a.ts': 2 });
    expect(reports).toHaveLength(1);
    expect(reports[0].message).toBe('This file has 3 comments; its comments/no-comments override allows 2. Remove the new ones.');
  });

  it('asks for the allowance to be lowered once comments are deleted, so the ratchet only tightens', async () => {
    const reports = await lint({ 'src/a.ts': '// one\nexport const a = 1;\n' }, { 'src/a.ts': 3 });

    expect(reports.map(report => report.message)).toEqual(['This file now has 1 comments; lower its comments/no-comments "allowed" in .oxlintrc.json from 3 to 1.']);
  });

  it('applies the allowance the same way from the repository root and from a subdirectory', async () => {
    const directory = await fixture({ 'tests/a.test.ts': '// one\nexport const a = 1;\n', 'tests/b.test.ts': '// one\nexport const b = 1;\n' }, { 'tests/a.test.ts': 1 });

    const fromRoot = await runOxlint(directory, ['tests/a.test.ts', 'tests/b.test.ts']);
    const fromSubdirectory = await runOxlint(path.join(directory, 'tests'), ['a.test.ts', 'b.test.ts']);

    expect(fromRoot.map(report => path.basename(report.file))).toEqual(['b.test.ts']);
    expect(fromSubdirectory.map(report => path.basename(report.file))).toEqual(['b.test.ts']);
  });
});
