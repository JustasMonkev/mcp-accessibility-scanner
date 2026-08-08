#!/usr/bin/env node
/**
 * Head-to-head benchmark for "hand-rolled helper vs. off-the-shelf library".
 *
 * Every case below is a place in `src/` where a published package (or a newer
 * platform built-in) could stand in for code this repo maintains itself. Each
 * one runs both implementations over the same fixtures, checks they agree
 * where they are supposed to, and reports ns/op so the trade can be judged on
 * numbers rather than taste.
 *
 * Usage:
 *   npm run build
 *   npm i --no-save acorn sanitize-filename content-type   # optional comparands
 *   node bench/library-vs-custom.mjs [--json out.json]
 *
 * Cases whose library is not installed are reported as skipped rather than
 * failing the run, so the script stays usable without the extra installs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { plainSnapshotText } from './fixture.mjs';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const libRoot = path.join(projectRoot, 'lib');

if (!fs.existsSync(libRoot))
  throw new Error('lib/ is missing - run `npm run build` first.');

// Resolved before anything runs: a report path that turns out to be unwritable
// must fail now rather than after the whole benchmark has been measured.
const reportPath = parseReportPath(process.argv.slice(2));

const { isFunctionSource } = await import(pathToFileURL(path.join(libRoot, 'utils/jsSource.js')));
const { sanitizeForFilePath } = await import(pathToFileURL(path.join(libRoot, 'utils/fileUtils.js')));
const { ManualPromise } = await import(pathToFileURL(path.join(libRoot, 'mcp/manualPromise.js')));

const results = [];

// --- case 1: RE2 vs. the built-in RegExp ---------------------------------
//
// `src/tools/auditSite.ts` and `src/tools/snapshot.ts` already reach for the
// re2 native addon instead of `new RegExp`, because both compile a pattern
// that arrives in a tool call. This measures what that safety costs.

const RE2 = require('re2');

const excludePatterns = [
  '\\.(png|jpe?g|gif|svg|webp|ico|css|js)$',
  '^/api/',
  '/(logout|signout)(/|$)',
  '\\?.*utm_source=',
  '^/(en|de|fr|es)/legal/',
];
const candidatePaths = [
  '/blog/2024/01/a-post-about-accessibility?utm_source=newsletter',
  '/assets/images/hero-banner.png',
  '/api/v2/users/4821',
  '/docs/getting-started/installation',
  '/en/legal/privacy-policy',
  '/account/logout',
  '/products/widget-1234/reviews?page=3&sort=recent',
];

// Two sizes, because the answer differs by an order of magnitude between them:
// the benchmark's own fixture page yields roughly a thousand snapshot lines,
// while a real application page routinely reaches ten times that.
const snapshotSizes = [
  ['typical page', plainSnapshotText(250).split('\n')],
  ['large page', plainSnapshotText(2000).split('\n')],
];
const searchPattern = 'Action \\d+';

bench('RE2 vs RegExp: compile 5 crawl exclude patterns', {
  custom: { label: 'RegExp (built-in)', run: () => excludePatterns.map(pattern => new RegExp(pattern, 'i')) },
  library: { label: 're2', run: () => excludePatterns.map(pattern => new RE2(pattern, 'i')) },
  incumbent: 'library',
  iterations: 200,
});

{
  const nativeCompiled = excludePatterns.map(pattern => new RegExp(pattern, 'i'));
  const re2Compiled = excludePatterns.map(pattern => new RE2(pattern, 'i'));
  const nativeRun = () => {
    let hits = 0;
    for (const value of candidatePaths) {
      if (nativeCompiled.some(pattern => pattern.test(value)))
        hits++;
    }
    return hits;
  };
  const re2Run = () => {
    let hits = 0;
    for (const value of candidatePaths) {
      if (re2Compiled.some(pattern => pattern.test(value)))
        hits++;
    }
    return hits;
  };
  assertEqual('exclude-path match parity', nativeRun(), re2Run());
  bench('RE2 vs RegExp: match 7 URLs against 5 patterns', {
    custom: { label: 'RegExp (built-in)', run: nativeRun },
    library: { label: 're2', run: re2Run },
    incumbent: 'library',
    iterations: 2000,
  });
}

for (const [label, snapshotLines] of snapshotSizes) {
  const nativePattern = new RegExp(searchPattern);
  const re2Pattern = new RE2(searchPattern);
  const nativeRun = () => snapshotLines.filter(line => nativePattern.test(line)).length;
  const re2Run = () => snapshotLines.filter(line => re2Pattern.test(line)).length;
  assertEqual(`snapshot search parity (${label})`, nativeRun(), re2Run());
  bench(`RE2 vs RegExp: search ${snapshotLines.length} snapshot lines (${label})`, {
    custom: { label: 'RegExp (built-in)', run: nativeRun },
    library: { label: 're2', run: re2Run },
    incumbent: 'library',
    iterations: 20,
  });
}

// The reason re2 is there at all: a user-supplied pattern that makes the
// built-in engine backtrack forever. Measured with a hard budget so a
// regression in re2 cannot hang the benchmark.
results.push(redosCase());

// --- case 2: hand-written JS lexer vs. acorn ------------------------------
//
// `src/utils/jsSource.ts` is ~190 lines of scanner whose only job is to answer
// "is this source a function literal?". acorn answers the same question with a
// real parser.

const acorn = tryRequire('acorn');

// `expected` is what `browser_evaluate` needs the answer to be: true when the
// source is a function literal it should call, false when it is an expression
// it should wrap. The tricky entries are the ones a naive `startsWith` check
// gets wrong -- grouping parens, comments before the head, an arrow inside a
// string, a regex literal in a parameter default.
const functionSourceCases = [
  ['() => {}', true],
  ['async (a, b) => a + b', true],
  ['function () { return 1; }', true],
  ['function* generate() { yield 1; }', true],
  ['(() => 1)', true],
  ['((x) => x)', true],
  ['(function named(a = /\\)/) { return a; })', true],
  ['x => x', true],
  ['async x => x', true],
  ['(x) /* comment */ => x', true],
  ['/* leading */ () => 1', true],
  ['(a = "=>") => a', true],
  ['document.title', false],
  ['(a + b)', false],
  ['window.__someHandler', false],
  ['1 + 2', false],
  ['[1, 2, 3].map(String)', false],
  ['`template ${value}`', false],
  ['(a, b)', false],
  ['({ a: 1 })', false],
  ['(function () {})()', false],
  ['obj.method.bind(obj)', false],
  ['("=>")', false],
];

if (acorn) {
  const acornIsFunctionSource = source => {
    try {
      // `preserveParens` keeps `(() => 1)` from ending at the inner arrow, so
      // the "did the parse consume the whole source" check stays meaningful.
      let node = acorn.parseExpressionAt(source, 0, { ecmaVersion: 'latest', preserveParens: true });
      if (skipSpace(source, node.end) !== source.length)
        return false;
      while (node.type === 'ParenthesizedExpression')
        node = node.expression;
      return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression';
    } catch {
      return false;
    }
  };
  const sources = functionSourceCases.map(([source]) => source);
  const customWrong = functionSourceCases.filter(([source, expected]) => isFunctionSource(source) !== expected).length;
  const libraryWrong = functionSourceCases.filter(([source, expected]) => acornIsFunctionSource(source) !== expected).length;
  bench(`isFunctionSource: hand lexer vs acorn (${sources.length} sources)`, {
    custom: { label: 'src/utils/jsSource.ts', run: () => sources.map(isFunctionSource) },
    library: { label: 'acorn.parseExpressionAt', run: () => sources.map(acornIsFunctionSource) },
    iterations: 2000,
    note: `wrong answers - hand lexer ${customWrong}/${sources.length}, acorn ${libraryWrong}/${sources.length}`,
  });
} else {
  skip('isFunctionSource: hand lexer vs acorn', 'acorn not installed');
}

// --- case 3: ManualPromise vs. Promise.withResolvers ----------------------
//
// `src/mcp/manualPromise.ts` subclasses Promise to expose resolve/reject.
// Node 22+ ships `Promise.withResolvers()`, and package.json requires >=24.

if (typeof Promise.withResolvers === 'function') {
  bench('deferred: ManualPromise vs Promise.withResolvers', {
    custom: {
      label: 'ManualPromise (Promise subclass)',
      run: () => {
        for (let index = 0; index < 100; index++) {
          const promise = new ManualPromise();
          promise.resolve(index);
        }
      },
    },
    library: {
      label: 'Promise.withResolvers (built-in)',
      run: () => {
        for (let index = 0; index < 100; index++) {
          const { resolve } = Promise.withResolvers();
          resolve(index);
        }
      },
    },
    iterations: 2000,
    note: 'ManualPromise also carries isDone(); withResolvers does not',
  });
} else {
  skip('deferred: ManualPromise vs Promise.withResolvers', 'Promise.withResolvers unavailable on this runtime');
}

// --- case 4: sanitizeForFilePath vs. sanitize-filename --------------------

const sanitizeFilename = tryRequire('sanitize-filename');
const fileNames = [
  '2026-08-08T10:20:30.123Z',
  'https://example.com/some/deep/path?query=1&other=2',
  'Report for "Acme Corp" <2026>',
  'plain-report.json',
  'a'.repeat(300) + '.json',
];

if (sanitizeFilename) {
  const differences = fileNames
      .filter(name => sanitizeForFilePath(name) !== sanitizeFilename(name))
      .length;
  bench('file names: sanitizeForFilePath vs sanitize-filename', {
    custom: { label: 'src/utils/fileUtils.ts', run: () => fileNames.map(sanitizeForFilePath) },
    library: { label: 'sanitize-filename', run: () => fileNames.map(name => sanitizeFilename(name)) },
    iterations: 5000,
    note: `${differences}/${fileNames.length} outputs differ - not a drop-in replacement`,
  });
} else {
  skip('file names: sanitizeForFilePath vs sanitize-filename', 'sanitize-filename not installed');
}

// --- case 5: content-type header parsing ----------------------------------

const contentTypeLib = tryRequire('content-type');
const headerValues = [
  'text/html; charset=utf-8',
  'application/json',
  'text/plain; charset="windows-1252"',
  'application/json, application/json',
  'image/png',
  '',
  'not a media type at all',
];

const customContentTypeOf = value => {
  const first = (value ?? '').split(',')[0];
  return {
    mimeType: first.split(';')[0].trim().toLowerCase(),
    charset: /;\s*charset\s*=\s*"?([^";]*)/i.exec(first)?.[1].trim() ?? '',
  };
};

if (contentTypeLib) {
  const libContentTypeOf = value => {
    try {
      const parsed = contentTypeLib.parse((value ?? '').split(',')[0]);
      return { mimeType: parsed.type, charset: parsed.parameters.charset ?? '' };
    } catch {
      return { mimeType: '', charset: '' };
    }
  };
  const throwsOn = headerValues.filter(value => {
    const parsed = libContentTypeOf(value);
    const custom = customContentTypeOf(value);
    return parsed.mimeType !== custom.mimeType || parsed.charset !== custom.charset;
  }).length;
  bench('content-type header: inline parse vs content-type', {
    custom: { label: 'src/tools/network.ts', run: () => headerValues.map(customContentTypeOf) },
    library: { label: 'content-type', run: () => headerValues.map(libContentTypeOf) },
    iterations: 5000,
    note: `${throwsOn}/${headerValues.length} inputs parse differently`,
  });
} else {
  skip('content-type header: inline parse vs content-type', 'content-type not installed');
}

// --- module load cost -----------------------------------------------------
//
// A benchmark of steady-state throughput hides what a dependency costs on a
// cold start, which for a stdio MCP server happens on every launch.
results.push(loadCostCase());

// --- the other direction: libraries no code reaches for -------------------
results.push(dependencyAudit());

report();

// --- harness --------------------------------------------------------------

/**
 * `incumbent` records which side the repo ships today. It is `library` for the
 * re2 cases -- there the package is what is already in `src/` and the built-in
 * is the comparand -- and `custom` everywhere else. Without it the table reads
 * as though re2 were a candidate being rejected.
 */
function bench(name, { custom, library, iterations, note, incumbent = 'custom' }) {
  const customStats = measure(custom.run, iterations);
  const libraryStats = measure(library.run, iterations);
  results.push({
    kind: 'bench',
    name,
    note,
    incumbent,
    custom: { label: custom.label, ...customStats },
    library: { label: library.label, ...libraryStats },
    speedup: customStats.medianNsPerOp / libraryStats.medianNsPerOp,
  });
}

/**
 * Times `run` in batches of `iterations`, keeping the median of 15 scored
 * batches after 5 warmup batches. Batching amortises the clock read, and the
 * median keeps a single GC pause from deciding the result.
 */
function measure(run, iterations) {
  const warmupBatches = 5;
  const scoredBatches = 15;
  const samples = [];
  for (let batch = 0; batch < warmupBatches + scoredBatches; batch++) {
    const startedAt = process.hrtime.bigint();
    for (let index = 0; index < iterations; index++)
      run();
    const elapsedNs = Number(process.hrtime.bigint() - startedAt);
    if (batch >= warmupBatches)
      samples.push(elapsedNs / iterations);
  }
  samples.sort((first, second) => first - second);
  return {
    medianNsPerOp: samples[Math.floor(samples.length / 2)],
    minNsPerOp: samples[0],
    maxNsPerOp: samples[samples.length - 1],
    batches: scoredBatches,
    iterations,
  };
}

function redosCase() {
  // Classic catastrophic-backtracking pattern; linear in re2, exponential in a
  // backtracking engine.
  const pattern = '^(a+)+$';
  const subject = 'a'.repeat(30) + 'b';
  const budgetMs = 2000;

  const re2Started = process.hrtime.bigint();
  new RE2(pattern).test(subject);
  const re2Ms = Number(process.hrtime.bigint() - re2Started) / 1e6;

  // Grow the subject until the built-in engine blows the budget, so the report
  // states the actual input length at which it stops being viable.
  let nativeMs = 0;
  let nativeLength = 0;
  for (let length = 20; length <= 40; length++) {
    const probe = 'a'.repeat(length) + 'b';
    const startedAt = process.hrtime.bigint();
    new RegExp(pattern).test(probe);
    nativeMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    nativeLength = length;
    if (nativeMs > budgetMs)
      break;
  }

  return {
    kind: 'redos',
    name: `ReDoS: /${pattern}/ against "a"×n + "b"`,
    re2Ms,
    re2Length: subject.length - 1,
    nativeMs,
    nativeLength,
  };
}

function loadCostCase() {
  const modules = [
    ['re2 (native addon)', 're2'],
    ['acorn', 'acorn'],
    ['sanitize-filename', 'sanitize-filename'],
    ['content-type', 'content-type'],
  ];
  // The first `require()` in a process carries a fixed cost -- CommonJS loader
  // setup and this sandbox's module resolution -- that belongs to Node, not to
  // any package, and here it dominates every small module. Rather than try to
  // subtract it, an empty module is measured the same way and reported as the
  // baseline: the number worth reading is each row's distance from it.
  const baseline = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'bench-load-')), 'empty.cjs');
  fs.writeFileSync(baseline, 'module.exports = {};\n');
  try {
    const entries = [{ label: 'baseline: empty module', ms: coldRequireMs(baseline) }];
    for (const [label, specifier] of modules)
      entries.push({ label, ms: canResolve(specifier) ? coldRequireMs(specifier) : null });
    return { kind: 'load', name: 'cold module load cost (median of 5 fresh processes)', entries };
  } finally {
    fs.rmSync(path.dirname(baseline), { recursive: true, force: true });
  }
}

/**
 * Times a single `require` in a fresh process. Busting `require.cache` in this
 * one would leave the module's compiled code and its dependencies warm, which
 * understated acorn by 4x when this was written that way.
 */
function coldRequireMs(specifier) {
  const samples = [];
  for (let run = 0; run < 5; run++) {
    const printed = execFileSync(process.execPath, [
      '-e',
      `const t=process.hrtime.bigint();require(${JSON.stringify(specifier)});` +
      `process.stdout.write(String(Number(process.hrtime.bigint()-t)/1e6));`,
    ], { cwd: projectRoot, encoding: 'utf8' });
    samples.push(Number(printed));
  }
  samples.sort((first, second) => first - second);
  return samples[Math.floor(samples.length / 2)];
}

/**
 * The mirror image of the cases above: a declared dependency that no source
 * file imports is a library already chosen over code that was never written.
 * Scans `src/` for import/require specifiers and reports the shortfall, with
 * the installed footprint of anything unreferenced.
 */
function dependencyAudit() {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const declared = Object.keys(manifest.dependencies ?? {});
  const sources = collectFiles(path.join(projectRoot, 'src'), /\.(ts|mts|cts)$/);
  const specifiers = new Set();
  const specifierPattern = /(?:from\s*|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(specifierPattern)) {
      const specifier = match[1];
      // Reduce `playwright-core/lib/coreBundle` to the package that owns it.
      const parts = specifier.split('/');
      specifiers.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
    }
  }
  const unreferenced = declared.filter(name => !specifiers.has(name)).map(name => ({
    name,
    diskBytes: directorySize(path.join(projectRoot, 'node_modules', name)),
  }));
  return { kind: 'audit', name: 'declared dependencies no src/ file imports', declared: declared.length, unreferenced };
}

function collectFiles(directory, pattern) {
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory())
      out.push(...collectFiles(full, pattern));
    else if (pattern.test(entry.name))
      out.push(full);
  }
  return out;
}

function directorySize(directory) {
  if (!fs.existsSync(directory))
    return null;
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory())
      total += directorySize(full) ?? 0;
    else if (entry.isFile())
      total += fs.statSync(full).size;
  }
  return total;
}

function canResolve(specifier) {
  try {
    require.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

function tryRequire(specifier) {
  try {
    return require(specifier);
  } catch {
    return undefined;
  }
}

function skip(name, reason) {
  results.push({ kind: 'skip', name, reason });
}

function assertEqual(what, first, second) {
  if (first !== second)
    throw new Error(`${what}: implementations disagree (${first} vs ${second})`);
}

function skipSpace(source, offset) {
  while (offset < source.length && /\s/.test(source[offset]))
    offset++;
  return offset;
}

function report() {
  const rows = [['Case', 'In-repo / built-in', 'Package', 'Package is', 'Ships today']];
  for (const entry of results) {
    if (entry.kind !== 'bench')
      continue;
    const ratio = entry.speedup;
    const verdict = ratio >= 1
      ? `${ratio.toFixed(2)}x faster`
      : `${(1 / ratio).toFixed(2)}x slower`;
    rows.push([
      entry.name,
      formatNs(entry.custom.medianNsPerOp),
      formatNs(entry.library.medianNsPerOp),
      verdict,
      entry.incumbent === 'library' ? 'the package' : 'in-repo code',
    ]);
  }
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)));
  rows.forEach((row, index) => {
    process.stdout.write(`| ${row.map((cell, column) => cell.padEnd(widths[column])).join(' | ')} |\n`);
    if (index === 0)
      process.stdout.write(`|${widths.map(width => '-'.repeat(width + 2)).join('|')}|\n`);
  });

  process.stdout.write('\n');
  for (const entry of results) {
    if (entry.kind === 'bench' && entry.note)
      process.stdout.write(`note  ${entry.name}: ${entry.note}\n`);
    if (entry.kind === 'skip')
      process.stdout.write(`skip  ${entry.name}: ${entry.reason}\n`);
    if (entry.kind === 'redos') {
      process.stdout.write(`redos ${entry.name}\n`);
      process.stdout.write(`        re2:    ${entry.re2Ms.toFixed(3)} ms at n=${entry.re2Length}\n`);
      process.stdout.write(`        RegExp: ${entry.nativeMs.toFixed(1)} ms at n=${entry.nativeLength}\n`);
    }
    if (entry.kind === 'load') {
      process.stdout.write(`load  ${entry.name}\n`);
      for (const module of entry.entries)
        process.stdout.write(`        ${module.label.padEnd(22)} ${module.ms === null ? 'not installed' : `${module.ms.toFixed(2)} ms`}\n`);
    }
    if (entry.kind === 'audit') {
      process.stdout.write(`audit ${entry.name} (${entry.unreferenced.length} of ${entry.declared})\n`);
      for (const dependency of entry.unreferenced) {
        const size = dependency.diskBytes === null ? 'not installed' : `${(dependency.diskBytes / 1024 / 1024).toFixed(2)} MB on disk`;
        process.stdout.write(`        ${dependency.name.padEnd(26)} ${size}\n`);
      }
    }
  }

  if (reportPath) {
    fs.writeFileSync(reportPath, JSON.stringify({ node: process.version, results }, null, 2));
    process.stdout.write(`\nWrote ${reportPath}\n`);
  }
}

function parseReportPath(argv) {
  const index = argv.indexOf('--json');
  // `--json` is the only flag. A mistyped or unsupported one must say so rather
  // than run the whole benchmark and quietly drop the report.
  const unknown = argv.filter((argument, position) => argument.startsWith('--') && position !== index);
  if (unknown.length)
    throw new Error(`Unsupported flag(s): ${unknown.join(', ')}. The only flag is --json <path>.`);
  if (index === -1) {
    if (argv.length)
      throw new Error(`Unexpected argument(s): ${argv.join(', ')}. Usage: node bench/library-vs-custom.mjs [--json <path>]`);
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith('--') || !value.trim())
    throw new Error(`--json needs a file path, got: ${value ?? '(nothing)'}`);
  if (argv.length > index + 2 || index !== 0)
    throw new Error(`Unexpected argument(s) around --json. Usage: node bench/library-vs-custom.mjs [--json <path>]`);
  const resolved = path.resolve(value);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory())
    throw new Error(`--json parent must be a directory: ${parent}`);
  fs.accessSync(parent, fs.constants.W_OK);
  if (fs.existsSync(resolved)) {
    if (!fs.statSync(resolved).isFile())
      throw new Error(`--json must name a file: ${resolved}`);
    fs.accessSync(resolved, fs.constants.W_OK);
  }
  return resolved;
}

function formatNs(value) {
  if (value >= 1e6)
    return `${(value / 1e6).toFixed(2)} ms`;
  if (value >= 1e3)
    return `${(value / 1e3).toFixed(2)} µs`;
  return value.toFixed(1);
}
