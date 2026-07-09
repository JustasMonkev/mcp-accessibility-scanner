#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');

const options = parseArgs(process.argv.slice(2));

const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
const resultsDir = path.join(scriptDir, 'mcp-direct-harness-results', runId);
fs.mkdirSync(resultsDir, { recursive: true });

const uploadFile = path.join(resultsDir, 'mcp-upload.txt');
fs.writeFileSync(uploadFile, 'mcp upload fixture\n');

const summaryPath = path.join(resultsDir, 'summary.tsv');
fs.writeFileSync(summaryPath, 'tool\tstatus\tdetail\tlog\n');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['cli.js', '--headless', '--no-sandbox', '--isolated'],
  cwd: projectRoot,
});
const client = new Client({ name: 'mcp-accessibility-direct-harness', version: '1.0.0' });

const state = {
  toolNames: [],
  fixtureOrigin: '',
};

class SkipError extends Error {}

const tests = [
  test('browser_navigate', async () => {
    const result = await callTool('browser_navigate', {
      url: htmlUrl('<title>Navigate</title><h1>Navigate OK</h1>'),
    });
    assertText(result, /Navigate OK|Page Title: Navigate/);
  }),

  test('browser_snapshot', async () => {
    await navigate('<title>Snapshot</title><main><h1>Hello MCP</h1></main>');
    const result = await callTool('browser_snapshot', {});
    assertText(result, /Hello MCP/);
  }),

  test('browser_find', async () => {
    await navigate('<title>Find</title><main><h1>Find MCP</h1><p>Needle text</p></main>');
    const result = await callTool('browser_find', { text: 'Needle' });
    assertText(result, /Found 1 match|Needle text/);
  }),

  test('browser_evaluate', async () => {
    await callTool('browser_navigate', { url: `${state.fixtureOrigin}/csp-evaluate` });

    const functionResult = await callTool('browser_evaluate', { function: '() => document.title' });
    assertText(functionResult, /CSP Evaluate/);
    assertText(functionResult, /await page\.evaluate\(\(\) => document\.title\);/);

    const expressionResult = await callTool('browser_evaluate', { function: 'document.title' });
    assertText(expressionResult, /CSP Evaluate/);
    assertText(expressionResult, /await page\.evaluate\(\(\) => \(document\.title\)\);/);

    const snapshot = await callTool('browser_snapshot', {});
    const ref = refFor(resultText(snapshot), 'Strict CSP');
    const elementResult = await callTool('browser_evaluate', {
      function: 'element.textContent',
      element: 'Strict CSP heading',
      ref,
    });
    assertText(elementResult, /Strict CSP/);
    assertText(elementResult, /\.evaluate\(\(element\) => \(element\.textContent\)\);/);
  }),

  test('browser_resize', async () => {
    await navigate('<title>Resize</title><h1>Resize</h1>');
    await callTool('browser_resize', { width: 640, height: 480 });
    const result = await callTool('browser_evaluate', {
      function: '() => ({ width: window.innerWidth, height: window.innerHeight })',
    });
    assertText(result, /"width":\s*640|"height":\s*480/);
  }),

  test('browser_console_messages', async () => {
    await navigate('<title>Console</title><script>console.log("mcp-console-ok")</script><h1>Console</h1>');
    const result = await callTool('browser_console_messages', {});
    assertText(result, /mcp-console-ok/);
  }),

  test('browser_handle_dialog', async () => {
    const snapshot = await navigate('<title>Dialog</title><button onclick="alert(\'mcp-dialog-ok\')">Open dialog</button>');
    const ref = refFor(snapshot, 'Open dialog');
    await callTool('browser_click', { element: 'Open dialog button', ref });
    await callTool('browser_handle_dialog', { accept: true });
  }),

  test('browser_file_upload', async () => {
    const snapshot = await navigate([
      '<title>Upload</title>',
      '<label>Upload <input type="file" aria-label="Upload" ',
      'onchange="document.body.dataset.file=this.files[0].name"></label>',
    ].join(''));
    const ref = refFor(snapshot, 'Upload');
    await callTool('browser_click', { element: 'Upload file input', ref });
    await callTool('browser_file_upload', { paths: [uploadFile] });
    const result = await callTool('browser_evaluate', { function: '() => document.body.dataset.file' });
    assertText(result, /mcp-upload\.txt/);
  }),

  test('browser_fill_form', async () => {
    const snapshot = await navigate([
      '<title>Form</title>',
      '<label>Name <input aria-label="Name"></label>',
      '<label><input type="checkbox" aria-label="Subscribe">Subscribe</label>',
      '<select aria-label="Choice"><option>One</option><option>Two</option></select>',
    ].join(''));
    const nameRef = refFor(snapshot, 'Name');
    const subscribeRef = refFor(snapshot, 'Subscribe');
    const choiceRef = refFor(snapshot, 'Choice');
    await callTool('browser_fill_form', {
      fields: [
        { name: 'Name', type: 'textbox', ref: nameRef, value: 'Ada' },
        { name: 'Subscribe', type: 'checkbox', ref: subscribeRef, value: 'true' },
        { name: 'Choice', type: 'combobox', ref: choiceRef, value: 'Two' },
      ],
    });
    const result = await callTool('browser_evaluate', {
      function: '() => ({ name: document.querySelector("input[aria-label=Name]").value, subscribed: document.querySelector("input[aria-label=Subscribe]").checked, choice: document.querySelector("select").value })',
    });
    assertText(result, /"name":\s*"Ada"/);
    assertText(result, /"subscribed":\s*true/);
    assertText(result, /"choice":\s*"Two"/);
  }),

  test('browser_press_key', async () => {
    await navigate('<title>Press</title><input aria-label="Key target" autofocus onkeydown="document.body.dataset.key=event.key">');
    await callTool('browser_press_key', { key: 'A' });
    const result = await callTool('browser_evaluate', { function: '() => document.body.dataset.key' });
    assertText(result, /A|a/);
  }),

  test('browser_type', async () => {
    const snapshot = await navigate('<title>Type</title><label>Message <input aria-label="Message"></label>');
    const ref = refFor(snapshot, 'Message');
    await callTool('browser_type', { element: 'Message input', ref, text: 'typed text' });
    const result = await callTool('browser_evaluate', { function: '() => document.querySelector("input").value' });
    assertText(result, /typed text/);
  }),

  test('browser_navigate_back', async () => {
    await navigate('<title>First</title><h1>First</h1>');
    await navigate('<title>Second</title><h1>Second</h1>');
    await callTool('browser_navigate_back', {});
    const result = await callTool('browser_evaluate', { function: '() => document.title' });
    assertText(result, /First/);
  }),

  test('browser_network_requests', async () => {
    await callTool('browser_navigate', { url: `${state.fixtureOrigin}/network-json` });
    const result = await callTool('browser_network_requests', {});
    assertText(result, /network-json/);
  }),

  test('browser_network_request', async () => {
    await callTool('browser_navigate', { url: `${state.fixtureOrigin}/network-json` });
    const list = await callTool('browser_network_requests', {});
    const match = resultText(list).match(/^(\d+)\. \[GET\] .*\/network-json/m);
    if (!match)
      throw new Error(`Could not find /network-json in network list:\n${resultText(list).slice(0, 4000)}`);

    const result = await callTool('browser_network_request', { index: Number(match[1]) });
    assertText(result, /Response headers/);
    assertText(result, /content-type: application\/json/);
  }),

  test('browser_take_screenshot', async () => {
    await navigate('<title>Screenshot</title><h1>Screenshot OK</h1>');
    const result = await callTool('browser_take_screenshot', {
      type: 'png',
      filename: 'mcp-direct-harness-screenshot.png',
      fullPage: false,
    });
    assertText(result, /screenshot/i);
  }),

  test('browser_click', async () => {
    const snapshot = await navigate('<title>Click</title><button onclick="document.body.dataset.clicked=\'yes\'">Click me</button>');
    const ref = refFor(snapshot, 'Click me');
    await callTool('browser_click', { element: 'Click me button', ref });
    const result = await callTool('browser_evaluate', { function: '() => document.body.dataset.clicked' });
    assertText(result, /yes/);
  }),

  test('browser_drag', async () => {
    const snapshot = await navigate([
      '<title>Drag</title>',
      '<div draggable="true" style="width:80px;height:40px;background:#acf">Drag source</div>',
      '<div style="margin-top:40px;width:120px;height:50px;background:#cfa" ',
      'ondragover="event.preventDefault()" ondrop="document.body.dataset.dropped=\'yes\'">Drop target</div>',
    ].join(''));
    const startRef = refFor(snapshot, 'Drag source');
    const endRef = refFor(snapshot, 'Drop target');
    await callTool('browser_drag', {
      startElement: 'Drag source',
      startRef,
      endElement: 'Drop target',
      endRef,
    });
  }),

  test('browser_drop', async () => {
    const snapshot = await navigate([
      '<title>Drop</title>',
      '<div role="button" aria-label="Drop zone" style="width:120px;height:50px;background:#cfa" ',
      'ondragover="event.preventDefault()" ',
      'ondrop="event.preventDefault(); document.body.dataset.dropText=event.dataTransfer.getData(\'text/plain\')">Drop zone</div>',
    ].join(''));
    const ref = refFor(snapshot, 'Drop zone');
    const dropResult = await callTool('browser_drop', {
      element: 'Drop zone',
      ref,
      data: { 'text/plain': 'hello from drop' },
    });
    assertText(dropResult, /'text\/plain': 'hello from drop'/);
    const result = await callTool('browser_evaluate', { function: '() => document.body.dataset.dropText' });
    assertText(result, /hello from drop/);
  }),

  test('browser_hover', async () => {
    const snapshot = await navigate('<title>Hover</title><button onmouseover="document.body.dataset.hovered=\'yes\'">Hover me</button>');
    const ref = refFor(snapshot, 'Hover me');
    await callTool('browser_hover', { element: 'Hover me button', ref });
    const result = await callTool('browser_evaluate', { function: '() => document.body.dataset.hovered' });
    assertText(result, /yes/);
  }),

  test('browser_select_option', async () => {
    const snapshot = await navigate('<title>Select</title><label>Choice <select aria-label="Choice"><option value="one">One</option><option value="two">Two</option></select></label>');
    const ref = refFor(snapshot, 'Choice');
    await callTool('browser_select_option', { element: 'Choice combobox', ref, values: ['two'] });
    const result = await callTool('browser_evaluate', { function: '() => document.querySelector("select").value' });
    assertText(result, /two/);
  }),

  test('scan_page', async () => {
    await navigate('<title>Scan</title><img src="x"><h1>Scan</h1>');
    const result = await callTool('scan_page', { violationsTag: ['wcag2a', 'wcag2aa'] });
    assertText(result, /Violations:/);
  }),

  test('browser_tabs', async () => {
    await callTool('browser_tabs', { action: 'list' });
    await callTool('browser_tabs', { action: 'new' });
    await callTool('browser_tabs', { action: 'list' });
    await callTool('browser_tabs', { action: 'select', index: 0 });
    await callTool('browser_tabs', { action: 'close', index: 1 });
  }),

  test('browser_navigation_timeout', async () => {
    await navigate('<title>NavTimeout</title><h1>NavTimeout</h1>');
    const result = await callTool('browser_navigation_timeout', { timeout: 30000 });
    assertText(result, /Navigation timeout set to 30000ms/);
  }),

  test('browser_default_timeout', async () => {
    await navigate('<title>DefaultTimeout</title><h1>DefaultTimeout</h1>');
    const result = await callTool('browser_default_timeout', { timeout: 30000 });
    assertText(result, /Default timeout set to 30000ms/);
  }),

  test('browser_wait_for', async () => {
    await navigate('<title>Wait</title><script>setTimeout(() => { const p = document.createElement("p"); p.textContent = "Ready Text"; document.body.appendChild(p); }, 100)</script><h1>Waiting</h1>');
    const result = await callTool('browser_wait_for', { text: 'Ready Text' });
    assertText(result, /Ready Text|Waited for Ready Text/);
  }),

  test('audit_site', async () => {
    const result = await callTool('audit_site', {
      strategy: 'provided',
      urls: [`${state.fixtureOrigin}/audit-site`],
      maxPages: 1,
      maxDepth: 0,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: ['logout|signout'],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2a', 'wcag2aa'],
      maxNodesPerViolation: 5,
      waitAfterNavigationMs: 50,
    });
    assertText(result, /JSON report:|scanned/i);
  }),

  test('scan_page_matrix', async () => {
    await navigate('<title>Matrix</title><img src="x"><h1>Matrix</h1>');
    const result = await callTool('scan_page_matrix', {
      variants: [
        { name: 'baseline' },
        { name: 'mobile', viewport: { width: 390, height: 844 } },
      ],
      violationsTag: ['wcag2a', 'wcag2aa'],
      maxNodesPerViolation: 5,
      waitAfterApplyMs: 50,
      reloadBetweenVariants: true,
    });
    assertText(result, /JSON report:|variants/i);
  }),

  test('audit_keyboard', async () => {
    await navigate('<title>Keyboard</title><a href="#main">Skip to main</a><main id="main"><input aria-label="Search"><button>Go</button></main>');
    const result = await callTool('audit_keyboard', {
      maxTabs: 8,
      includeShiftTab: false,
      stopOnCycle: true,
      cycleWindow: 4,
      checkSkipLink: true,
      skipLinkMaxTabs: 3,
      activateSkipLink: false,
      checkFocusTrap: true,
      checkFocusVisibility: true,
      checkFocusJumps: true,
      jumpScrollThresholdPx: 600,
      screenshotOnIssue: false,
      maxIssueScreenshots: 2,
    });
    assertText(result, /JSON report:|Skip link|summary/i);
  }),

  test('browser_install', async () => {
    if (!options.includeInstall)
      throw new SkipError('browser_install skipped by default; rerun with --include-install');
    await callTool('browser_install', {});
  }),

  test('browser_close', async () => {
    await navigate('<title>Close</title><h1>Close target</h1>');
    await callTool('browser_close', {});
  }),
];

if (options.list) {
  for (const t of tests)
    console.log(`${t.name}${t.name === 'browser_install' ? ' (optional)' : ''}`);
  process.exit(0);
}

try {
  var closeFixtureServer = await startFixtureServer();
  await client.connect(transport);
  const { tools } = await client.listTools();
  state.toolNames = tools.map(t => t.name);
  await verifyCoverage(tests, state.toolNames);
  await runTests();
} finally {
  await closeFixtureServer?.().catch(() => undefined);
  await client.close().catch(() => undefined);
}

async function runTests() {
  const selected = tests.filter(t => !options.only || t.name === options.only);
  if (selected.length === 0)
    throw new Error(`No test matched --only ${options.only}`);

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const [index, t] of selected.entries()) {
    const logPath = path.join(resultsDir, `${String(index + 1).padStart(2, '0')}-${t.name}.json`);
    const startedAt = new Date().toISOString();
    process.stdout.write(`[${index + 1}/${selected.length}] ${t.name} ... `);
    try {
      await t.fn();
      const entry = { tool: t.name, status: 'PASS', startedAt, finishedAt: new Date().toISOString() };
      fs.writeFileSync(logPath, JSON.stringify(entry, null, 2));
      appendSummary(t.name, 'PASS', '', logPath);
      passed++;
      console.log('PASS');
    } catch (error) {
      if (error instanceof SkipError) {
        const entry = { tool: t.name, status: 'SKIP', reason: error.message, startedAt, finishedAt: new Date().toISOString() };
        fs.writeFileSync(logPath, JSON.stringify(entry, null, 2));
        appendSummary(t.name, 'SKIP', error.message, logPath);
        skipped++;
        console.log('SKIP');
        continue;
      }
      const detail = error?.message || String(error);
      const entry = {
        tool: t.name,
        status: 'FAIL',
        detail,
        stack: error?.stack,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      fs.writeFileSync(logPath, JSON.stringify(entry, null, 2));
      appendSummary(t.name, 'FAIL', detail, logPath);
      failed++;
      console.log('FAIL');
      if (!options.keepGoing)
        break;
    }
  }

  console.log('');
  console.log(`Results directory: ${resultsDir}`);
  console.log(`Summary: ${summaryPath}`);
  console.log(`Passed: ${passed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0)
    process.exitCode = 1;
}

function test(name, fn) {
  return { name, fn };
}

async function callTool(name, args) {
  if (!state.toolNames.includes(name))
    throw new Error(`Tool is not exposed by MCP server: ${name}`);
  const result = await client.callTool({ name, arguments: args });
  const text = resultText(result);
  const log = {
    tool: name,
    args,
    isError: result.isError === true,
    content: result.content,
    structuredContent: result.structuredContent,
  };
  const callsDir = path.join(resultsDir, 'calls');
  fs.mkdirSync(callsDir, { recursive: true });
  const callPath = path.join(callsDir, `${String(fs.readdirSync(callsDir).length + 1).padStart(3, '0')}-${name}.json`);
  fs.writeFileSync(callPath, JSON.stringify(log, null, 2));
  if (result.isError)
    throw new Error(`Tool ${name} returned isError=true:\n${text}`);
  return result;
}

async function navigate(markup) {
  const result = await callTool('browser_navigate', { url: htmlUrl(markup) });
  return resultText(result);
}

function htmlUrl(markup) {
  const titleMatch = markup.match(/<title>(.*?)<\/title>/is);
  const title = titleMatch?.[1] || 'MCP Harness';
  const body = markup.replace(/<title>.*?<\/title>/gis, '');
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`)}`;
}

function resultText(result) {
  return (result.content || [])
      .filter(item => item.type === 'text')
      .map(item => item.text || '')
      .join('\n');
}

function assertText(result, pattern) {
  const text = typeof result === 'string' ? result : resultText(result);
  if (!pattern.test(text))
    throw new Error(`Expected ${pattern} in result:\n${text.slice(0, 4000)}`);
}

function refFor(snapshotText, label) {
  const lines = snapshotText.split('\n');
  const line = lines.find(candidate => candidate.includes(label) && candidate.includes('[ref='));
  const match = line?.match(/\[ref=([^\]]+)\]/);
  if (!match)
    throw new Error(`Could not find ref for ${label} in snapshot:\n${snapshotText.slice(0, 4000)}`);
  return match[1];
}

function appendSummary(tool, status, detail, logPath) {
  const cleanDetail = String(detail || '').replace(/\s+/g, ' ').slice(0, 300);
  fs.appendFileSync(summaryPath, `${tool}\t${status}\t${cleanDetail}\t${logPath}\n`);
}

async function verifyCoverage(testCases, toolNames) {
  const exposed = new Set(toolNames);
  const covered = new Set(testCases.map(t => t.name));
  const missing = [...exposed].filter(name => !covered.has(name));
  const extra = [...covered].filter(name => !exposed.has(name));
  if (missing.length || extra.length) {
    throw new Error([
      missing.length ? `Missing tests for exposed tools: ${missing.join(', ')}` : '',
      extra.length ? `Tests for non-exposed tools: ${extra.join(', ')}` : '',
    ].filter(Boolean).join('\n'));
  }
}

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    if (request.url === '/audit-site') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>AuditSite</title></head><body><img src="x"><h1>Audit Site</h1></body></html>');
      return;
    }
    if (request.url === '/csp-evaluate') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self'; script-src 'self'",
      });
      response.end('<!doctype html><html><head><title>CSP Evaluate</title></head><body><h1>Strict CSP</h1></body></html>');
      return;
    }
    if (request.url === '/network-json') {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'x-mcp-fixture': 'network-json',
      });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not determine fixture server address'));
        return;
      }
      state.fixtureOrigin = `http://127.0.0.1:${address.port}`;
      resolve(() => new Promise(resolveClose => server.close(resolveClose)));
    });
  });
}

function parseArgs(args) {
  const parsed = {
    only: '',
    includeInstall: false,
    keepGoing: true,
    list: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--only') {
      parsed.only = args[++i] || '';
    } else if (arg === '--include-install') {
      parsed.includeInstall = true;
    } else if (arg === '--fail-fast') {
      parsed.keepGoing = false;
    } else if (arg === '--list') {
      parsed.list = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log(`Usage: .claude/run-mcp-direct-harness.mjs [options]

Directly calls every exposed mcp-accessibility-scanner MCP tool with prepared
fixtures. Results are written to .claude/mcp-direct-harness-results/.

Options:
  --only TOOL          Run one tool test.
  --include-install   Include browser_install, which may install browsers.
  --fail-fast         Stop after the first failure.
  --list              List covered tools.
  -h, --help          Show this help.
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
