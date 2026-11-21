import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { pages } from './fixture.mjs';
import { median } from './statistics.mjs';

const libs = process.argv.slice(2).map(lib => path.resolve(lib));
if (libs.length !== 2)
  throw new Error('Usage: node bench/screen-reader-measurement-bench.mjs <baseline-lib> <candidate-lib>');

const builds = await Promise.all(libs.map(async lib => {
  const { parseAriaSnapshot } = await import(pathToFileURL(path.join(lib, 'tools/auditScreenReader.js')));
  const { measureScreenReaderElements } = await import(pathToFileURL(path.join(lib, 'tools/screenReaderMeasurement.js')));
  return { lib, parseAriaSnapshot, measureScreenReaderElements, samplesMs: [] };
}));

const refs = 200;
const warmups = 2;
const iterations = 10;
const browser = await chromium.launch({ executablePath: process.env.CHROME_HEADLESS_SHELL });
try {
  const page = await browser.newPage();
  for (let iteration = 0; iteration < warmups + iterations; iteration++) {
    const order = iteration % 2 ? [builds[1], builds[0]] : builds;
    for (const build of order) {
      await page.setContent(pages.get('/heavy.html'));
      const snapshot = await page.ariaSnapshot({ mode: 'ai' });
      const nodes = build.parseAriaSnapshot(snapshot).filter(node => node.ref && node.role === 'button').slice(0, refs);
      assert.equal(nodes.length, refs);
      assert.equal(nodes[0].name, 'Submit search');
      await page.locator('#submit').evaluate(element => element.remove());

      const startedAt = performance.now();
      const measurement = await build.measureScreenReaderElements(page, nodes, { checkNames: false, maxElements: refs });
      const elapsed = performance.now() - startedAt;
      assert.equal(measurement.totalElements, refs);
      assert.equal(measurement.analyzedElements, refs);
      assert.equal(measurement.factsByIndex.size, refs - 1);
      assert.equal(measurement.factsByIndex.has(0), false);
      assert.equal(measurement.limitations.unresolvedElements, 1);
      assert.equal(measurement.limitations.unmeasuredNames, 0);
      assert.equal(measurement.limitations.truncatedElements, 0);
      assert.equal(measurement.limitations.stoppedAtFrameWorkLimit, null);
      assert.equal(measurement.limitations.stoppedAtRefWorkLimit ?? null, null);
      if (iteration >= warmups)
        build.samplesMs.push(elapsed);
    }
  }

  const results = builds.map(({ lib, samplesMs }) => ({ lib, medianMs: median(samplesMs), samplesMs }));
  process.stdout.write(JSON.stringify({ node: process.version, browser: browser.version(), refs, warmups, iterations, results }, null, 2) + '\n');
} finally {
  await browser.close();
}
