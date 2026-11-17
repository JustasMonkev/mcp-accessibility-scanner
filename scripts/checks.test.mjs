import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const fixtures = [];
after(() => fixtures.forEach(directory => rmSync(directory, { recursive: true, force: true })));

const compilerOptions = { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, verbatimModuleSyntax: true, noEmit: true };
const tsconfig = JSON.stringify({ compilerOptions, include: ['src'] });
const tsconfigWithoutVerbatim = JSON.stringify({ compilerOptions: { ...compilerOptions, verbatimModuleSyntax: false }, include: ['src'] });
const manifest = { name: 'fixture', version: '1.0.0', type: 'module', dependencies: { zod: '4.6.7' }, devDependencies: { vitest: '5.0.5' } };

describe('check-deps-list', () => {
  const layout = {
    'src/DEPS.list': '[*]\n./tools/\n./utils/\n',
    'src/tools/DEPS.list': '[*]\n../utils/\n',
    'src/utils/DEPS.list': '[*]\n',
    'src/tab.ts': 'export class Tab {}\n',
    'src/utils/log.ts': 'export const log = 1;\n',
    'src/tools/a.ts': 'export const a = 1;\n',
  };

  test('allows listed directories, own directory and type-only imports', () => {
    const result = run('check-deps-list.mjs', project({ ...layout, 'src/tools/b.ts': "import { log } from '../utils/log.js';\nimport { a } from './a.js';\nimport type { Tab } from '../tab.js';\nexport const b: Tab | number = log + a;\n" }));
    assert.equal(result.status, 0, result.output);
  });

  test('rejects a value import the nearest DEPS.list does not list, and names the rule', () => {
    const result = run('check-deps-list.mjs', project({ ...layout, 'src/tools/b.ts': "import { Tab } from '../tab.js';\nexport const b = new Tab();\n" }));
    assert.equal(result.status, 1);
    assert.match(result.output, /src\/tools\/b\.ts:1 imports src\/tab\.ts; src\/tools\/DEPS\.list allows \.\.\/utils\//);
  });

  test('treats a re-export and a dynamic import as value imports', () => {
    const result = run('check-deps-list.mjs', project({ ...layout, 'src/utils/b.ts': "export { a } from '../tools/a.js';\nexport const load = () => import('../tab.js');\n" }));
    assert.equal(result.status, 1);
    assert.match(result.output, /src\/utils\/b\.ts:1 imports src\/tools\/a\.ts/);
    assert.match(result.output, /src\/utils\/b\.ts:2 imports src\/tab\.ts/);
  });

  test('treats inline type-only imports and re-exports as value imports under verbatimModuleSyntax', () => {
    const result = run('check-deps-list.mjs', project({ ...layout, 'src/tools/b.ts': "import { type Tab } from '../tab.js';\nexport { type Tab as Other } from '../tab.js';\nexport const b: Tab | undefined = undefined;\n" }));
    assert.equal(result.status, 1);
    assert.match(result.output, /src\/tools\/b\.ts:1 imports src\/tab\.ts/);
    assert.match(result.output, /src\/tools\/b\.ts:2 imports src\/tab\.ts/);
  });

  test('a [file] section adds an exception for that file only', () => {
    const files = { ...layout, 'src/tools/DEPS.list': '[*]\n../utils/\n[b.ts]\n../tab.js\n', 'src/tools/b.ts': "import { Tab } from '../tab.js';\nexport const b = new Tab();\n", 'src/tools/c.ts': "import { Tab } from '../tab.js';\nexport const c = new Tab();\n" };
    const result = run('check-deps-list.mjs', project(files));
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.output, /b\.ts:1/);
    assert.match(result.output, /src\/tools\/c\.ts:1 imports src\/tab\.ts/);
  });

  test('a dir/** entry allows that subtree, not a sibling directory sharing its prefix', () => {
    const files = {
      ...layout,
      'src/tools/DEPS.list': '[*]\n../utils/**\n',
      'src/utils/deep/x.ts': 'export const x = 1;\n',
      'src/utils-extra/y.ts': 'export const y = 1;\n',
      'src/tools/b.ts': "import { x } from '../utils/deep/x.js';\nimport { y } from '../utils-extra/y.js';\nexport const b = x + y;\n",
    };
    const result = run('check-deps-list.mjs', project(files));
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.output, /b\.ts:1/);
    assert.match(result.output, /src\/tools\/b\.ts:2 imports src\/utils-extra\/y\.ts/);
  });

  test('reports an entry that matches nothing', () => {
    const result = run('check-deps-list.mjs', project({ ...layout, 'src/tools/DEPS.list': '[*]\n../utils/\n../gone/\n' }));
    assert.equal(result.status, 1);
    assert.match(result.output, /src\/tools\/DEPS\.list: entry \.\.\/gone\/ matches nothing/);
  });
});

describe('check-runtime-deps', () => {
  test('passes declared dependencies, builtins and type-only devDependency imports', () => {
    const result = run('check-runtime-deps.mjs', project({ 'src/a.ts': "import { z } from 'zod';\nimport { join } from 'node:path';\nimport type { Mock } from 'vitest';\nexport const a = [z, join] as unknown as Mock;\n" }));
    assert.equal(result.status, 0, result.output);
  });

  test('rejects a runtime import of a devDependency', () => {
    const result = run('check-runtime-deps.mjs', project({ 'src/a.ts': "import { vi } from 'vitest';\nexport const a = vi;\n" }));
    assert.equal(result.status, 1);
    assert.match(result.output, /src\/a\.ts:1: vitest is only a devDependency/);
  });

  test('rejects inline type-only imports and re-exports of a devDependency under verbatimModuleSyntax', () => {
    const source = "import { type Mock } from 'vitest';\nexport { type Mock as Other } from 'vitest';\nexport const a: Mock | undefined = undefined;\n";
    const result = run('check-runtime-deps.mjs', project({ 'src/a.ts': source }));
    assert.equal(result.status, 1);
    assert.match(result.output, /src\/a\.ts:1: vitest is only a devDependency/);
    assert.match(result.output, /src\/a\.ts:2: vitest is only a devDependency/);
    const erased = run('check-runtime-deps.mjs', project({ 'src/a.ts': source, 'tsconfig.json': tsconfigWithoutVerbatim }));
    assert.equal(erased.status, 0, erased.output);
  });

  test('rejects an undeclared package reached through a subpath', () => {
    const result = run('check-runtime-deps.mjs', project({ 'src/a.ts': "import x from 'playwright-core/lib/coreBundle';\nexport const a = x;\n" }));
    assert.equal(result.status, 1);
    assert.match(result.output, /playwright-core\/lib\/coreBundle is not declared/);
  });
});

describe('check-pinned-deps', () => {
  test('passes exact versions and non-registry specifiers', () => {
    const result = run('check-pinned-deps.mjs', project({}, { ...manifest, devDependencies: { local: 'file:../local', aliased: 'npm:zod@4.6.7' } }));
    assert.equal(result.status, 0, result.output);
  });

  test('rejects a range', () => {
    const result = run('check-pinned-deps.mjs', project({}, { ...manifest, dependencies: { zod: '^4.6.7' } }));
    assert.equal(result.status, 1);
    assert.match(result.output, /dependencies\.zod must be pinned, found \^4\.6\.7/);
  });
});

describe('check-lockfile-commit', () => {
  const lock = packages => JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages });
  const native = { 'node_modules/binding-linux-x64-gnu': { version: '1.0.0', optional: true, os: ['linux'], cpu: ['x64'], libc: ['glibc'] } };

  test('ignores commits that do not stage package-lock.json', () => {
    const cwd = repository(lock(native));
    stage(cwd, 'README.md', 'docs\n');
    assert.equal(run('check-lockfile-commit.mjs', cwd).status, 0);
  });

  test('blocks a staged lockfile change unless ALLOW_LOCKFILE_CHANGE is set', () => {
    const cwd = repository(lock(native));
    stage(cwd, 'package-lock.json', lock({ ...native, 'node_modules/zod': { version: '4.6.7' } }));
    const blocked = run('check-lockfile-commit.mjs', cwd);
    assert.equal(blocked.status, 1);
    assert.match(blocked.output, /added zod@4\.6\.7/);
    assert.equal(run('check-lockfile-commit.mjs', cwd, { ALLOW_LOCKFILE_CHANGE: '1' }).status, 0);
  });

  test('blocks dropped platform fields even when ALLOW_LOCKFILE_CHANGE is set', () => {
    const cwd = repository(lock(native));
    const withoutLibc = { version: '1.0.0', optional: true, os: ['linux'], cpu: ['x64'] };
    stage(cwd, 'package-lock.json', lock({ 'node_modules/binding-linux-x64-gnu': withoutLibc }));
    const result = run('check-lockfile-commit.mjs', cwd, { ALLOW_LOCKFILE_CHANGE: '1' });
    assert.equal(result.status, 1);
    assert.match(result.output, /binding-linux-x64-gnu lost "libc"/);
  });

  test('rejects a staged or committed lockfile that is not JSON, and allows deleting the lockfile', () => {
    const malformed = repository(lock(native));
    stage(malformed, 'package-lock.json', '{ "packages": ');
    const result = run('check-lockfile-commit.mjs', malformed, { ALLOW_LOCKFILE_CHANGE: '1' });
    assert.equal(result.status, 1);
    assert.match(result.output, /cannot be read as JSON/);

    const corruptBase = repository('{ "packages": ');
    stage(corruptBase, 'package-lock.json', lock(native));
    const unreadableBase = run('check-lockfile-commit.mjs', corruptBase, { ALLOW_LOCKFILE_CHANGE: '1' });
    assert.equal(unreadableBase.status, 1);
    assert.match(unreadableBase.output, /at HEAD cannot be read as JSON/);

    const missingBlob = repository(lock(native));
    const blob = execFileSync('git', ['rev-parse', 'HEAD:package-lock.json'], { cwd: missingBlob, encoding: 'utf8' }).trim();
    rmSync(join(missingBlob, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    stage(missingBlob, 'package-lock.json', lock({ ...native, 'node_modules/zod': { version: '4.6.7' } }));
    assert.equal(run('check-lockfile-commit.mjs', missingBlob, { ALLOW_LOCKFILE_CHANGE: '1' }).status, 1);

    const firstCommit = project({});
    execFileSync('git', ['init', '-q'], { cwd: firstCommit });
    stage(firstCommit, 'package-lock.json', lock(native));
    assert.equal(run('check-lockfile-commit.mjs', firstCommit, { ALLOW_LOCKFILE_CHANGE: '1' }).status, 0);

    const removed = repository(lock(native));
    execFileSync('git', ['rm', '-q', 'package-lock.json'], { cwd: removed });
    assert.equal(run('check-lockfile-commit.mjs', removed, { ALLOW_LOCKFILE_CHANGE: '1' }).status, 0);
  });
});

function repository(lockfile) {
  const cwd = project({ 'package-lock.json': lockfile });
  const git = args => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git(['init', '-q']);
  git(['add', '.']);
  git(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '--no-verify', '--no-gpg-sign', '-m', 'base']);
  return cwd;
}

function stage(cwd, path, content) {
  writeFileSync(join(cwd, path), content);
  execFileSync('git', ['add', path], { cwd });
}

function project(files, packageJson = manifest) {
  const directory = mkdtempSync(join(tmpdir(), 'scanner-checks-'));
  fixtures.push(directory);
  for (const [path, content] of Object.entries({ 'tsconfig.json': tsconfig, 'package.json': JSON.stringify(packageJson), ...files })) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  return directory;
}

function run(script, cwd, env = {}) {
  const result = spawnSync(process.execPath, [join(scripts, script)], { cwd, encoding: 'utf8', env: { ...process.env, ALLOW_LOCKFILE_CHANGE: '', ...env } });
  return { status: result.status, output: result.stdout + result.stderr };
}
