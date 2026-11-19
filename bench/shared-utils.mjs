import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { median } from './statistics.mjs';

// Build both checkouts, then pass their lib/utils directories, baseline first.
if (process.argv.length !== 4)
  throw new Error('Usage: node bench/shared-utils.mjs <baseline-lib/utils> <candidate-lib/utils>');

const paragraph = index => `  - paragraph "Item ${index}" [ref=e${index}]`;
const snapshot = length => Array.from({ length }, (_, i) => paragraph(i)).join('\n');
const tokens = Array.from({ length: 48 }, (_, i) => String(i));
const edited = tokens.with(24, 'edited');
const urls = Array.from({ length: 4000 }, (_, i) => `https://example.org/catalog/section-${i % 40}/item-${i}`);
const quoted = 'He said "save" and clicked "continue".';
const fixtures = [
  ['ariaCompression', 'compressAriaSnapshot', '40 sibling paragraphs', [snapshot(40)]],
  ['ariaCompression', 'compressAriaSnapshot', '1000 sibling paragraphs', [snapshot(1000)]],
  ['htmlPatterns', 'withinEditDistance', '48 tokens, one changed', [tokens, edited, 14]],
  ['htmlPatterns', 'withinEditDistance', '48 unrelated tokens', [tokens, tokens.map(t => `other-${t}`), 14]],
  ['htmlPatterns', 'htmlTokens', 'ordinary input', ['<input type="text" name="query" placeholder="Search">']],
  ['htmlPatterns', 'semanticSignature', 'input with ordinary attributes', ['<input type="text" name="query" placeholder="Search">']],
  ['htmlPatterns', 'semanticSignature', 'type and role before 40 attributes', ['<input type="text" role="combobox" ' + Array.from({ length: 40 }, (_, i) => `data-field-${i}="value"`).join(' ') + '>']],
  ['dataUrl', 'truncateDataUrls', 'short raw SVG', ['data:image/svg+xml,<svg x="3"></svg> end']],
  ['dataUrl', 'truncateDataUrls', 'SVG with 1024 internal spaces', [`data:image/svg+xml,<svg><text>x${' '.repeat(1024)}y</text></svg> end`]],
  ['dataUrl', 'truncateDataUrls', 'quoted SVG with 64 KiB text', [`"data:image/svg+xml,<svg><text>${'x'.repeat(65536)}</text></svg>" end`]],
  ['dataUrl', 'truncateDataUrls', 'ordinary console message', ['loaded https://example.org/app in 139ms']],
  ['fileUtils', 'truncateToUtf8Bytes', 'short filename, 240-byte budget', ['report-Šilalė.json', 240]],
  ['fileUtils', 'truncateToUtf8Bytes', '1 MiB ASCII, 2000-byte budget', ['x'.repeat(1024 * 1024), 2000]],
  ['fileUtils', 'truncateToUtf8Bytes', '1 MiB UTF-8, 2000-byte budget', ['🚀'.repeat(256 * 1024), 2000]],
  ['representativeUrls', 'selectRepresentativeUrls', '4000 URLs, budget 100', [urls, 100]],
  ['codegen', 'escapeWithQuotes', 'double-quoted label', [quoted, '"']],
  ['jsSource', 'isFunctionSource', 'parenthesized expression, 64 operands', ['(' + new Array(64).fill('value').join(' + ') + ')']],
  ['guid', 'createHash', 'short fingerprint', [quoted]],
];

function batch(run, iterations) {
  let output;
  const start = performance.now();
  for (let index = 0; index < iterations; index++)
    output = run();
  return { output, elapsed: performance.now() - start };
}

const roots = process.argv.slice(2);
const results = [];
for (const [module, name, fixture, args] of fixtures) {
  const runs = await Promise.all(roots.map(async root => {
    const fn = (await import(pathToFileURL(path.resolve(root, module + '.js'))))[name];
    return () => fn(...args);
  }));
  const expected = runs[0]();
  assert.deepEqual(runs[1](), expected, fixture);
  const sizes = runs.map(run => {
    let size = 1;
    while (size < 65536 && batch(run, size).elapsed < 4)
      size *= 2;
    return size;
  });
  const samples = [[], []];
  for (let round = 0; round < 26; round++) {
    for (const i of round % 2 ? [1, 0] : [0, 1]) {
      const { output, elapsed } = batch(runs[i], sizes[i]);
      assert.deepEqual(output, expected, fixture);
      if (round >= 6)
        samples[i].push(1000 * elapsed / sizes[i]);
    }
  }
  const [beforeUs, afterUs] = samples.map(median);
  results.push({ name, fixture, beforeUs, afterUs, speedup: beforeUs / afterUs, batchSizes: sizes, samplesUs: samples });
}
process.stdout.write(`${JSON.stringify({ node: process.version, units: 'microseconds per call', results }, null, 2)}\n`);
