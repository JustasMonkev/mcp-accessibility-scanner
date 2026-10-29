import { median } from './statistics.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.argv.length > 4)
  throw new Error('Usage: node bench/data-url-bench.mjs [baseline-module] [candidate-module]');

const files = process.argv.slice(2);
if (!files.length)
  files.push(path.join(import.meta.dirname, '../lib/utils/dataUrl.js'));
const modules = await Promise.all(files.map(async file => ({
  file: path.resolve(file),
  run: (await import(pathToFileURL(path.resolve(file)))).truncateDataUrls,
})));
const warmups = 5;
const iterations = 20;
const results = [];
const fixtures = [400, 2000].map(count => {
  const input = 'data: missing delimiter '.repeat(count);
  return { name: `malformed prefixes (${count})`, input, expected: input };
});
fixtures.push({
  name: 'valid long metadata (32 KB)',
  input: `data:text/plain;name=${'a'.repeat(32 * 1024)};base64,eA==`,
  expected: 'data:text/plain;base64,...',
});
const ordinary = '- link "Ordinary text" [ref=e1]: https://example.com/page\n';
fixtures.push({
  name: 'ordinary text with valid data URLs (2000 lines)',
  input: `${ordinary}- img "Icon": data:image/png;base64,eA==\n`.repeat(1000),
  expected: `${ordinary}- img "Icon": data:image/png;base64,...\n`.repeat(1000),
});

for (const fixture of fixtures) {
  for (const module of modules)
    assert.equal(module.run(fixture.input), fixture.expected);
  const samples = modules.map(() => []);
  for (let iteration = 0; iteration < warmups + iterations; iteration++) {
    const indexes = modules.map((_, index) => index);
    if (iteration % 2)
      indexes.reverse();
    for (const index of indexes) {
      const start = performance.now();
      const output = modules[index].run(fixture.input);
      const elapsed = performance.now() - start;
      assert.equal(output, fixture.expected);
      if (iteration >= warmups)
        samples[index].push(elapsed);
    }
  }
  results.push({ name: fixture.name, bytes: Buffer.byteLength(fixture.input), modules: modules.map((module, index) => ({
    file: module.file,
    medianMs: median(samples[index]),
    samplesMs: samples[index],
  })) });
}
process.stdout.write(`${JSON.stringify({ node: process.version, warmups, iterations, results }, null, 2)}\n`);
