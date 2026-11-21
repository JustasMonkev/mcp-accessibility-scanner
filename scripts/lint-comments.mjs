import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { parse } from '@babel/parser';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const paths = (...args) => git(...args).split('\0').filter(Boolean);
const inventory = process.argv[2] === '--inventory';
const microsoftNotice = readFileSync(new URL('../utils/copyright.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n').trim();
const notices = new Set([
  microsoftNotice,
  microsoftNotice.replace('Microsoft Corporation', 'MCP Accessibility Scanner contributors'),
  '/*\n * Copyright (c) MCP Accessibility Scanner contributors.\n * Licensed under the Apache License, Version 2.0.\n */',
]);

function comments(file, source) {
  const plugins = [];
  if (/\.[cm]?tsx?$/.test(file))
    plugins.push(['typescript', { dts: /\.d\.[cm]?ts$/.test(file) }]);
  if (file.endsWith('x'))
    plugins.push('jsx');
  const ast = parse(source, { sourceFilename: file, sourceType: 'unambiguous', plugins, attachComment: false });
  return ast.comments.map(comment => {
    const raw = source.slice(comment.start, comment.end);
    let kind = 'prose';
    if (notices.has(raw) && !source.slice(ast.program.interpreter?.end ?? 0, comment.start).trim())
      kind = 'notice';
    else if (raw === '/** @public */' || raw === '/** @internal */')
      kind = 'annotation';
    return { raw, kind, start: comment.start, end: comment.end, line: comment.loc.start.line, endLine: comment.loc.end.line };
  });
}

function printInventory(file, source, entries) {
  let cursor = 0;
  let stripped = '';
  for (const entry of entries) {
    stripped += source.slice(cursor, entry.start) + entry.raw.replace(/[^\r\n\u2028\u2029]/g, ' ');
    cursor = entry.end;
  }
  const lines = (stripped + source.slice(cursor)).split(/\r\n|[\r\n\u2028\u2029]/);
  const counted = new Set();
  for (const entry of entries) {
    let standalone = 0;
    for (let line = entry.line; line <= entry.endLine; line++) {
      if (!counted.has(line) && !lines[line - 1].trim()) {
        standalone++;
        counted.add(line);
      }
    }
    console.log([file, entry.line, entry.kind, standalone, JSON.stringify(entry.raw)].join('\t'));
  }
}

function checkFile(file, current, previous) {
  const allowances = new Map();
  for (const entry of previous) {
    if (entry.kind === 'prose')
      allowances.set(entry.raw, (allowances.get(entry.raw) ?? 0) + 1);
  }
  for (const entry of current) {
    if (entry.kind !== 'prose')
      continue;
    const remaining = allowances.get(entry.raw) ?? 0;
    if (remaining > 0) {
      allowances.set(entry.raw, remaining - 1);
    } else {
      console.error(`${file}:${entry.line}: no-new-comments: classify this comment with /delete-comment.`);
      process.exitCode = 1;
    }
  }
}

function baseRevision() {
  if (process.env.COMMENT_BASE_REF)
    return git('rev-parse', '--verify', '--end-of-options', process.env.COMMENT_BASE_REF + '^{commit}').trim();
  try {
    return git('merge-base', 'HEAD', 'refs/remotes/origin/main').trim();
  } catch {
    return git('rev-parse', '--verify', 'HEAD').trim();
  }
}

const base = inventory ? undefined : baseRevision();
const tracked = base ? paths('diff', '--no-renames', '--diff-filter=ACMT', '--name-only', '-z', base, '--') : paths('ls-files', '-z');
const previousPaths = new Set(base ? paths('ls-tree', '-rz', '--name-only', base) : []);
const files = new Set([...tracked, ...paths('ls-files', '--others', '--exclude-standard', '-z')]);
for (const file of [...files].sort()) {
  if (!/\.[cm]?[jt]sx?$/.test(file) || file.startsWith('tools/oxlint/anti-slop/'))
    continue;
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile())
    continue;
  const source = readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
  const current = comments(file, source);
  if (inventory) {
    printInventory(file, source, current);
  } else {
    const previous = previousPaths.has(file) ? git('show', `${base}:${file}`).replaceAll('\r\n', '\n') : '';
    checkFile(file, current, comments(file, previous));
  }
}
