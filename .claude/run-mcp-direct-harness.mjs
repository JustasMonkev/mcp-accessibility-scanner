#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const packageJSON = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

const options = parseArgs(process.argv.slice(2));

const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
const resultsDir = path.join(scriptDir, 'mcp-direct-harness-results', runId);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['cli.js', '--headless', '--no-sandbox', '--isolated', ...options.serverArgs],
  cwd: projectRoot,
});
const client = new Client({ name: 'mcp-accessibility-direct-harness', version: '1.0.0' });

const state = {
  tools: [],
  toolNames: [],
  toolsByName: new Map(),
  fixtureOrigin: '',
};

// Pseudo-tool for MCP protocol-level cases that are not tied to one exposed tool.
const PROTOCOL = '@protocol';

class SkipError extends Error {}

const tests = [
  // ---------------------------------------------------------------------------
  // Protocol-level verification: prove the MCP server itself behaves correctly
  // before exercising individual tools.
  // ---------------------------------------------------------------------------

  test(PROTOCOL, 'server identity and instructions', async () => {
    const serverVersion = client.getServerVersion();
    if (!serverVersion?.name)
      throw new Error('Server did not report a name during initialize');
    if (serverVersion.version !== packageJSON.version)
      throw new Error(`Server version ${serverVersion.version} does not match package.json version ${packageJSON.version}`);
    const instructions = client.getInstructions();
    if (!instructions || !/accessibility/i.test(instructions))
      throw new Error(`Server instructions missing or do not mention accessibility:\n${instructions}`);
    const capabilities = client.getServerCapabilities();
    if (!capabilities?.tools)
      throw new Error(`Server did not advertise tools capability: ${JSON.stringify(capabilities)}`);
  }),

  test(PROTOCOL, 'ping', async () => {
    await client.ping();
  }),

  test(PROTOCOL, 'tool catalog is well-formed', async () => {
    const names = new Set();
    // Iterate the raw catalog, not toolsByName: a name-keyed Map silently
    // collapses duplicates before this check could see them.
    for (const tool of state.tools) {
      if (names.has(tool.name))
        throw new Error(`Duplicate tool name: ${tool.name}`);
      names.add(tool.name);
      if (!tool.description?.trim())
        throw new Error(`Tool ${tool.name} has an empty description`);
      if (tool.inputSchema?.type !== 'object')
        throw new Error(`Tool ${tool.name} inputSchema.type is ${tool.inputSchema?.type}, expected "object"`);
      if (!tool.annotations || typeof tool.annotations.readOnlyHint !== 'boolean')
        throw new Error(`Tool ${tool.name} is missing annotations.readOnlyHint`);
      if (!tool.title && !tool.annotations.title)
        throw new Error(`Tool ${tool.name} is missing a title`);
    }
    const expectedTools = ['browser_navigate', 'browser_snapshot', 'scan_page', 'audit_site', 'scan_page_matrix', 'audit_keyboard'];
    for (const name of expectedTools) {
      if (!names.has(name))
        throw new Error(`Expected tool is not exposed: ${name}`);
    }
  }),

  test(PROTOCOL, 'unknown tool is rejected', async () => {
    await expectToolError('no_such_tool_mcp_harness', {}, /not found/i, { allowUnknownTool: true });
  }),

  test(PROTOCOL, 'invalid arguments are rejected with schema errors', async () => {
    await expectToolError('browser_navigate', {}, /Invalid input for tool "browser_navigate"/);
    await expectToolError('browser_tabs', { action: 'explode' }, /Invalid input for tool "browser_tabs"/);
    await expectToolError('browser_navigation_timeout', { timeout: 5 }, /Invalid input for tool "browser_navigation_timeout"/);
  }),

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  test('browser_navigate', '', async () => {
    const result = await callTool('browser_navigate', {
      url: htmlUrl('<title>Navigate</title><h1>Navigate OK</h1>'),
    });
    assertText(result, /Navigate OK|Page Title: Navigate/);
  }),

  test('browser_navigate', 'unreachable url returns tool error', async () => {
    await expectToolError('browser_navigate', { url: 'http://127.0.0.1:9/unreachable' }, /Error|net::|ERR_/i);
  }),

  test('browser_navigate_back', '', async () => {
    await navigate('<title>First</title><h1>First</h1>');
    await navigate('<title>Second</title><h1>Second</h1>');
    await callTool('browser_navigate_back', {});
    const result = await callTool('browser_evaluate', { function: '() => document.title' });
    assertText(result, /First/);
  }),

  // ---------------------------------------------------------------------------
  // Snapshot, find, evaluate
  // ---------------------------------------------------------------------------

  test('browser_snapshot', '', async () => {
    await navigate('<title>Snapshot</title><main><h1>Hello MCP</h1></main>');
    const result = await callTool('browser_snapshot', {});
    assertText(result, /Hello MCP/);
  }),

  test('browser_find', 'text match', async () => {
    await navigate('<title>Find</title><main><h1>Find MCP</h1><p>Needle text</p></main>');
    const result = await callTool('browser_find', { text: 'Needle' });
    assertText(result, /Found 1 match|Needle text/);
  }),

  test('browser_find', 'regex with flags', async () => {
    await navigate('<title>Find</title><main><p>Needle text</p></main>');
    const result = await callTool('browser_find', { regex: '/NEEDLE/i' });
    assertText(result, /Found 1 match/);
  }),

  test('browser_find', 'reports no matches', async () => {
    await navigate('<title>Find</title><main><p>Just hay</p></main>');
    const result = await callTool('browser_find', { text: 'zebra-not-here' });
    assertText(result, /No matches found/);
  }),

  test('browser_find', 'rejects text and regex together', async () => {
    await navigate('<title>Find</title><main><p>Needle</p></main>');
    await expectToolError('browser_find', { text: 'a', regex: 'b' }, /only one of "text" or "regex"/i);
  }),

  test('browser_evaluate', '', async () => {
    await navigateUrl(`${state.fixtureOrigin}/csp-evaluate`);

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

  test('browser_evaluate', 'page exception surfaces as tool error', async () => {
    await navigate('<title>Evaluate</title><h1>Evaluate</h1>');
    await expectToolError('browser_evaluate', { function: '() => { throw new Error("mcp-boom") }' }, /mcp-boom/);
  }),

  // ---------------------------------------------------------------------------
  // Window and console
  // ---------------------------------------------------------------------------

  test('browser_resize', '', async () => {
    await navigate('<title>Resize</title><h1>Resize</h1>');
    await callTool('browser_resize', { width: 640, height: 480 });
    const result = await callTool('browser_evaluate', {
      function: '() => ({ width: window.innerWidth, height: window.innerHeight })',
    });
    assertText(result, /"width":\s*640/);
    assertText(result, /"height":\s*480/);
  }),

  test('browser_console_messages', '', async () => {
    await navigate('<title>Console</title><script>console.log("mcp-console-ok")</script><h1>Console</h1>');
    const result = await callTool('browser_console_messages', {});
    assertText(result, /mcp-console-ok/);
  }),

  test('browser_console_messages', 'captures error and warning levels', async () => {
    await navigate('<title>Console</title><script>console.error("mcp-console-error");console.warn("mcp-console-warn")</script><h1>Console</h1>');
    const result = await callTool('browser_console_messages', {});
    assertText(result, /mcp-console-error/);
    assertText(result, /mcp-console-warn/);
  }),

  // ---------------------------------------------------------------------------
  // Dialogs
  // ---------------------------------------------------------------------------

  test('browser_handle_dialog', 'accept alert', async () => {
    const snapshot = await navigate('<title>Dialog</title><button onclick="alert(\'mcp-dialog-ok\')">Open dialog</button>');
    const ref = refFor(snapshot, 'Open dialog');
    await callTool('browser_click', { element: 'Open dialog button', ref });
    await callTool('browser_handle_dialog', { accept: true });
  }),

  test('browser_handle_dialog', 'dismiss confirm yields false', async () => {
    const snapshot = await navigate('<title>Dialog</title><button onclick="document.body.dataset.answer=String(confirm(\'sure?\'))">Ask</button>');
    const ref = refFor(snapshot, 'Ask');
    await callTool('browser_click', { element: 'Ask button', ref });
    await callTool('browser_handle_dialog', { accept: false });
    const result = await callTool('browser_evaluate', { function: '() => document.body.dataset.answer' });
    assertText(result, /false/);
  }),

  test('browser_handle_dialog', 'accept prompt with text', async () => {
    const snapshot = await navigate('<title>Dialog</title><button onclick="document.body.dataset.answer=prompt(\'name?\')">Ask name</button>');
    const ref = refFor(snapshot, 'Ask name');
    await callTool('browser_click', { element: 'Ask name button', ref });
    await callTool('browser_handle_dialog', { accept: true, promptText: 'Ada Lovelace' });
    const result = await callTool('browser_evaluate', { function: '() => document.body.dataset.answer' });
    assertText(result, /Ada Lovelace/);
  }),

  test('browser_handle_dialog', 'errors when no dialog is open', async () => {
    await navigate('<title>Dialog</title><h1>No dialog</h1>');
    await expectToolError('browser_handle_dialog', { accept: true }, /no modal state|No dialog visible/i);
  }),

  // ---------------------------------------------------------------------------
  // Forms and input
  // ---------------------------------------------------------------------------

  test('browser_file_upload', '', async () => {
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

  test('browser_fill_form', '', async () => {
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

  test('browser_press_key', 'character key', async () => {
    await navigate('<title>Press</title><input aria-label="Key target" autofocus onkeydown="document.body.dataset.key=event.key">');
    await callTool('browser_press_key', { key: 'A' });
    const result = await callTool('browser_evaluate', { function: '() => document.body.dataset.key' });
    assertText(result, /A|a/);
  }),

  test('browser_press_key', 'named key', async () => {
    await navigate('<title>Press</title><input aria-label="Key target" autofocus onkeydown="document.body.dataset.key=event.key">');
    await callTool('browser_press_key', { key: 'ArrowRight' });
    const result = await callTool('browser_evaluate', { function: '() => document.body.dataset.key' });
    assertText(result, /ArrowRight/);
  }),

  test('browser_type', '', async () => {
    const snapshot = await navigate('<title>Type</title><label>Message <input aria-label="Message"></label>');
    const ref = refFor(snapshot, 'Message');
    await callTool('browser_type', { element: 'Message input', ref, text: 'typed text' });
    const result = await callTool('browser_evaluate', { function: '() => document.querySelector("input").value' });
    assertText(result, /typed text/);
  }),

  test('browser_type', 'slowly with submit', async () => {
    const snapshot = await navigate([
      '<title>Type</title>',
      '<label>Message <input aria-label="Message" ',
      'onkeydown="document.body.dataset.keys=(document.body.dataset.keys||\'\')+event.key;',
      'if(event.key===\'Enter\')document.body.dataset.submitted=\'yes\'"></label>',
    ].join(''));
    const ref = refFor(snapshot, 'Message');
    await callTool('browser_type', { element: 'Message input', ref, text: 'hi', slowly: true, submit: true });
    const result = await callTool('browser_evaluate', {
      function: '() => ({ keys: document.body.dataset.keys, submitted: document.body.dataset.submitted })',
    });
    assertText(result, /"keys":\s*"hiEnter"/);
    assertText(result, /"submitted":\s*"yes"/);
  }),

  // ---------------------------------------------------------------------------
  // Pointer interactions
  // ---------------------------------------------------------------------------

  test('browser_click', '', async () => {
    const snapshot = await navigate('<title>Click</title><button onclick="document.body.dataset.clicked=\'yes\'">Click me</button>');
    const ref = refFor(snapshot, 'Click me');
    await callTool('browser_click', { element: 'Click me button', ref });
    const result = await callTool('browser_evaluate', { function: '() => document.body.dataset.clicked' });
    assertText(result, /yes/);
  }),

  test('browser_click', 'double click', async () => {
    const snapshot = await navigate('<title>Click</title><button ondblclick="document.body.dataset.doubled=\'yes\'">Double me</button>');
    const ref = refFor(snapshot, 'Double me');
    await callTool('browser_click', { element: 'Double me button', ref, doubleClick: true });
    const result = await callTool('browser_evaluate', { function: '() => document.body.dataset.doubled' });
    assertText(result, /yes/);
  }),

  test('browser_click', 'stale ref returns tool error', async () => {
    await navigate('<title>Click</title><button>Only button</button>');
    await expectToolError('browser_click', { element: 'Ghost button', ref: 'e999' }, /Ref e999 not found/i);
  }),

  test('browser_drag', '', async () => {
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

  test('browser_hover', '', async () => {
    const snapshot = await navigate('<title>Hover</title><button onmouseover="document.body.dataset.hovered=\'yes\'">Hover me</button>');
    const ref = refFor(snapshot, 'Hover me');
    await callTool('browser_hover', { element: 'Hover me button', ref });
    const result = await callTool('browser_evaluate', { function: '() => document.body.dataset.hovered' });
    assertText(result, /yes/);
  }),

  test('browser_select_option', 'single value', async () => {
    const snapshot = await navigate('<title>Select</title><label>Choice <select aria-label="Choice"><option value="one">One</option><option value="two">Two</option></select></label>');
    const ref = refFor(snapshot, 'Choice');
    await callTool('browser_select_option', { element: 'Choice combobox', ref, values: ['two'] });
    const result = await callTool('browser_evaluate', { function: '() => document.querySelector("select").value' });
    assertText(result, /two/);
  }),

  test('browser_select_option', 'multiple values', async () => {
    const snapshot = await navigate('<title>Select</title><label>Choices <select multiple aria-label="Choices"><option value="one">One</option><option value="two">Two</option><option value="three">Three</option></select></label>');
    const ref = refFor(snapshot, 'Choices');
    await callTool('browser_select_option', { element: 'Choices listbox', ref, values: ['one', 'three'] });
    const result = await callTool('browser_evaluate', {
      function: '() => Array.from(document.querySelector("select").selectedOptions).map(o => o.value).join(",")',
    });
    assertText(result, /one,three/);
  }),

  // ---------------------------------------------------------------------------
  // Network
  // ---------------------------------------------------------------------------

  test('browser_network_requests', '', async () => {
    await navigateUrl(`${state.fixtureOrigin}/network-json`);
    const result = await callTool('browser_network_requests', {});
    assertText(result, /\[GET\].*\/network-json/);
  }),

  // ---------------------------------------------------------------------------
  // Screenshots
  // ---------------------------------------------------------------------------

  test('browser_take_screenshot', 'viewport screenshot saved to disk', async () => {
    await navigate('<title>Screenshot</title><h1>Screenshot OK</h1>');
    const result = await callTool('browser_take_screenshot', {
      type: 'png',
      filename: 'mcp-direct-harness-screenshot.png',
      fullPage: false,
    });
    const file = savedFileFrom(result, /saved it as (.+)$/m);
    if (!hasImage(result))
      throw new Error('Viewport screenshot response did not include an image attachment');
    assertPngFile(file);
  }),

  test('browser_take_screenshot', 'element screenshot', async () => {
    const snapshot = await navigate('<title>Screenshot</title><button>Shot target</button>');
    const ref = refFor(snapshot, 'Shot target');
    const result = await callTool('browser_take_screenshot', {
      type: 'png',
      filename: 'mcp-direct-harness-element.png',
      element: 'Shot target button',
      ref,
    });
    assertText(result, /Took the Shot target button screenshot/);
    assertPngFile(savedFileFrom(result, /saved it as (.+)$/m));
  }),

  // ---------------------------------------------------------------------------
  // Tabs and timeouts
  // ---------------------------------------------------------------------------

  test('browser_tabs', 'list/new/select/close change tab count', async () => {
    await navigate('<title>Tabs</title><h1>Tabs</h1>');
    const afterNew = await callTool('browser_tabs', { action: 'new' });
    assertText(afterNew, /- 0:/);
    assertText(afterNew, /- 1:.*current/);
    await callTool('browser_tabs', { action: 'select', index: 0 });
    const afterClose = await callTool('browser_tabs', { action: 'close', index: 1 });
    if (/- 1:/.test(resultText(afterClose)))
      throw new Error(`Tab 1 still listed after close:\n${resultText(afterClose).slice(0, 2000)}`);
  }),

  test('browser_tabs', 'select without index errors', async () => {
    await callTool('browser_tabs', { action: 'list' });
    await expectToolError('browser_tabs', { action: 'select' }, /Tab index is required/i);
  }),

  test('browser_navigation_timeout', '', async () => {
    await navigate('<title>NavTimeout</title><h1>NavTimeout</h1>');
    const result = await callTool('browser_navigation_timeout', { timeout: 30000 });
    assertText(result, /Navigation timeout set to 30000ms/);
  }),

  test('browser_default_timeout', '', async () => {
    await navigate('<title>DefaultTimeout</title><h1>DefaultTimeout</h1>');
    const result = await callTool('browser_default_timeout', { timeout: 30000 });
    assertText(result, /Default timeout set to 30000ms/);
  }),

  // ---------------------------------------------------------------------------
  // Waiting
  // ---------------------------------------------------------------------------

  test('browser_wait_for', 'text appears', async () => {
    await navigate('<title>Wait</title><script>setTimeout(() => { const p = document.createElement("p"); p.textContent = "Ready Text"; document.body.appendChild(p); }, 100)</script><h1>Waiting</h1>');
    const result = await callTool('browser_wait_for', { text: 'Ready Text' });
    assertText(result, /Ready Text|Waited for Ready Text/);
  }),

  test('browser_wait_for', 'text disappears', async () => {
    await navigate('<title>Wait</title><p id="gone">Vanishing Text</p><script>setTimeout(() => document.getElementById("gone").remove(), 100)</script>');
    const result = await callTool('browser_wait_for', { textGone: 'Vanishing Text' });
    assertText(result, /Waited for Vanishing Text/);
  }),

  test('browser_wait_for', 'requires a condition', async () => {
    await navigate('<title>Wait</title><h1>Waiting</h1>');
    await expectToolError('browser_wait_for', {}, /Either time, text or textGone must be provided/i);
  }),

  // ---------------------------------------------------------------------------
  // Accessibility scanning: the core purpose of this server. Verify it not only
  // completes but actually detects known violations and produces real reports.
  // ---------------------------------------------------------------------------

  test('scan_page', 'detects a known violation', async () => {
    await navigate('<title>Scan</title><img src="x"><h1>Scan</h1>');
    const result = await callTool('scan_page', { violationsTag: ['wcag2a', 'wcag2aa'] });
    assertText(result, /Violations: [1-9]/);
    assertText(result, /alt attribute/i);
  }),

  test('scan_page', 'clean page reports zero violations', async () => {
    await navigateUrl(`${state.fixtureOrigin}/clean-page`);
    const result = await callTool('scan_page', { violationsTag: ['wcag2a', 'wcag2aa'] });
    assertText(result, /Violations: 0/);
  }),

  test('audit_site', 'writes a parseable JSON report', async () => {
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
    assertText(result, /JSON report:/);
    const report = readJsonReport(result);
    if (!Array.isArray(report.pages) || report.pages.length !== 1)
      throw new Error(`Expected 1 scanned page in audit_site report, got: ${JSON.stringify(report.pages?.length)}`);
    if (!resultResourceLinks(result).length)
      throw new Error('audit_site response did not include a resource_link to the report');
    if (!result.structuredContent)
      throw new Error('audit_site response did not include structuredContent');
  }),

  test('scan_page_matrix', 'scans all variants and reports deltas', async () => {
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
    assertText(result, /JSON report:/);
    assertText(result, /baseline/);
    assertText(result, /mobile/);
    const report = readJsonReport(result);
    if (!Array.isArray(report.variants) || report.variants.length !== 2)
      throw new Error(`Expected 2 variants in scan_page_matrix report, got: ${JSON.stringify(report.variants?.length)}`);
    if (!result.structuredContent)
      throw new Error('scan_page_matrix response did not include structuredContent');
  }),

  test('audit_keyboard', 'audits tab order and writes report', async () => {
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
    assertText(result, /JSON report:/);
    readJsonReport(result);
    if (!result.structuredContent)
      throw new Error('audit_keyboard response did not include structuredContent');
  }),

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  test('browser_install', '', async () => {
    if (!options.includeInstall)
      throw new SkipError('browser_install skipped by default; rerun with --include-install');
    await callTool('browser_install', {});
  }),

  test('browser_close', '', async () => {
    await navigate('<title>Close</title><h1>Close target</h1>');
    await callTool('browser_close', {});
  }),
];

if (options.list) {
  for (const t of tests)
    console.log(`${t.id}${t.tool === 'browser_install' ? ' (optional)' : ''}`);
  process.exit(0);
}

const uploadFile = path.join(resultsDir, 'mcp-upload.txt');
const summaryPath = path.join(resultsDir, 'summary.tsv');
if (!options.listTools) {
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(uploadFile, 'mcp upload fixture\n');
  fs.writeFileSync(summaryPath, 'case\tstatus\tduration_ms\tdetail\tlog\n');
}

try {
  var closeFixtureServer = await startFixtureServer();
  await client.connect(transport);
  const { tools } = await client.listTools();
  state.tools = tools;
  state.toolNames = tools.map(t => t.name);
  state.toolsByName = new Map(tools.map(t => [t.name, t]));
  if (options.listTools) {
    for (const name of state.toolNames)
      console.log(name);
    process.exit(0);
  }
  await verifyCoverage(tests, state.toolNames);
  await runTests();
} finally {
  await closeFixtureServer?.().catch(() => undefined);
  await client.close().catch(() => undefined);
}

async function runTests() {
  const selected = tests.filter(t => {
    if (options.only && t.tool !== options.only)
      return false;
    if (options.grep && !t.id.includes(options.grep))
      return false;
    return true;
  });
  if (selected.length === 0)
    throw new Error(`No test matched${options.only ? ` --only ${options.only}` : ''}${options.grep ? ` --grep ${options.grep}` : ''}`);

  const runStartedAt = new Date().toISOString();
  const caseResults = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const [index, t] of selected.entries()) {
    const logPath = path.join(resultsDir, `${String(index + 1).padStart(2, '0')}-${safeFileName(t.id)}.json`);
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    process.stdout.write(`[${index + 1}/${selected.length}] ${t.id} ... `);
    try {
      await t.fn();
      const durationMs = Date.now() - startedMs;
      const entry = { case: t.id, tool: t.tool, status: 'PASS', startedAt, durationMs, finishedAt: new Date().toISOString() };
      fs.writeFileSync(logPath, JSON.stringify(entry, null, 2));
      appendSummary(t.id, 'PASS', durationMs, '', logPath);
      caseResults.push(entry);
      passed++;
      console.log(`PASS (${durationMs}ms)`);
    } catch (error) {
      const durationMs = Date.now() - startedMs;
      if (error instanceof SkipError) {
        const entry = { case: t.id, tool: t.tool, status: 'SKIP', reason: error.message, startedAt, durationMs, finishedAt: new Date().toISOString() };
        fs.writeFileSync(logPath, JSON.stringify(entry, null, 2));
        appendSummary(t.id, 'SKIP', durationMs, error.message, logPath);
        caseResults.push(entry);
        skipped++;
        console.log('SKIP');
        continue;
      }
      const detail = error?.message || String(error);
      const entry = {
        case: t.id,
        tool: t.tool,
        status: 'FAIL',
        detail,
        stack: error?.stack,
        startedAt,
        durationMs,
        finishedAt: new Date().toISOString(),
      };
      fs.writeFileSync(logPath, JSON.stringify(entry, null, 2));
      appendSummary(t.id, 'FAIL', durationMs, detail, logPath);
      caseResults.push(entry);
      failed++;
      console.log('FAIL');
      if (!options.keepGoing)
        break;
    }
  }

  const serverVersion = client.getServerVersion();
  fs.writeFileSync(path.join(resultsDir, 'summary.json'), JSON.stringify({
    runId,
    startedAt: runStartedAt,
    finishedAt: new Date().toISOString(),
    server: serverVersion ? { name: serverVersion.name, version: serverVersion.version } : undefined,
    exposedTools: state.toolNames,
    counts: { passed, skipped, failed, notRun: selected.length - caseResults.length, total: selected.length },
    cases: caseResults,
  }, null, 2));

  console.log('');
  console.log(`Results directory: ${resultsDir}`);
  console.log(`Summary: ${summaryPath}`);
  console.log(`Exposed tools: ${state.toolNames.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);
  for (const entry of caseResults.filter(c => c.status === 'FAIL'))
    console.log(`  FAIL ${entry.case}: ${entry.detail.split('\n')[0]}`);

  if (failed > 0)
    process.exitCode = 1;
}

function test(tool, title, fn) {
  return { tool, title, id: title ? `${tool} [${title}]` : tool, fn };
}

async function callTool(name, args) {
  if (!state.toolNames.includes(name))
    throw new Error(`Tool is not exposed by MCP server: ${name}`);
  const result = await client.callTool({ name, arguments: args });
  logCall(name, args, result);
  if (result.isError)
    throw new Error(`Tool ${name} returned isError=true:\n${resultText(result)}`);
  return result;
}

// Asserts that calling the tool fails, either as an isError result (tool
// execution error) or as a protocol-level rejection, with a message matching
// the pattern.
async function expectToolError(name, args, pattern, { allowUnknownTool = false } = {}) {
  if (!allowUnknownTool && !state.toolNames.includes(name))
    throw new Error(`Tool is not exposed by MCP server: ${name}`);
  let message;
  try {
    const result = await client.callTool({ name, arguments: args });
    logCall(name, args, result);
    if (result.isError !== true)
      throw new Error(`Expected tool ${name} to fail, but it succeeded:\n${resultText(result).slice(0, 2000)}`);
    message = resultText(result);
  } catch (error) {
    if (error?.name !== 'McpError')
      throw error;
    logCall(name, args, { protocolError: error.message });
    message = error.message;
  }
  if (!pattern.test(message))
    throw new Error(`Expected error matching ${pattern} from ${name}, got:\n${message.slice(0, 2000)}`);
}

function logCall(name, args, result) {
  const log = {
    tool: name,
    args,
    isError: result.isError === true,
    content: result.content,
    structuredContent: result.structuredContent,
    protocolError: result.protocolError,
  };
  const callsDir = path.join(resultsDir, 'calls');
  fs.mkdirSync(callsDir, { recursive: true });
  const callPath = path.join(callsDir, `${String(fs.readdirSync(callsDir).length + 1).padStart(3, '0')}-${safeFileName(name)}.json`);
  fs.writeFileSync(callPath, JSON.stringify(log, null, 2));
}

async function navigate(markup) {
  return await navigateUrl(htmlUrl(markup));
}

// A navigation that just failed (e.g. the unreachable-url case) can leave
// Chromium still committing its error page, which interrupts the next goto.
// Retry briefly to absorb that race.
async function navigateUrl(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await callTool('browser_navigate', { url });
      return resultText(result);
    } catch (error) {
      if (attempt >= 3 || !/interrupted by another navigation/.test(String(error?.message)))
        throw error;
      await new Promise(f => setTimeout(f, 250));
    }
  }
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

function resultResourceLinks(result) {
  return (result.content || []).filter(item => item.type === 'resource_link');
}

function hasImage(result) {
  return (result.content || []).some(item => item.type === 'image');
}

function assertText(result, pattern) {
  const text = typeof result === 'string' ? result : resultText(result);
  if (!pattern.test(text))
    throw new Error(`Expected ${pattern} in result:\n${text.slice(0, 4000)}`);
}

function savedFileFrom(result, pattern) {
  const match = resultText(result).match(pattern);
  if (!match)
    throw new Error(`Could not find saved file path via ${pattern} in result:\n${resultText(result).slice(0, 2000)}`);
  return match[1].trim();
}

function assertPngFile(file) {
  if (!fs.existsSync(file))
    throw new Error(`Screenshot file does not exist on disk: ${file}`);
  const header = fs.readFileSync(file).subarray(0, 8);
  if (!header.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    throw new Error(`File is not a valid PNG: ${file}`);
}

function readJsonReport(result) {
  const reportPath = savedFileFrom(result, /JSON report: (.+)$/m);
  if (!fs.existsSync(reportPath))
    throw new Error(`JSON report does not exist on disk: ${reportPath}`);
  try {
    return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (error) {
    throw new Error(`JSON report is not valid JSON (${reportPath}): ${error.message}`);
  }
}

function refFor(snapshotText, label) {
  const lines = snapshotText.split('\n');
  const line = lines.find(candidate => candidate.includes(label) && candidate.includes('[ref='));
  const match = line?.match(/\[ref=([^\]]+)\]/);
  if (!match)
    throw new Error(`Could not find ref for ${label} in snapshot:\n${snapshotText.slice(0, 4000)}`);
  return match[1];
}

function safeFileName(value) {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
}

function appendSummary(caseId, status, durationMs, detail, logPath) {
  const cleanDetail = String(detail || '').replace(/\s+/g, ' ').slice(0, 300);
  fs.appendFileSync(summaryPath, `${caseId}\t${status}\t${durationMs}\t${cleanDetail}\t${logPath}\n`);
}

async function verifyCoverage(testCases, toolNames) {
  const exposed = new Set(toolNames);
  const covered = new Set(testCases.map(t => t.tool).filter(tool => tool !== PROTOCOL));
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
    if (request.url === '/clean-page') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end([
        '<!doctype html><html lang="en"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>Clean Page</title></head>',
        '<body><main><h1>Accessible page</h1>',
        '<p>This page is intentionally free of axe-core violations.</p>',
        '<img src="x" alt="Placeholder image">',
        '<label>Search <input type="search" name="q"></label>',
        '<button type="button">Go</button></main></body></html>',
      ].join(''));
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
    grep: '',
    includeInstall: false,
    keepGoing: true,
    list: false,
    listTools: false,
    serverArgs: process.env.MCP_HARNESS_SERVER_ARGS ? process.env.MCP_HARNESS_SERVER_ARGS.split(/\s+/).filter(Boolean) : [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--only') {
      parsed.only = args[++i] || '';
    } else if (arg === '--browser') {
      parsed.serverArgs.push('--browser', args[++i] || '');
    } else if (arg === '--executable-path') {
      parsed.serverArgs.push('--executable-path', args[++i] || '');
    } else if (arg === '--server-arg') {
      parsed.serverArgs.push(args[++i] || '');
    } else if (arg === '--grep') {
      parsed.grep = args[++i] || '';
    } else if (arg === '--include-install') {
      parsed.includeInstall = true;
    } else if (arg === '--fail-fast') {
      parsed.keepGoing = false;
    } else if (arg === '--list') {
      parsed.list = true;
    } else if (arg === '--list-tools') {
      parsed.listTools = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log(`Usage: .claude/run-mcp-direct-harness.mjs [options]

Verifies the mcp-accessibility-scanner MCP server end-to-end: protocol-level
checks (initialize metadata, tool catalog, error handling) plus positive and
negative cases for every exposed tool, using prepared fixtures. Results are
written to .claude/mcp-direct-harness-results/.

Options:
  --only TOOL          Run all cases for one tool (or "${PROTOCOL}").
  --grep TEXT          Run cases whose id contains TEXT.
  --include-install   Include browser_install, which may install browsers.
  --fail-fast         Stop after the first failure.
  --list              List covered cases without running them.
  --list-tools        Connect to the server, print exposed tool names, exit.
  --browser NAME      Browser/channel passed through to the server CLI.
  --executable-path P Browser executable passed through to the server CLI.
  --server-arg ARG    Extra raw argument for the server CLI (repeatable).
  -h, --help          Show this help.

Environment:
  MCP_HARNESS_SERVER_ARGS   Extra server CLI arguments (space separated).
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
