import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./lint-comments.mjs', import.meta.url));
const notice = readFileSync(new URL('../utils/copyright.js', import.meta.url), 'utf8').trim();

test('grandfathers exact comment occurrences per path and drops them at the next base', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'comment-ratchet-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd });
  const write = (file, contents) => writeFileSync(join(cwd, file), contents);
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, COMMENT_BASE_REF: 'HEAD' },
  });
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  write('old.ts', '// existing\nexport const url = "https://example.org";\n');
  git('add', 'old.ts');
  git('commit', '-qm', 'base');

  write('old.ts', 'export const sample = `/* fixture */`;\n// existing\n');
  write('new.ts', '#!/usr/bin/env node\n' + notice + '\n/** @public */\nexport const value = "// literal";\n');
  assert.equal(run().status, 0);

  write('new.ts', '// existing\n');
  write('old.ts', '// existing\n// existing\n');
  const duplicates = run();
  assert.equal(duplicates.status, 1);
  assert.match(duplicates.stderr, /new\.ts:1: no-new-comments/);
  assert.match(duplicates.stderr, /old\.ts:2: no-new-comments/);

  write('new.ts', '');
  write('old.ts', 'const x = 1; /* inline */\n/* two\n   lines */\n');
  const inventory = run('--inventory');
  assert.equal(inventory.status, 0);
  assert.match(inventory.stdout, /old\.ts\t1\tprose\t0\t/);
  assert.match(inventory.stdout, /old\.ts\t2\tprose\t2\t/);
  assert.equal(run().status, 1);

  write('old.ts', 'export {};\n');
  git('add', 'old.ts');
  git('commit', '-qm', 'remove legacy prose');
  write('old.ts', '// existing\nexport {};\n');
  assert.match(run().stderr, /old\.ts:1: no-new-comments/);
});
