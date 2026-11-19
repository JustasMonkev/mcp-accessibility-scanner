import assert from 'node:assert/strict';
import { Console } from 'node:console';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { fixtures } from './all-utils-fixtures.mjs';
import { exposeInternals, inspectModule } from './all-utils-inventory.mjs';

const roots = process.argv.slice(2, 4).map(root => path.resolve(root));
const profile = process.argv[4] === '--callbacks';
if (roots.length !== 2 || process.argv.length > 5 || (process.argv[4] && !profile))
  throw new Error('Usage: node bench/all-utils.mjs <baseline checkout> <candidate checkout> [--callbacks]');

const output = { last: '' };
const sink = new Writable({ write(chunk, encoding, done) { output.last = chunk.toString(); done(); } });
globalThis.console = new Console(sink, sink);
const files = new Map();
const revisions = [];
for (const root of roots) {
  const dir = path.join(root, 'lib/utils');
  const names = (await readdir(dir)).filter(name => name.endsWith('.js')).sort().map(name => name.slice(0, -3));
  const sourceNames = (await readdir(path.join(root, 'src/utils'))).filter(name => name.endsWith('.ts')).sort().map(name => name.slice(0, -3));
  assert.deepEqual(names, sourceNames, 'Build both checkouts before running the benchmarks');
  const modules = new Map(names.map(name => [name, path.join(dir, name + '.js')]));
  modules.set('tools/utils', path.join(root, 'lib/tools/utils.js'));
  for (const file of modules.values())
    files.set(file, inspectModule(file));
  revisions.push({ commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), modules });
}
const hooks = exposeInternals(files, profile);
const callbackTimes = new Map();
const captured = new Map();
const synthetic = new Set();
if (profile) {
  globalThis.__captureUtilsCallback = (key, event, callback) => {
    captured.set(key, { event, callback });
    return callback;
  };
  globalThis.__recordUtilsTime = (key, ms) => {
    const times = callbackTimes.get(key);
    if (times)
      times.push(ms * 1000);
    else
      callbackTimes.set(key, [ms * 1000]);
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
}

async function batch(row, size, check = false) {
  const inputs = row.prepare ? Array.from({ length: size }, () => row.prepare()) : [];
  const outputs = new Array(size);
  const start = performance.now();
  if (row.async) {
    for (let i = 0; i < size; i++)
      outputs[i] = await row.run(inputs[i]);
  } else {
    for (let i = 0; i < size; i++)
      outputs[i] = row.run(inputs[i]);
  }
  const elapsed = performance.now() - start;
  try {
    return { us: elapsed * 1000 / size, value: check && (row.project ? row.project(outputs[0], inputs[0]) : outputs[0]) };
  } finally {
    if (row.cleanup) {
      for (let i = 0; i < size; i++)
        await row.cleanup(outputs[i], inputs[i]);
    }
  }
}

async function compare(name, rows) {
  const expected = [];
  const sizes = [];
  const samples = [[], []];
  for (const [i, row] of rows.entries()) {
    if (!row)
      continue;
    expected[i] = (await batch(row, 1, true)).value;
    let size = 1;
    const limit = profile ? 1 : row.limit ?? (row.async ? 32 : 4096);
    while (size < limit && (await batch(row, size)).us * size < 2000)
      size *= 2;
    sizes[i] = size;
  }
  if (rows.every(Boolean)) {
    assert.deepEqual(expected[0], expected[1], name);
    sizes.fill(Math.min(...sizes));
  }
  const rounds = profile ? 3 : 16;
  for (let round = 0; round < rounds; round++) {
    for (const i of round % 2 ? [1, 0] : [0, 1]) {
      if (!rows[i])
        continue;
      const result = await batch(rows[i], sizes[i], true);
      assert.deepEqual(result.value, expected[i], name);
      if (round >= 4)
        samples[i].push(result.us);
    }
  }
  return { name, batchSizes: sizes, medianUs: samples.map(s => s.length ? median(s) : null), samplesUs: samples };
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'all-utils-'));
let context;
try {
  // Select only this disposable profile for the Linux channel-discovery fixture.
  process.env.CHROME_USER_DATA_DIR = directory;
  process.env.DEBUG = '';
  const { chromium } = await import('playwright');
  context = await chromium.launchPersistentContext(directory, {
    executablePath: process.env.CHROME_HEADLESS_SHELL || undefined,
    headless: true, chromiumSandbox: false, args: ['--remote-debugging-port=0'],
  });
  const port = (await readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
  const endpoint = `http://127.0.0.1:${port}`;
  const page = context.pages()[0] ?? await context.newPage();
  await page.setContent('<title>Benchmark</title><button>Save</button>');
  const tab = { page, context: { config: { timeouts: { settle: 0 } } }, waitForTimeout: ms => page.waitForTimeout(ms), waitForLoadState: state => page.waitForLoadState(state) };
  const tables = [];
  const allModules = [];
  for (const revision of revisions) {
    const modules = {};
    for (const [name, file] of revision.modules) {
      const imported = await import(pathToFileURL(file));
      modules[name] = { ...imported.__benchPrivate, ...imported };
    }
    allModules.push(modules);
    let sequence = 0;
    const importMetadata = () => import(pathToFileURL(revision.modules.get('package')).href + '?bench=' + ++sequence);
    const table = fixtures(modules, { tab, endpoint, output, importMetadata });
    table.set('control/sync call', { run: () => 42 });
    table.set('control/resolved promise', { run: () => Promise.resolve(42), async: true });
    for (const [name, file] of revision.modules) {
      const targets = new Set(files.get(file).targets);
      for (const [key, value] of Object.entries(modules[name])) {
        if (typeof value === 'function' && !targets.has(key + '.constructor'))
          targets.add(key);
      }
      for (const target of targets)
        assert.ok(table.has(name + '/' + target), 'Missing fixture: ' + name + '/' + target);
    }
    tables.push(table);
  }
  const results = [];
  const names = new Set(tables.flatMap(table => [...table.keys()]));
  for (const name of names) {
    try {
      results.push(await compare(name, tables.map(table => table.get(name))));
    } catch (error) {
      throw new Error('Benchmark failed for ' + name, { cause: error });
    }
  }
  if (profile) {
    const { exerciseLifecycleCallbacks } = await import('./all-utils-lifecycle.mjs');
    for (const [i, modules] of allModules.entries()) {
      const file = revisions[i].modules.get('cdpConnection');
      await exerciseLifecycleCallbacks(modules, tab, endpoint, file, captured, callbackTimes, synthetic);
    }
  }
  const callbacks = revisions.map(revision => [...revision.modules].flatMap(([module, file]) => files.get(file).callbacks.map(({ id }) => {
    const values = callbackTimes.get(file + '#' + id) ?? [];
    return { module, id, synthetic: synthetic.has(file + '#' + id), calls: values.length, medianUs: values.length ? median(values) : null };
  })));
  if (profile && process.platform === 'linux') {
    const missed = callbacks.flat().filter(entry => !entry.calls);
    assert.deepEqual(missed, [], 'A nested callback has no timing observations');
  }
  const report = { node: process.version, cpu: os.cpus()[0].model, browser: context.browser().version(), revisions: revisions.map(r => r.commit),
    ...(profile ? { callbacks } : { results }) };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
  await context?.close();
  hooks.deregister();
  await rm(directory, { recursive: true, force: true });
}
