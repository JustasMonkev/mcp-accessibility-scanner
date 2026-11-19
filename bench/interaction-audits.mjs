import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const { values } = parseArgs({ options: {
  'server-root': { type: 'string' },
  'fixtures': { type: 'string' },
  'manifest': { type: 'string' },
  'output': { type: 'string' },
  'repeats': { type: 'string', default: '3' },
  'download': { type: 'boolean', default: false },
} });
for (const key of ['server-root', 'fixtures', 'manifest', 'output']) {
  if (!values[key])
    throw new Error(`Missing --${key}`);
}
const repeats = Number(values.repeats);
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10)
  throw new Error('--repeats must be 1–10');
const output = path.resolve(values.output);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.mkdir(output);
const manifestBytes = await fs.readFile(values.manifest);
const manifest = JSON.parse(manifestBytes);
const selected = manifest.cases;
const cases = selected.filter(item => ['included', 'included-incomplete-expected'].includes(item.disposition));
const skipped = selected.filter(item => !cases.includes(item)).map(({ id, disposition, note }) => ({ id, disposition, note }));
const pages = new Map();
for (const item of cases) {
  if (!/^[\w-]+$/.test(item.id) || !['audit_keyboard_operation', 'audit_form_validation'].includes(item.tool) || ![0, 1].includes(item.label))
    throw new Error('Invalid benchmark case');
}
for (const item of [...cases, ...(manifest.assets ?? [])]) {
  const file = path.resolve(values.fixtures, item.page);
  if (!file.startsWith(path.resolve(values.fixtures) + path.sep))
    throw new Error('Fixture must be inside --fixtures');
  let bytes;
  if (values.download) {
    const url = `https://raw.githubusercontent.com/jszh/InterA11y/${manifest.upstreamCommit}/${item.page}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok)
      throw new Error(`Download failed: ${response.status} ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } else {
    bytes = await fs.readFile(file);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== item.sha256)
    throw new Error(`Fixture hash mismatch: ${item.id}`);
  if (values.download) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }
  pages.set(item.urlPath ?? `/${item.id}`, { bytes, type: item.page.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
}
const server = http.createServer((request, response) => {
  const page = pages.get(request.url);
  response.writeHead(page ? 200 : 404, { 'content-type': page?.type ?? 'text/plain' });
  response.end(page?.bytes ?? 'Not found');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const client = new Client({ name: 'interaction-audits-benchmark', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['cli.js', '--headless', '--no-sandbox', '--isolated', '--output-dir', output],
  cwd: path.resolve(values['server-root']),
});
const results = [];
try {
  await client.connect(transport);
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const item of cases) {
      const prefix = `${item.id}-${repeat}`;
      const navigation = await client.callTool({ name: 'browser_navigate', arguments: { url: origin + (item.urlPath ?? `/${item.id}`) } });
      const start = performance.now();
      const response = navigation.isError ? navigation : await client.callTool({
        name: item.tool, arguments: { ...item.arguments, reportFile: `${prefix}.report.json` },
      });
      const durationMs = performance.now() - start;
      await fs.writeFile(path.join(output, `${prefix}.response.json`), JSON.stringify(response, null, 2));
      const content = response.structuredContent;
      let prediction = null;
      if (!response.isError && content?.kind === 'audit_keyboard_operation') {
        if (content.status === 'passed')
prediction = 0;
        if (content.status === 'failed')
prediction = 1;
      }
      if (!response.isError && content?.kind === 'audit_form_validation' && content.outcome === 'completed')
        prediction = content.summary.findingCount > 0 ? 1 : 0;
      results.push({ id: item.id, source: item.source, sc: item.sc, repeat, label: item.label,
        prediction, durationMs, error: response.isError === true,
        outcome: content?.status ?? content?.outcome ?? 'tool-error',
        response: `${prefix}.response.json` });
      process.stdout.write(`${prefix}\tlabel=${item.label}\tprediction=${prediction}\t${results.at(-1).outcome}\n`);
    }
  }
} finally {
  await client.close();
  await new Promise(resolve => server.close(resolve));
}
const counts = { tp: 0, fp: 0, tn: 0, fn: 0, incomplete: 0 };
for (const row of results) {
  if (row.prediction === null)
counts.incomplete++;
  else if (row.prediction === 1)
counts[row.label === 1 ? 'tp' : 'fp']++;
  else
counts[row.label === 0 ? 'tn' : 'fn']++;
}
const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;
const summary = {
  serverRoot: path.resolve(values['server-root']),
  manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  node: process.version, createdAt: new Date().toISOString(),
  selected: selected.length, cases: cases.length, skipped, repeats, observations: results.length, ...counts,
  precision: ratio(counts.tp, counts.tp + counts.fp),
  recallAmongCompleted: ratio(counts.tp, counts.tp + counts.fn),
  conservativeDetectionRateAllPositives: ratio(counts.tp, results.filter(row => row.label === 1).length),
  coverage: ratio(results.length - counts.incomplete, results.length),
  agreementAllCases: ratio(counts.tp + counts.tn, results.length),
  interpretation: 'Scenario-outcome proxy against external labels, not full WCAG evaluation or human equivalence. Incomplete/error cases are unclassified, never passes. Repeats are not independent cases.',
  results,
};
await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
process.stdout.write(JSON.stringify({ ...summary, results: undefined }, null, 2) + '\n');
