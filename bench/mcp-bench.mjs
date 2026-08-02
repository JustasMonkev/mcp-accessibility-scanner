#!/usr/bin/env node
/**
 * End-to-end latency benchmark for the MCP tool surface.
 *
 * Every scenario is a real `tools/call` against a real browser driven by the
 * built server, so the numbers include the MCP round trip, Playwright IPC and
 * the page work - the latency a client actually waits for.
 *
 * Usage:
 *   node bench/mcp-bench.mjs --out results.json [--label name] [--iterations 5]
 *   node bench/mcp-bench.mjs --server /path/to/other/cli.js --lib /path/to/other/lib
 *   node bench/mcp-bench.mjs --compare before.json after.json
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { dataUrlHeavyText, pages, plainSnapshotText } from './fixture.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = parseArgs(process.argv.slice(2));

if (options.compare) {
  compare(options.compare[0], options.compare[1]);
  // process.exit() drops whatever is still buffered, and stdout is only
  // synchronous on a TTY - piped into anything that applies backpressure, the
  // tail of the table is simply lost. Wait for the writes to drain first.
  await new Promise(resolve => process.stdout.write('', resolve));
  process.exit(0);
}
if (!!options.server !== !!options.lib)
  throw new Error('--server and --lib must be provided together.');

const serverEntry = options.server ? path.resolve(options.server) : path.join(projectRoot, 'cli.js');
const libRoot = options.lib ? path.resolve(options.lib) : path.join(projectRoot, 'lib');
const iterations = options.iterations ?? 5;
const warmups = options.warmups ?? 1;

const server = await startFixtureServer();
const origin = `http://127.0.0.1:${server.address().port}`;
const outputDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'mcp-bench-'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    serverEntry,
    '--headless',
    '--no-sandbox',
    '--isolated',
    '--browser', options.browser ?? 'chromium',
    '--output-dir', outputDir,
    // Sandboxes and CI images often ship a browser outside Playwright's own
    // download directory; point at it explicitly when asked.
    ...(options.executablePath ? ['--executable-path', options.executablePath] : []),
  ],
  cwd: projectRoot,
});
const client = new Client({ name: 'mcp-bench', version: '1.0.0' });

/**
 * Scenarios run in declaration order; `setup` is excluded from the timing so a
 * scenario measures one tool call and nothing else.
 */
const scenarios = [
  {
    name: 'tools/list',
    run: () => client.listTools(),
  },
  {
    name: 'browser_navigate (heavy page)',
    run: () => call('browser_navigate', { url: `${origin}/heavy.html` }),
  },
  {
    name: 'browser_snapshot (heavy page)',
    setup: () => call('browser_navigate', { url: `${origin}/heavy.html` }),
    run: () => call('browser_snapshot', {}),
  },
  {
    name: 'browser_click (ref + snapshot)',
    setup: async () => {
      const snapshot = await call('browser_navigate', { url: `${origin}/heavy.html` });
      return { ref: refFor(snapshot, 'Submit search') };
    },
    run: state => call('browser_click', { element: 'Submit search button', ref: state.ref }),
  },
  {
    // browser_type only asks for a snapshot on its `slowly` and `submit` paths,
    // so a plain fill is what this measures: ref resolution plus the settle.
    name: 'browser_type (ref, fill only)',
    setup: async () => {
      const snapshot = await call('browser_navigate', { url: `${origin}/heavy.html` });
      return { ref: refFor(snapshot, 'Search') };
    },
    run: state => call('browser_type', { element: 'Search box', ref: state.ref, text: 'benchmark' }),
  },
  {
    name: 'browser_hover (ref + snapshot)',
    setup: async () => {
      const snapshot = await call('browser_navigate', { url: `${origin}/heavy.html` });
      return { ref: refFor(snapshot, 'Home') };
    },
    run: state => call('browser_hover', { element: 'Home link', ref: state.ref }),
  },
  {
    name: 'browser_press_key',
    setup: () => call('browser_navigate', { url: `${origin}/heavy.html` }),
    run: () => call('browser_press_key', { key: 'Tab' }),
  },
  {
    name: 'browser_find',
    setup: () => call('browser_navigate', { url: `${origin}/heavy.html` }),
    run: () => call('browser_find', { text: 'Item 200 link' }),
  },
  {
    name: 'scan_page (axe)',
    setup: () => call('browser_navigate', { url: `${origin}/heavy.html` }),
    run: () => call('scan_page', {}),
  },
  {
    name: 'audit_keyboard (12 tabs)',
    setup: () => call('browser_navigate', { url: `${origin}/heavy.html` }),
    run: () => call('audit_keyboard', { maxTabs: 12 }),
  },
  {
    name: 'scan_page_matrix (3 variants)',
    setup: () => call('browser_navigate', { url: `${origin}/heavy.html` }),
    run: () => call('scan_page_matrix', {
      variants: [
        { name: 'baseline' },
        { name: 'mobile', viewport: { width: 375, height: 812 } },
        { name: 'zoom-200', zoomPercent: 200 },
      ],
    }),
  },
  {
    name: 'audit_site (6 pages)',
    setup: () => call('browser_navigate', { url: `${origin}/page-0.html` }),
    run: () => call('audit_site', { startUrl: `${origin}/page-0.html`, maxPages: 6, maxDepth: 2 }),
  },
  {
    name: 'audit_screen_reader',
    setup: () => call('browser_navigate', { url: `${origin}/page-0.html` }),
    run: () => call('audit_screen_reader', {}),
  },
];

const results = [];
try {
  // Inside the guard: a missing or unbuilt --server rejects here, and the temp
  // output directory has already been created.
  await client.connect(transport);

  for (const scenario of scenarios) {
    const samples = [];
    let state;
    for (let index = 0; index < warmups + iterations; index++) {
      state = scenario.setup ? await scenario.setup() : undefined;
      const startedAt = performance.now();
      await scenario.run(state);
      const elapsed = performance.now() - startedAt;
      if (index >= warmups)
        samples.push(elapsed);
    }
    const stats = summarize(samples);
    results.push({ name: scenario.name, ...stats });
    process.stderr.write(`${scenario.name.padEnd(34)} median ${stats.median.toFixed(1).padStart(9)} ms   mean ${stats.mean.toFixed(1).padStart(9)} ms\n`);
  }

  results.push(...await runMicroBenchmarks());
} finally {
  // A scenario that throws must not leave the server process, the browser it
  // launched, or the temporary report directory behind: a few failed runs would
  // otherwise pile up orphaned Chromiums.
  await client.close().catch(() => {});
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(outputDir, { recursive: true, force: true });
}

const report = {
  label: options.label ?? 'run',
  server: serverEntry,
  node: process.version,
  iterations,
  scenarios: results,
  totalMedianMs: results.filter(entry => !entry.micro).reduce((sum, entry) => sum + entry.median, 0),
};

if (options.out) {
  fs.writeFileSync(path.resolve(options.out), `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`\nWrote ${options.out}\n`);
}
process.stderr.write(`\nTotal median tool latency: ${report.totalMedianMs.toFixed(1)} ms\n`);

// --- helpers -------------------------------------------------------------

async function runMicroBenchmarks() {
  const { truncateDataUrls } = await import(pathToFileURL(path.join(libRoot, 'utils/dataUrl.js')));
  const { toMcpTool } = await import(pathToFileURL(path.join(libRoot, 'mcp/tool.js')));
  const { allTools } = await import(pathToFileURL(path.join(libRoot, 'tools.js')));

  const plain = plainSnapshotText();
  const withDataUrls = dataUrlHeavyText();
  const micro = [
    ['micro: truncateDataUrls (no data urls, 240 KB)', () => truncateDataUrls(plain)],
    ['micro: truncateDataUrls (data url heavy)', () => truncateDataUrls(withDataUrls)],
    ['micro: tool schema -> JSON schema (all tools)', () => allTools.map(tool => toMcpTool(tool.schema))],
  ];

  const out = [];
  for (const [name, run] of micro) {
    const samples = [];
    for (let index = 0; index < 25; index++) {
      const startedAt = performance.now();
      run();
      const elapsed = performance.now() - startedAt;
      if (index >= 5)
        samples.push(elapsed);
    }
    const stats = summarize(samples);
    out.push({ name, micro: true, ...stats });
    process.stderr.write(`${name.padEnd(34)} median ${stats.median.toFixed(3).padStart(9)} ms\n`);
  }
  return out;
}

function summarize(samples) {
  const sorted = [...samples].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return {
    samples: samples.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError)
    throw new Error(`${name} failed: ${textOf(result).slice(0, 400)}`);
  return result;
}

function textOf(result) {
  return (result.content ?? []).filter(entry => entry.type === 'text').map(entry => entry.text).join('\n');
}

function refFor(result, needle) {
  const line = textOf(result).split('\n').find(entry => entry.includes(needle) && entry.includes('[ref='));
  const ref = line && /\[ref=([^\]]+)\]/.exec(line);
  if (!ref)
    throw new Error(`No ref found for "${needle}"`);
  return ref[1];
}

function startFixtureServer() {
  const httpServer = http.createServer((request, response) => {
    const body = pages.get(new URL(request.url, 'http://localhost').pathname);
    if (body === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  return new Promise(resolve => httpServer.listen(0, '127.0.0.1', () => resolve(httpServer)));
}

function compare(beforePath, afterPath) {
  const before = JSON.parse(fs.readFileSync(beforePath, 'utf-8'));
  const after = JSON.parse(fs.readFileSync(afterPath, 'utf-8'));
  const byName = new Map(before.scenarios.map(entry => [entry.name, entry]));
  const rows = [['Scenario', `${before.label} (ms)`, `${after.label} (ms)`, 'Change', 'Speedup']];
  let beforeTotal = 0;
  let afterTotal = 0;
  for (const entry of after.scenarios) {
    const baseline = byName.get(entry.name);
    if (!baseline)
      continue;
    if (!entry.micro && !baseline.micro) {
      beforeTotal += baseline.median;
      afterTotal += entry.median;
    }
    const change = (entry.median - baseline.median) / baseline.median * 100;
    rows.push([
      entry.name,
      format(baseline.median),
      format(entry.median),
      `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`,
      `${(baseline.median / entry.median).toFixed(2)}x`,
    ]);
  }
  if (!beforeTotal)
    throw new Error('The reports have no end-to-end scenarios in common.');
  const totalChange = (afterTotal - beforeTotal) / beforeTotal * 100;
  rows.push([
    'TOTAL (end-to-end tool calls)',
    format(beforeTotal),
    format(afterTotal),
    `${totalChange >= 0 ? '+' : ''}${totalChange.toFixed(1)}%`,
    `${(beforeTotal / afterTotal).toFixed(2)}x`,
  ]);
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)));
  rows.forEach((row, index) => {
    process.stdout.write(`| ${row.map((cell, column) => cell.padEnd(widths[column])).join(' | ')} |\n`);
    if (index === 0)
      process.stdout.write(`|${widths.map(width => '-'.repeat(width + 2)).join('|')}|\n`);
  });
}

function format(value) {
  return value >= 10 ? value.toFixed(1) : value.toFixed(3);
}

function parseArgs(argv) {
  const parsed = {};
  // Every flag takes a value, and a missing one must fail here rather than as a
  // silently skipped report after a full benchmark run.
  const value = (index, flag) => {
    const next = argv[index];
    if (next === undefined || next.startsWith('--') || !next.trim())
      throw new Error(`${flag} needs a value, got: ${next ?? '(nothing)'}`);
    return next;
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--compare')
      parsed.compare = [value(++index, arg), value(++index, arg)];
    else if (arg === '--out')
      parsed.out = value(++index, arg);
    else if (arg === '--label')
      parsed.label = value(++index, arg);
    else if (arg === '--server')
      parsed.server = value(++index, arg);
    else if (arg === '--lib')
      parsed.lib = value(++index, arg);
    else if (arg === '--browser')
      parsed.browser = value(++index, arg);
    else if (arg === '--executable-path')
      parsed.executablePath = value(++index, arg);
    else if (arg === '--iterations')
      parsed.iterations = wholeNumber(value(++index, arg), arg, 1);
    else if (arg === '--warmups')
      parsed.warmups = wholeNumber(value(++index, arg), arg, 0);
    else
      throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

// A missing or non-numeric count would otherwise reach the sampling loop as NaN,
// collect no samples, and crash while formatting undefined statistics - after
// the fixture server and the browser have already started.
function wholeNumber(value, flag, minimum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum)
    throw new Error(`${flag} needs an integer >= ${minimum}, got: ${value ?? '(nothing)'}`);
  return parsed;
}
