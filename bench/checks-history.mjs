// Replays the structural checks in scripts/ over main's history. For every change that landed on main (each
// first-parent commit), runs each check on the tree before and after it and records the violations the change
// introduced and removed. Today's check scripts run against each historical tree.
//
// Usage: node bench/checks-history.mjs [--range <rev-range>] [--out <file.jsonl>] [--jobs <n>]
//   --range  commits to replay (default: origin/main, i.e. all of main's history)
//   --out    JSON lines, one record per landed change (default: stdout)
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checks = {
  'pinned-deps': 'scripts/check-pinned-deps.mjs',
  'runtime-deps': 'scripts/check-runtime-deps.mjs',
  'deps-list': 'scripts/check-deps-list.mjs',
};
// Only these paths decide the checks' results; extracting just them keeps a replay fast.
const inputs = ['src', 'tsconfig.json', 'package.json'];

const options = parseArgs(process.argv.slice(2));
const workspace = mkdtempSync(join(tmpdir(), 'checks-history-'));
const results = new Map();

try {
  const changes = git(['log', '--first-parent', '--reverse', '--format=%H %P%x09%s', options.range])
      .split('\n').filter(Boolean).map(parseChange);
  const commits = [...new Set(changes.flatMap(change => [change.base, change.commit]).filter(Boolean))];
  await runPool(commits, options.jobs, async commit => results.set(commit, await checkTree(commit)));
  const lines = changes.map(change => JSON.stringify(compare(change)));
  if (options.out)
    writeFileSync(options.out, lines.join('\n') + '\n');
  else
    process.stdout.write(lines.join('\n') + '\n');
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

function parseChange(line) {
  const [shas, subject] = line.split('\t');
  const [commit, base] = shas.split(' ');
  const pr = subject.match(/^Merge pull request #(\d+)/)?.[1] ?? subject.match(/\(#(\d+)\)$/)?.[1];
  return { commit, base, subject, pr: pr ? Number(pr) : undefined };
}

async function checkTree(commit) {
  const directory = join(workspace, commit);
  mkdirSync(directory);
  const present = inputs.filter(path => git(['ls-tree', '--name-only', commit, path]).trim());
  if (!present.includes('src') || !present.includes('tsconfig.json'))
    return { skipped: 'no src/ or tsconfig.json' };
  execFileSync('sh', ['-c', `git -C "${root}" archive ${commit} ${present.join(' ')} | tar -x -C "${directory}"`]);
  const tree = {};
  for (const [name, script] of Object.entries(checks))
    tree[name] = await runCheck(join(root, script), directory);
  rmSync(directory, { recursive: true, force: true });
  return tree;
}

function runCheck(script, cwd) {
  const started = performance.now();
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [script], { cwd });
    let output = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => output += chunk);
    child.on('close', status => resolvePromise({
      status,
      ms: Math.round(performance.now() - started),
      violations: violationsIn(output),
      ...(status !== 0 && violationsIn(output).length === 0 ? { error: output.trim().split('\n').slice(-3).join(' | ') } : {}),
    }));
  });
}

// Violation lines are indented. Line numbers and found versions change between commits without changing the
// violation, so they are dropped before comparing.
function violationsIn(output) {
  return output.split('\n').filter(line => line.startsWith('  ')).map(line => line.trim()
      .replace(/^([^:\s]+):\d+(?=[:\s])/, '$1')
      .replace(/, found .*$/, ''));
}

function compare(change) {
  const before = change.base ? results.get(change.base) : undefined;
  const after = results.get(change.commit);
  const record = { commit: change.commit.slice(0, 10), pr: change.pr, subject: change.subject, checks: {} };
  for (const name of Object.keys(checks)) {
    const was = before?.[name];
    const is = after?.[name];
    if (!is) {
      record.checks[name] = { skipped: after?.skipped ?? 'no result' };
      continue;
    }
    const old = new Set(was?.violations ?? []);
    const now = new Set(is.violations);
    record.checks[name] = {
      status: is.status,
      ms: is.ms,
      total: now.size,
      introduced: [...now].filter(violation => !old.has(violation)),
      removed: [...old].filter(violation => !now.has(violation)),
      ...(is.error ? { error: is.error } : {}),
    };
  }
  return record;
}

async function runPool(items, size, work) {
  let next = 0;
  const worker = async () => {
    while (next < items.length)
      await work(items[next++]);
  };
  await Promise.all(Array.from({ length: size }, worker));
}

function git(args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function parseArgs(args) {
  const parsed = { range: 'origin/main', out: undefined, jobs: 4 };
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]];
    if (flag === '--range')
      parsed.range = value;
    else if (flag === '--out')
      parsed.out = value;
    else if (flag === '--jobs')
      parsed.jobs = Number(value);
    else
      throw new Error(`Unknown option ${flag}. Usage: node bench/checks-history.mjs [--range <rev-range>] [--out <file>] [--jobs <n>]`);
  }
  return parsed;
}
