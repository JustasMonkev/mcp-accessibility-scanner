/*
 * Stock scanner comparison. The separate corpus checkout supplies only fixture data
 * and a loopback server, not the axe.js injected by either CLI.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const { values: options } = parseArgs({ options: {
  baseline: { type: 'string' }, candidate: { type: 'string' }, corpus: { type: 'string' }, out: { type: 'string' },
  smoke: { type: 'boolean' }, iterations: { type: 'string', default: '10' }
} });
assert(options.baseline && options.corpus && options.out && (options.smoke || options.candidate));
const count = options.smoke ? 1 : Number(options.iterations);
assert(Number.isSafeInteger(count) && count > 0);
const corpus = resolve(options.corpus);
const { pages } = await import(pathToFileURL(join(corpus, 'corpus.mjs')));
const { serve, pagePath, freezeMdnIds } = await import(pathToFileURL(join(corpus, 'server.mjs')));
const output = resolve(options.out);
await mkdir(output);
const scratch = await mkdtemp(join(tmpdir(), 'stock-scanner-timing-'));
const hash = data => createHash('sha256').update(data).digest('hex');
const fileHash = async p => hash(await readFile(p));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const json = (name, data) => writeFile(join(output, name), JSON.stringify(data, null, 2) + '\n');
const phases = ['first', 'repeat'];
const clients = new Map();
const metadata = {
  start: new Date().toISOString(), command: process.argv, cwd: process.cwd(), count,
  node: process.version, platform: platform(), osRelease: release(), arch: arch(), cpu: cpus()[0].model,
  corpusGit: git(corpus, 'rev-parse', 'HEAD'), fixtureCheckout: git(join(corpus, '../engine'), 'rev-parse', 'HEAD'),
  harnessSha: await fileHash(new URL(import.meta.url)), corpusFiles: {}, pages: {}, arms: {},
  servedMdnScriptSha: hash(freezeMdnIds(await readFile(join(corpus, '../engine/perf/sites/mdn/combined.js'), 'utf8')))
};
const inputs = options.smoke ? pages.filter(p => ['example', 'bad-home', 'mdn', 'fixture-frame-title'].includes(p.id)) : pages;
const arms = options.smoke ? ['baseline'] : ['baseline', 'candidate'];
const reports = new Map();
const rows = [];
const differences = [];
let server;

async function connect(arm) {
  const cwd = await realpath(options[arm]);
  const req = createRequire(join(cwd, 'package.json'));
  const axeFile = await realpath(req.resolve('axe-core/axe.min.js'));
  assert.equal(axeFile, join(cwd, 'node_modules/axe-core/axe.min.js'), 'linked engine not allowed');
  const pkg = req('axe-core/package.json');
  const lock = req('./package-lock.json').packages['node_modules/axe-core'];
  assert.equal(pkg.version, '4.14.0');
  assert.equal(pkg.version, lock.version);
  const source = req('axe-core/axe.min.js').source;
  const directory = join(scratch, arm);
  await mkdir(directory);
  const config = join(directory, 'settings.json');
  await writeFile(config, JSON.stringify({ network: { allowedOrigins: [new URL(server.origin).host] } }));
  const args = ['cli.js', '--config', config, '--headless', '--isolated', '--browser', 'chromium', '--no-sandbox',
    '--viewport-size', '1280,800', '--block-service-workers', '--output-dir', directory];
  metadata.arms[arm] = { cwd, revision: git(cwd, 'rev-parse', 'HEAD'), scannedModuleSha: await fileHash(join(cwd, 'lib/tools/axe.js')),
    scanner: req('./package.json').version, playwright: req('playwright/package.json').version,
    chromiumBuild: JSON.parse(await readFile(join(dirname(req.resolve('playwright-core/package.json')), 'browsers.json'))).browsers.find(b => b.name === 'chromium-headless-shell'),
    enginePath: axeFile, axe: pkg.version, engineFileSha: await fileHash(axeFile), injectedAxeSourceSha: hash(source),
    packageLockSha: await fileHash(join(cwd, 'package-lock.json')), engineLockIntegrity: lock.integrity, args };
  const client = new Client({ name: 'stock-scan-benchmark', version: '1' });
  clients.set(arm, client);
  await client.connect(new StdioClientTransport({ command: process.execPath, args, cwd }));
  assert((await client.listTools()).tools.some(t => t.name === 'scan_page'));
}

async function call(client, name, args) {
  const start = performance.now();
  const result = await client.callTool({ name, arguments: args }, { timeout: 90000 });
  const ms = performance.now() - start;
  assert(!result.isError, name + ': ' + JSON.stringify(result));
  return { result, ms };
}

function record(result, page) {
  // Browser navigation is not an output of scan_page. All content and metadata of the
  // actual tool response must compare, not just summarized violation counts.
  assert(result.content.length && result.content.every(item => item.type === 'text'), 'Unexpected external report; compare its bytes explicitly');
  assert(result.content.some(item => item.text.includes('Violations:') && item.text.includes(server.origin + pagePath(page))));
  const serialized = JSON.stringify(result).replaceAll(server.origin, '<fixture-origin>');
  const sha = hash(serialized);
  reports.set(sha, JSON.parse(serialized));
  return sha;
}

try {
  server = await serve();
  metadata.origin = server.origin;
  for (const name of ['corpus.mjs', 'server.mjs'])
    metadata.corpusFiles[name] = await fileHash(join(corpus, name));
  for (const page of inputs)
    metadata.pages[page.id] = { path: pagePath(page), sha256: await fileHash(page.file) };
  for (const arm of arms)
    await connect(arm);
  if (arms.length === 2) {
    for (const k of ['axe', 'playwright', 'packageLockSha', 'engineFileSha', 'injectedAxeSourceSha'])
      assert.equal(metadata.arms.baseline[k], metadata.arms.candidate[k], k);
  }
  await json('environment.json', metadata);
  for (const [index, page] of inputs.entries()) {
    for (let iteration = 0; iteration < count; iteration++) {
      const order = (index + iteration) % 2 ? arms.toReversed() : arms;
      const references = new Map();
      for (const arm of order) {
        const client = clients.get(arm);
        const navigation = await call(client, 'browser_navigate', { url: server.origin + pagePath(page) });
        for (const phase of phases) {
          const { ms, result } = await call(client, 'scan_page', {});
          const sha = record(result, page);
          const row = { page: page.id, iteration, arm, phase, ms, navigationMs: phase === 'first' ? navigation.ms : null, sha };
          rows.push(row);
          await appendFile(join(output, 'samples.jsonl'), JSON.stringify(row) + '\n');
          const other = references.get(phase);
          if (other && other !== sha)
            differences.push({ page: page.id, iteration, phase, order, hashes: [other, sha] });
          references.set(phase, sha);
        }
        if (!metadata.arms[arm].runtime) {
          const runtime = await call(client, 'browser_evaluate', { function: '() => ({ version: window.axe.version, userAgent: navigator.userAgent })' });
          const text = runtime.result.content[0].text;
          const match = text.match(/### Result\n([^]*?)(?:\n\n###|$)/);
          assert(match, text);
          metadata.arms[arm].runtime = JSON.parse(match[1]);
          assert.equal(metadata.arms[arm].runtime.version, '4.14.0');
        }
      }
    }
    process.stdout.write(page.id + ': ' + count + ' first + repeat per arm\n');
  }
  if (arms.length === 2)
    assert.deepEqual(metadata.arms.baseline.runtime, metadata.arms.candidate.runtime);
  const byPage = {};
  const totals = {};
  for (const arm of arms) {
    totals[arm] = {};
    for (const metric of ['first', 'repeat', 'navigationAndFirst']) {
      let total = 0;
      for (const page of inputs) {
        const phase = metric === 'navigationAndFirst' ? 'first' : metric;
        const matching = rows.filter(r => r.page === page.id && r.arm === arm && r.phase === phase);
        assert.equal(matching.length, count);
        const sorted = matching.map(r => metric === 'navigationAndFirst' ? r.ms + r.navigationMs : r.ms).sort((a, b) => a - b);
        const median = (sorted[Math.floor((count - 1) / 2)] + sorted[Math.floor(count / 2)]) / 2;
        byPage[page.id] ??= {};
        byPage[page.id][arm] ??= {};
        byPage[page.id][arm][metric] = { median, p95: sorted[Math.ceil(count * .95) - 1] };
        total += median;
      }
      totals[arm][metric] = total;
    }
  }
  await json('summary.json', { scans: rows.length, normalizedBodies: reports.size, differences, totals, byPage });
  process.stdout.write(JSON.stringify({ scans: rows.length, differences: differences.length, totals }) + '\n');
  assert.equal(differences.length, 0, 'Full MCP response mismatch, see summary.json and reports.json.gz');
} finally {
  metadata.end = new Date().toISOString();
  await Promise.allSettled([...clients.values()].map(c => c.close()));
  await server?.close();
  await json('environment.json', metadata);
  await writeFile(join(output, 'reports.json.gz'), gzipSync(JSON.stringify(Object.fromEntries(reports))));
  await rm(scratch, { recursive: true, force: true });
}
