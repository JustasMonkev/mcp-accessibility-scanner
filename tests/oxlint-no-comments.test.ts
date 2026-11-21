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
const oxlint = path.join(repoRoot, 'node_modules', '.bin', 'oxlint');
const plugin = path.join(repoRoot, 'tools', 'oxlint', 'comments', 'index.ts');

type Diagnostic = { message: string, filename: string, labels: { span: { line: number } }[] };

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function lint(files: Record<string, string>, baseline: Record<string, number> = {}): Promise<{ file: string, line: number, message: string }[]> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'no-comments-'));
  directories.push(directory);
  await fs.writeFile(path.join(directory, '.oxlintrc.json'), JSON.stringify({
    categories: { correctness: 'off' },
    jsPlugins: [plugin],
    rules: { 'comments/no-comments': ['error', { baseline }] },
  }));
  for (const [name, source] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.writeFile(path.join(directory, name), source);
  }
  const { stdout } = await promisify(execFile)(oxlint, ['--format', 'json', ...Object.keys(files)], { cwd: directory }).catch((error: { stdout: string }) => error);
  const { diagnostics } = JSON.parse(stdout) as { diagnostics: Diagnostic[] };
  return diagnostics
      .map(diagnostic => ({ file: diagnostic.filename, line: diagnostic.labels[0].span.line, message: diagnostic.message }))
      .sort((left, right) => left.line - right.line);
}

describe('comments/no-comments', () => {
  it('reports every comment in a file with no baseline', async () => {
    const reports = await lint({ 'src/a.ts': 'const a = 1; // trailing\n// standalone\n/* block */\nexport { a };\n' });

    expect(reports.map(report => report.line)).toEqual([1, 2, 3]);
    expect(reports[0].message).toContain('Comments are not allowed here');
  });

  it('allows copyright notices, shebangs, lint and type directives, and knip annotations', async () => {
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
    });

    expect(reports).toEqual([]);
  });

  it('reports a copyright mention that is not the leading notice', async () => {
    const reports = await lint({ 'src/a.ts': 'export const a = 1;\n/* Copyright is assigned on merge */\n' });

    expect(reports.map(report => report.line)).toEqual([2]);
  });

  it('holds a baselined file to its count, reporting once when it grows', async () => {
    const source = '// one\n// two\n// three\nexport const a = 1;\n';

    expect(await lint({ 'src/a.ts': source }, { 'src/a.ts': 3 })).toEqual([]);
    const reports = await lint({ 'src/a.ts': source }, { 'src/a.ts': 2 });
    expect(reports).toHaveLength(1);
    expect(reports[0].message).toBe('This file has 3 comments; the ratchet allows 2. Remove the new ones with /delete-comment.');
  });

  it('asks for the baseline to be lowered once comments are deleted, so the ratchet only tightens', async () => {
    const reports = await lint({ 'src/a.ts': '// one\nexport const a = 1;\n' }, { 'src/a.ts': 3 });

    expect(reports.map(report => report.message)).toEqual(['This file now has 1 comments; lower its comments/no-comments baseline in .oxlintrc.json from 3 to 1.']);
  });

  it('keys the baseline by path from the working directory', async () => {
    const reports = await lint({ 'src/a.ts': '// one\nexport const a = 1;\n', 'src/b.ts': '// one\nexport const b = 1;\n' }, { 'src/a.ts': 1 });

    expect(reports.map(report => report.file)).toEqual(['src/b.ts']);
  });
});
