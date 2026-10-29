import { median } from './statistics.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.argv.length > 4)
  throw new Error('Usage: node bench/reading-order-bench.mjs [baseline-module] [candidate-module]');

const files = process.argv.slice(2);
if (!files.length)
  files.push(path.join(import.meta.dirname, '../lib/tools/auditScreenReader.js'));
const analyzers = await Promise.all(files.map(async file => ({
  file: path.resolve(file),
  run: (await import(pathToFileURL(path.resolve(file)))).analyzeScreenReader,
})));
const options = { checkNames: false, checkReadingOrder: true, maxFindingsPerCheck: 20 };
const warmups = 10;
const iterations = 20;
const results = [];

for (const count of [400, 2000]) {
  for (const order of ['sorted', 'reversed', 'late-inversion', 'diagonal', 'all-overlap', 'cluster-outlier']) {
    const nodes = fixture(count, order);
    const expected = analyzers[0].run(nodes, options);
    assert.equal(expected.countByCheck['reading-order-mismatch'], order === 'reversed' || order === 'late-inversion' ? 1 : 0);
    for (const analyzer of analyzers)
      assert.deepEqual(analyzer.run(nodes, options), expected);

    const samples = analyzers.map(() => []);
    for (let iteration = 0; iteration < warmups + iterations; iteration++) {
      const indexes = analyzers.map((_, index) => index);
      if (iteration % 2)
        indexes.reverse();
      for (const index of indexes) {
        const startedAt = performance.now();
        analyzers[index].run(nodes, options);
        const elapsed = performance.now() - startedAt;
        if (iteration >= warmups)
          samples[index].push(elapsed);
      }
    }
    results.push({ count, order, modules: analyzers.map((analyzer, index) => ({
      file: analyzer.file,
      medianMs: median(samples[index]),
      samplesMs: samples[index],
    })) });
  }
}

process.stdout.write(`${JSON.stringify({ node: process.version, warmups, iterations, results }, null, 2)}\n`);

function fixture(count, order) {
  const parent = {
    role: 'generic', name: null, level: null, ref: 'parent', depth: 0, parent: null,
    tagName: 'div', selector: 'div', visibleText: null, href: null,
    accessibleName: null, nameMeasured: false, rect: null, direction: 'ltr',
    positionFixed: false, floating: false, ariaHidden: false, childCount: count,
  };
  return [parent, ...Array.from({ length: count }, (_, index) => {
    const position = order === 'all-overlap' || (order === 'cluster-outlier' && index < count - 1) ? 0
      : order === 'reversed' ? count - index - 1
      : order === 'late-inversion' && index >= count - 2 ? 2 * count - 3 - index
      : index;
    return {
      ...parent, role: 'paragraph', ref: `e${index}`, depth: 1, parent: 0,
      visibleText: `Paragraph ${index}`, childCount: 0,
      rect: { x: position * 30, y: order === 'diagonal' || (order === 'cluster-outlier' && index === count - 1) ? index * 30 : 0, width: 24, height: 24 },
    };
  })];
}
