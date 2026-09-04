#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

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
  deadPort: 0,
  // Every path the fixture server was asked for, so a test can assert a tool
  // rejected its arguments without visiting anything.
  fixtureRequests: [],
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
    const snapshot = await navigate('<title>Evaluate</title><h1 id="answer">OK</h1>');
    const result = await callTool('browser_evaluate', { function: '() => 2 + 2' });
    assertText(result, /\b4\b/);
    // Bare expressions are wrapped into a function, on the page and on an element.
    assertText(await callTool('browser_evaluate', { function: 'document.title' }), /Evaluate/);
    assertText(await callTool('browser_evaluate', { function: '{ id: document.getElementById("answer").id }' }), /"id":\s*"answer"/);
    const ref = refFor(snapshot, 'OK');
    assertText(await callTool('browser_evaluate', { function: 'element.textContent', element: 'Answer heading', ref }), /OK/);
  }),

  test('browser_resize', async () => {
    await navigate('<title>Resize</title><h1>Resize</h1>');
    await callTool('browser_resize', { width: 640, height: 480 });
    const result = await callTool('browser_evaluate', {
      function: '() => ({ width: window.innerWidth, height: window.innerHeight })',
    });
    assertText(result, /"width":\s*640|"height":\s*480/);
  }),

  test('browser_emulate_media', async () => {
    await navigate('<title>Media</title><h1>Media</h1>');
    try {
      await callTool('browser_emulate_media', { colorScheme: 'dark', reducedMotion: 'reduce' });
      const result = await callTool('browser_evaluate', {
        function: '() => ({ dark: matchMedia("(prefers-color-scheme: dark)").matches, reduced: matchMedia("(prefers-reduced-motion: reduce)").matches })',
      });
      assertText(result, /"dark":\s*true/);
      assertText(result, /"reduced":\s*true/);
    } finally {
      await callTool('browser_emulate_media', { colorScheme: 'light', reducedMotion: 'no-preference' });
    }
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
    assertText(result, /^\[1\] \[GET\]/m);
  }),

  test('browser_network_request', async () => {
    await callTool('browser_navigate', { url: `${state.fixtureOrigin}/network-json` });
    const list = await callTool('browser_network_requests', {});
    const result = await callTool('browser_network_request', { index: indexFor(resultText(list), /\/network-json/) });
    assertText(result, /#### Request headers/);
    assertText(result, /x-mcp-fixture: network-json/);
    assertText(result, /#### Response\n\[200\] OK/);
    assertText(result, /<redacted, 11 bytes, application\/json>/);
    assertNoText(result, /\{"ok":true\}/);

    // An out-of-range index reports the usable range instead of a stack trace.
    await assertToolError('browser_network_request', { index: 999 }, /No network request with index 999/);

    // Real Chromium header names must hit the redaction set: sign in so the
    // next request carries a session cookie, then prove it is not echoed back.
    await callTool('browser_navigate', { url: `${state.fixtureOrigin}/login` });
    await callTool('browser_navigate', { url: `${state.fixtureOrigin}/secure` });
    const secureList = await callTool('browser_network_requests', {});
    const secure = await callTool('browser_network_request', { index: indexFor(resultText(secureList), /\/secure/) });
    assertText(secure, /cookie: <redacted, \d+ characters>/);
    assertNoText(secure, /mcp_session=granted/);

    // A real binary payload must be summarised, never rendered as text.
    await callTool('browser_navigate', { url: `${state.fixtureOrigin}/network-png` });
    const pngList = await callTool('browser_network_requests', {});
    const png = await callTool('browser_network_request', { index: indexFor(resultText(pngList), /\/network-png\.png/) });
    assertText(png, /<redacted, \d+ bytes, image\/png>/);
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
      '<div role="region" aria-label="Drop zone" style="width:160px;height:60px;background:#cfa" ',
      'ondragover="event.preventDefault()" ',
      'ondrop="event.preventDefault();document.body.dataset.dropped=event.dataTransfer.getData(\'text/plain\')">Drop here</div>',
    ].join(''));
    const ref = refFor(snapshot, 'Drop zone');
    await callTool('browser_drop', {
      element: 'Drop zone',
      ref,
      data: { 'text/plain': 'dropped-payload' },
    });
    const result = await callTool('browser_evaluate', { function: '() => document.body.dataset.dropped' });
    assertText(result, /dropped-payload/);

    // Neither paths nor data means there is nothing to drop.
    await assertToolError('browser_drop', { element: 'Drop zone', ref }, /Provide "paths", "data" or both/);
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
    // The background-image heading makes axe report color-contrast as
    // "incomplete" rather than pass/fail, exercising the needs-review path.
    await navigate('<title>Scan</title><img src="x"><h1 style="background-image:url(x);color:#777">Scan</h1>');
    const result = await callTool('scan_page', { violationsTag: ['wcag2a', 'wcag2aa'] });
    assertText(result, /Violations:/);
    assertText(result, /Incomplete \(needs review/);
    assertText(result, /Incomplete rule: color-contrast/);

    const withoutIncomplete = await callTool('scan_page', {
      violationsTag: ['wcag2a', 'wcag2aa'],
      includeIncomplete: false,
    });
    if (/Incomplete/.test(resultText(withoutIncomplete)))
      throw new Error('includeIncomplete=false still reported incomplete rules or their count');

    // Defaults must mean "this fails WCAG/Section 508". Axe ORs runOnly tags,
    // so a cat.* tag in the default set silently readmits best-practice rules
    // like region and landmark-one-main, which this page triggers.
    await navigate('<title>Defaults</title><h1>Defaults</h1><p>Loose content outside any landmark.</p>');
    const defaults = resultText(await callTool('scan_page', { includeIncomplete: false }));
    for (const ruleId of ['region', 'landmark-one-main']) {
      if (new RegExp(`Violation rule: ${ruleId}\\b`).test(defaults))
        throw new Error(`Default scan reported best-practice rule "${ruleId}"; defaults must be conformance-only`);
    }
    // Same page, best-practice requested: proves the rules really do fire here.
    const bestPractice = resultText(await callTool('scan_page', {
      violationsTag: ['best-practice'],
      includeIncomplete: false,
    }));
    for (const ruleId of ['region', 'landmark-one-main']) {
      if (!new RegExp(`Violation rule: ${ruleId}\\b`).test(bestPractice))
        throw new Error(`Fixture no longer triggers "${ruleId}"; the default-tags assertion above proves nothing`);
    }

    // Scoping: one violating image inside the widget, one outside it.
    await navigate([
      '<title>Scope</title>',
      '<div id="widget"><img src="x"></div>',
      '<main id="content"><img src="y"></main>',
    ].join(''));
    const scanArgs = { violationsTag: ['wcag2a', 'wcag2aa'], includeIncomplete: false };
    assertViolationNodeCount(await callTool('scan_page', scanArgs), 'image-alt', 2);
    assertViolationNodeCount(
        await callTool('scan_page', { ...scanArgs, includeSelectors: ['#content'] }), 'image-alt', 1);
    assertViolationNodeCount(
        await callTool('scan_page', { ...scanArgs, excludeSelectors: ['#widget'] }), 'image-alt', 1);
    assertViolationNodeCount(
        await callTool('scan_page', { ...scanArgs, excludeSelectors: ['#widget', '#content'] }), 'image-alt', 0);
    // An exclude that is absent from this page is a legitimate no-op.
    assertViolationNodeCount(
        await callTool('scan_page', { ...scanArgs, excludeSelectors: ['#not-on-this-page'] }), 'image-alt', 2);

    // Axe alone accepts a partly-matching include set and silently scans less;
    // the scanner must refuse instead of returning a clean half-scoped report.
    await assertToolError(
        'scan_page',
        { ...scanArgs, includeSelectors: ['#content', '#typo-not-here'] },
        /No elements matched includeSelectors: #typo-not-here/);
    await assertToolError(
        'scan_page',
        { ...scanArgs, includeSelectors: ['#nope-does-not-exist'] },
        /No elements matched includeSelectors: #nope-does-not-exist/);
    await assertToolError(
        'scan_page',
        { ...scanArgs, excludeSelectors: [':::not-css'] },
        /Invalid CSS in excludeSelectors: :::not-css/);

    // Annotated screenshots.
    await navigate('<title>Scan</title><img src="x" width="120" height="60"><h1>Scan</h1>');
    const plain = await callTool('scan_page', { violationsTag: ['wcag2a', 'wcag2aa'] });
    if (/Annotated screenshot/.test(resultText(plain)))
      throw new Error('scan_page annotated a screenshot without annotateScreenshot');

    const annotated = await callTool('scan_page', { violationsTag: ['wcag2a', 'wcag2aa'], annotateScreenshot: true });
    const annotatedText = resultText(annotated);
    assertText(annotatedText, /Annotated screenshot: .+\.png/);
    const screenshotPath = annotatedText.match(/Annotated screenshot: (.+\.png)/)[1];
    const screenshotSize = fs.statSync(screenshotPath).size;
    if (screenshotSize < 1000)
      throw new Error(`Annotated screenshot looks empty (${screenshotSize} bytes): ${screenshotPath}`);
    const marked = annotatedText.match(/Marked (\d+) of (\d+) violating nodes\./);
    if (!marked || Number(marked[1]) < 1)
      throw new Error(`Expected at least one marked node in result:\n${annotatedText.slice(0, 4000)}`);

    const leftovers = await callTool('browser_evaluate', {
      function: '() => ({ layers: document.querySelectorAll("#mcp-a11y-annotation-layer").length, idInHtml: document.documentElement.innerHTML.includes("mcp-a11y-annotation-layer") })',
    });
    assertText(leftovers, /"layers":\s*0/);
    assertText(leftovers, /"idInHtml":\s*false/);

    // Rule-level control: two images with no alt (image-alt) plus a form input
    // with no label (label), so each rule filter has a different rule to move.
    await navigate([
      '<title>Rules</title>',
      '<img src="x"><img src="y">',
      '<input type="text" name="q">',
    ].join(''));
    const ruleArgs = { violationsTag: ['wcag2a', 'wcag2aa'], includeIncomplete: false };
    const both = await callTool('scan_page', ruleArgs);
    assertViolationNodeCount(both, 'image-alt', 2);
    assertViolationNodeCount(both, 'label', 1);

    // withRules overrides violationsTag entirely: axe holds either a rule list
    // or a tag list, never both.
    const onlyLabel = await callTool('scan_page', { ...ruleArgs, withRules: ['label'] });
    assertViolationNodeCount(onlyLabel, 'label', 1);
    assertViolationNodeCount(onlyLabel, 'image-alt', 0);

    // disableRules subtracts from whatever is selected — tags here...
    const noImages = await callTool('scan_page', { ...ruleArgs, disableRules: ['image-alt'] });
    assertViolationNodeCount(noImages, 'image-alt', 0);
    assertViolationNodeCount(noImages, 'label', 1);
    // ...and an explicit rule list here. Axe drops the disabled-rule flag once
    // runOnly holds a rule list, so without the scanner subtracting up front
    // this would still report image-alt.
    const listMinusImages = await callTool('scan_page', {
      ...ruleArgs,
      withRules: ['image-alt', 'label'],
      disableRules: ['image-alt'],
    });
    assertViolationNodeCount(listMinusImages, 'image-alt', 0);
    assertViolationNodeCount(listMinusImages, 'label', 1);

    // Emptying the rule list must fail, not fall back to scanning everything.
    await assertToolError(
        'scan_page',
        { ...ruleArgs, withRules: ['image-alt'], disableRules: ['image-alt'] },
        /disableRules disabled every rule in withRules \(image-alt\)/);

    // A misspelled rule id would otherwise select/disable nothing and return a
    // clean-looking report, so it must fail by name instead.
    await assertToolError(
        'scan_page',
        { ...ruleArgs, withRules: ['label', 'image-altt'] },
        /Unknown Axe rule id\(s\) in withRules: image-altt/);
    await assertToolError(
        'scan_page',
        { ...ruleArgs, disableRules: ['colour-contrast'] },
        /Unknown Axe rule id\(s\) in disableRules: colour-contrast/);
  }),

  test('browser_tabs', async () => {
    await callTool('browser_tabs', { action: 'list' });
    await callTool('browser_tabs', { action: 'new' });
    await callTool('browser_tabs', { action: 'list' });
    await callTool('browser_tabs', { action: 'select', index: 0 });
    await callTool('browser_tabs', { action: 'close', index: 1 });
  }),

  test('browser_session_open', async () => {
    const result = await callTool('browser_session_open', {});
    const browserSessionId = result.structuredContent?.browserSessionId;
    if (typeof browserSessionId !== 'string' || !browserSessionId.startsWith('bs_'))
      throw new Error(`Expected browser session handle, got ${JSON.stringify(browserSessionId)}`);
    assertText(result, new RegExp(browserSessionId));
    await callTool('browser_tabs', { action: 'list', browserSessionId });
    await callTool('browser_session_close', { browserSessionId });
  }),

  test('browser_session_close', async () => {
    const opened = await callTool('browser_session_open', {});
    const browserSessionId = opened.structuredContent?.browserSessionId;
    // Without this check an absent handle would build new RegExp(undefined),
    // i.e. the empty pattern /(?:)/ that matches anything, letting the
    // assertions below pass vacuously.
    if (typeof browserSessionId !== 'string' || !browserSessionId.startsWith('bs_'))
      throw new Error(`Expected browser session handle, got ${JSON.stringify(browserSessionId)}`);
    const result = await callTool('browser_session_close', { browserSessionId });
    assertText(result, new RegExp(browserSessionId));
    await assertToolError(
      'browser_tabs',
      { action: 'list', browserSessionId },
      /Unknown browserSessionId/,
    );
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
    // audit_site crawls in a second tab, so it needs an open page to return to.
    // Without this the test only passes when an earlier test left a tab open.
    await navigate('<title>AuditSiteStart</title><h1>Audit Site Start</h1>');
    const auditSiteDefaults = {
      strategy: 'provided',
      maxPages: 1,
      maxDepth: 0,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: ['logout|signout'],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2a', 'wcag2aa'],
      maxNodesPerViolation: 5,
      waitAfterNavigationMs: 50,
    };
    const result = await callTool('audit_site', {
      ...auditSiteDefaults,
      urls: [`${state.fixtureOrigin}/audit-site`],
    });
    assertText(result, /JSON report:|scanned/i);

    // Link discovery must not hang off the scan succeeding: the gate page fails
    // its scoped scan, and the child is reachable only through it.
    const throughErroredPage = await callTool('audit_site', {
      strategy: 'links',
      startUrl: `${state.fixtureOrigin}/audit-gate`,
      maxPages: 5,
      maxDepth: 1,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: [],
      ignoreQueryParams: [],
      violationsTag: ['wcag2a', 'wcag2aa'],
      includeIncomplete: false,
      maxNodesPerViolation: 5,
      waitAfterNavigationMs: 50,
      includeSelectors: ['#only-on-child'],
    });
    assertText(throughErroredPage, /Errored pages: 1/);
    assertText(throughErroredPage, /Scanned pages: 1/);
    assertText(throughErroredPage, /audit-gate-child/);

    // Signing in interactively must carry over to the crawl tab, which shares
    // the browser context, and losing that session mid-crawl must be reported.
    await callTool('browser_navigate', { url: `${state.fixtureOrigin}/login` });
    const authed = await callTool('audit_site', {
      ...auditSiteDefaults,
      urls: [`${state.fixtureOrigin}/secure`],
    });
    const authedTitle = authed.structuredContent?.topPages?.[0]?.title;
    if (authedTitle !== 'Members Area')
      throw new Error(`Expected audit_site to scan authenticated content, got title ${JSON.stringify(authedTitle)}`);

    const lost = await callTool('audit_site', {
      ...auditSiteDefaults,
      maxPages: 3,
      urls: [
        `${state.fixtureOrigin}/secure`,
        `${state.fixtureOrigin}/account/close`,
        `${state.fixtureOrigin}/secure-2`,
      ],
    });
    assertText(lost, /WARNING: cookie\(s\) mcp_session present when the crawl started disappeared/);
    if (lost.structuredContent?.sessionLosses?.[0]?.url !== `${state.fixtureOrigin}/account/close`)
      throw new Error(`Expected a session loss at /account/close, got ${JSON.stringify(lost.structuredContent?.sessionLosses)}`);

    // A redirecting logout must be reported at the page reached, not requested.
    await callTool('browser_navigate', { url: `${state.fixtureOrigin}/login` });
    const redirected = await callTool('audit_site', {
      ...auditSiteDefaults,
      maxPages: 2,
      urls: [
        `${state.fixtureOrigin}/secure`,
        `${state.fixtureOrigin}/goodbye`,
      ],
    });
    if (redirected.structuredContent?.sessionLosses?.[0]?.url !== `${state.fixtureOrigin}/signed-out`)
      throw new Error(`Expected a session loss at /signed-out, got ${JSON.stringify(redirected.structuredContent?.sessionLosses)}`);

    // A logout URL that clears the cookie and then fails to load still ended the
    // session: the warning must name it, not the next page that happened to load.
    await callTool('browser_navigate', { url: `${state.fixtureOrigin}/login` });
    const failed = await callTool('audit_site', {
      ...auditSiteDefaults,
      maxPages: 3,
      urls: [
        `${state.fixtureOrigin}/secure`,
        `${state.fixtureOrigin}/session/revoke`,
        `${state.fixtureOrigin}/secure-2`,
      ],
    });
    if (failed.structuredContent?.sessionLosses?.[0]?.url !== `${state.fixtureOrigin}/session/revoke`)
      throw new Error(`Expected a session loss at /session/revoke, got ${JSON.stringify(failed.structuredContent?.sessionLosses)}`);
    // Only /secure loads: /session/revoke throws, and Chromium's error page for it
    // interrupts /secure-2. Nothing after /secure is scanned, so a check that only
    // ran on successful navigations would have reported no session loss at all.
    assertText(failed, /Scanned pages: 1/);

    // Rule ids are run-wide input, so a bad one must be rejected before the
    // crawl starts. Otherwise every supplied URL is visited, errored, and
    // written up as a completed audit.
    const requestsBeforeBadRule = state.fixtureRequests.length;
    await assertToolError(
        'audit_site',
        {
          ...auditSiteDefaults,
          maxPages: 3,
          urls: [
            `${state.fixtureOrigin}/audit-site`,
            `${state.fixtureOrigin}/secure`,
            `${state.fixtureOrigin}/secure-2`,
          ],
          withRules: ['image-altt'],
        },
        /Unknown Axe rule id\(s\) in withRules: image-altt/);
    const visitedAfterBadRule = state.fixtureRequests.slice(requestsBeforeBadRule);
    if (visitedAfterBadRule.length)
      throw new Error(`audit_site visited ${visitedAfterBadRule.length} page(s) before rejecting an invalid rule id: ${visitedAfterBadRule.join(', ')}`);
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
    // Fixture mixes real SC 2.5.8 / SC 2.4.11 failures with targets that a naive
    // check would flag but that the exceptions legitimately allow.
    await navigate([
      '<title>Keyboard</title>',
      '<style>',
      'a, button { position: absolute; background: #06c; color: #fff; }',
      '#skip { top: 0; left: 0; }',
      '#tiny-a { top: 40px; left: 0; display: block; width: 16px; height: 16px; }',
      '#tiny-b { top: 40px; left: 20px; display: block; width: 16px; height: 16px; }',
      '#compliant { top: 100px; left: 0; width: 24px; height: 24px; padding: 0; border: 0; }',
      '#buried { top: 200px; left: 0; display: block; width: 60px; height: 30px; }',
      '#cookie-bar { position: fixed; top: 190px; left: 0; width: 100%; height: 60px; background: #222; z-index: 10; }',
      '#sentence { position: absolute; top: 300px; left: 0; width: 380px; }',
      '#terms { position: static; }',
      '#inline-block-sentence { position: absolute; top: 340px; left: 0; width: 380px; }',
      '#ib-terms, #ib-next { position: static; display: inline-block; width: 12px; height: 18px; }',
      '#isolated { top: 400px; left: 0; display: block; width: 18px; height: 18px; }',
      '#disabled-neighbor { top: 400px; left: 18px; width: 40px; height: 30px; }',
      '#covered { top: 400px; left: 300px; width: 40px; height: 30px; }',
      // Transparent but clickable: intercepts hit testing without hiding anything.
      '#glass { position: fixed; top: 395px; left: 290px; width: 200px; height: 40px; z-index: 30; }',
      '#editable { position: absolute; top: 460px; left: 0; width: 200px; height: 40px; }',
      '#panel { position: fixed; top: 450px; left: 0; width: 100%; height: 60px; background: #333; z-index: 20; }',
      // Right column: a crowded contenteditable, an inline link behind a <strong>
      // wrapper, an undersized strip neighbour, an invisible click-catcher and a
      // clipping ancestor, each next to the conforming variant of the same shape.
      '#tiny-edit { position: absolute; top: 20px; left: 450px; width: 12px; height: 12px; }',
      '#edit-neighbor { top: 20px; left: 464px; width: 40px; height: 30px; }',
      '#wrapped-sentence { position: absolute; top: 70px; left: 450px; width: 330px; }',
      '#bare-wrap { position: absolute; top: 110px; left: 450px; }',
      '#w-terms, #w-next, #w-bare, #w-bare2 { position: static; display: inline-block; width: 12px; height: 18px; }',
      '#short { top: 150px; left: 450px; display: block; width: 10px; height: 10px; }',
      '#long { top: 150px; left: 462px; display: block; width: 100px; height: 10px; }',
      '#veiled { top: 260px; left: 450px; width: 40px; height: 30px; }',
      '#ghost { position: fixed; top: 255px; left: 440px; width: 200px; height: 40px; opacity: 0; z-index: 30; }',
      '#ghost-inner { width: 100%; height: 100%; background: #000; }',
      '#short-clear { top: 310px; left: 450px; display: block; width: 10px; height: 10px; }',
      '#long-clear { top: 310px; left: 480px; display: block; width: 100px; height: 10px; }',
      '#clipper { position: absolute; top: 350px; left: 450px; width: 10px; height: 10px; overflow: hidden; }',
      '#roomy-clipper { position: absolute; top: 350px; left: 600px; width: 60px; height: 60px; overflow: hidden; }',
      '#clipped, #roomy { position: static; width: 40px; height: 40px; }',
      '</style>',
      '<a href="#main" id="skip">Skip to main</a>',
      '<main id="main">',
      '<a href="#a" id="tiny-a" aria-label="Tiny A">a</a>',
      '<a href="#b" id="tiny-b" aria-label="Tiny B">b</a>',
      '<button id="compliant" aria-label="Compliant control">C</button>',
      '<a href="#c" id="buried" aria-label="Buried link">Buried</a>',
      '<p id="sentence">Please read the <a href="#terms" id="terms" aria-label="Inline terms">terms</a> before continuing.</p>',
      '<p id="inline-block-sentence">Please read the <a href="#p" id="ib-terms" aria-label="Inline block terms">p</a> <a href="#h" id="ib-next" aria-label="Inline block help">h</a> notes before continuing.</p>',
      '<a href="#d" id="isolated" aria-label="Isolated link">i</a>',
      '<button id="disabled-neighbor" aria-label="Disabled neighbor" disabled>D</button>',
      '<button id="covered" aria-label="Covered control">X</button>',
      '<div id="editable" contenteditable="true">Editable region</div>',
      '<div id="tiny-edit" contenteditable="true" aria-label="Tiny editor">e</div>',
      '<button id="edit-neighbor" aria-label="Editor neighbor">N</button>',
      '<p id="wrapped-sentence">Read <strong><a href="#wt" id="w-terms" aria-label="Wrapped terms">t</a></strong><a href="#wn" id="w-next" aria-label="Wrapped next">h</a> now</p>',
      '<div id="bare-wrap"><strong><a href="#wb" id="w-bare" aria-label="Bare wrapped">b</a></strong><a href="#wb2" id="w-bare2" aria-label="Bare wrapped next">c</a></div>',
      '<a href="#s" id="short" aria-label="Short target">s</a>',
      '<a href="#l" id="long" aria-label="Long strip">l</a>',
      '<button id="veiled" aria-label="Veiled control">V</button>',
      '<a href="#sc" id="short-clear" aria-label="Short clear">s</a>',
      '<a href="#lc" id="long-clear" aria-label="Long clear">l</a>',
      '<div id="clipper"><button id="clipped" aria-label="Clipped control">K</button></div>',
      '<div id="roomy-clipper"><button id="roomy" aria-label="Roomy control">R</button></div>',
      '</main>',
      '<div id="cookie-bar">Cookie bar</div>',
      '<div id="glass"></div>',
      // Fully transparent wrapper around an opaque child: hit tested, paints nothing.
      '<div id="ghost"><div id="ghost-inner"></div></div>',
      '<div id="panel">Sticky panel</div>',
    ].join(''));
    // Fixed size so earlier resize/matrix tests cannot make the page scroll under the
    // fixed overlays this fixture relies on.
    await callTool('browser_resize', { width: 800, height: 600 });
    const result = await callTool('audit_keyboard', {
      maxTabs: 24,
      includeShiftTab: false,
      stopOnCycle: true,
      cycleWindow: 4,
      checkSkipLink: true,
      skipLinkMaxTabs: 3,
      activateSkipLink: false,
      checkFocusTrap: true,
      checkFocusVisibility: true,
      checkFocusJumps: true,
      checkTargetSize: true,
      checkFocusObscured: true,
      jumpScrollThresholdPx: 600,
      screenshotOnIssue: false,
      maxIssueScreenshots: 2,
    });
    assertText(result, /JSON report:|Skip link|summary/i);
    assertText(result, /Tiny A is 16x16 CSS px/);
    assertText(result, /Tiny B is 16x16 CSS px/);
    assertText(result, /Buried link hidden behind div#cookie-bar/);
    // A focusable non-pointer-target under an opaque sticky bar is still a SC 2.4.11 fail.
    assertText(result, /Editable region hidden behind div#panel/);
    // A check that flags compliant controls is worse than no check: the 24x24 button,
    // the inline link inside a sentence, and the isolated skip link must all stay clean.
    assertNoText(result, /Compliant control (is \d+x\d+|hidden behind)/);
    assertNoText(result, /Inline terms (is \d+x\d+|hidden behind)/);
    assertNoText(result, /Skip to main (is \d+x\d+|hidden behind)/);
    // Inline-block links in a sentence keep the SC 2.5.8 inline exception, a disabled
    // control is not a spacing neighbor, and a transparent click-catcher hides nothing.
    assertNoText(result, /Inline block (terms|help) (is \d+x\d+|hidden behind)/);
    assertNoText(result, /Isolated link (is \d+x\d+|hidden behind)/);
    assertNoText(result, /Covered control (is \d+x\d+|hidden behind)/);
    // A crowded contenteditable is a pointer target; a roomy one stays clean.
    assertText(result, /Tiny editor is 12x12 CSS px/);
    assertNoText(result, /Editable region is \d+x\d+/);
    // An undersized neighbour is tested by its box too, not only by its circle.
    assertText(result, /Short target is 10x10 CSS px/);
    assertNoText(result, /Short clear is \d+x\d+/);
    assertNoText(result, /Long (strip|clear) is \d+x\d+/);
    // The sentence exception survives inline wrappers, but only where there is
    // running text: the same markup without it is still a failure.
    assertNoText(result, /Wrapped (terms|next) is \d+x\d+/);
    assertText(result, /Bare wrapped is 12x18 CSS px/);
    assertText(result, /Bare wrapped next is 12x18 CSS px/);
    // An opaque child inside an opacity: 0 wrapper renders nothing, so it covers nothing.
    assertNoText(result, /Veiled control hidden behind/);
    // Documented ceiling: target size is the layout box, so a 40x40 control that an
    // overflow ancestor clips to 10x10 is not reported.
    assertNoText(result, /(Clipped|Roomy) control is \d+x\d+/);
    const summary = result.structuredContent?.summary ?? {};
    if (summary.targetSizeIssueCount !== 6 || summary.focusObscuredIssueCount !== 2) {
      throw new Error(`Expected 6 target-size and 2 obscured findings, got ${JSON.stringify(summary)}`);
    }
  }),

  test('audit_screen_reader', async () => {
    await navigate([
      '<title>ScreenReader</title><main>',
      // Broken markup: one instance per check.
      '<p><a href="/pricing">Read more</a></p>',
      '<p><img src="/IMG_2048.jpg" alt="IMG_2048.jpg"></p>',
      '<p><button aria-label="Submit form">Send</button></p>',
      '<p><input type="text"></p>',
      '<p><a href="/a.pdf">Download</a> <a href="/b.pdf">Download</a></p>',
      '<div style="display:flex;flex-direction:row-reverse">',
      '<button>Reversed first</button><button>Reversed second</button></div>',
      // Correct markup: none of these may be flagged.
      '<p><a href="/pricing-detail">Read more about pricing</a></p>',
      '<p><img src="/team.jpg" alt="The team at the 2024 offsite"></p>',
      '<p><button aria-label="Search products">Search</button></p>',
      '<p><label>Email address <input type="email"></label></p>',
      '<p><a href="/help">Help centre</a> <a href="/help">Help centre</a></p>',
      '<div style="display:flex"><button>Ordered first</button><button>Ordered second</button></div>',
      '<div style="columns:2;width:300px"><p>Column one top</p><p>Column one bottom</p>',
      '<p>Column two top</p><p>Column two bottom</p></div>',
      '</main>',
    ].join(''));
    const result = await callTool('audit_screen_reader', {
      checkNames: true,
      checkReadingOrder: true,
      maxElements: 200,
      maxFindingsPerCheck: 10,
    });
    const text = resultText(result);
    const expected = [
      /missing-accessible-name \| [1-9]/,
      /uninformative-accessible-name \| [1-9]/,
      /filename-as-accessible-name \| [1-9]/,
      /label-in-name-mismatch \| [1-9]/,
      /duplicate-accessible-name \| [1-9]/,
      /reading-order-mismatch \| [1-9]/,
    ];
    for (const pattern of expected)
      assertText(text, pattern);
    assertText(text, /JSON report:/);
    const clean = ['Read more about pricing', 'The team at the 2024 offsite', 'Search products',
      'Email address', 'Help centre', 'Ordered first', 'Column one top'];
    for (const label of clean) {
      if (text.includes(label))
        throw new Error(`Correct markup was flagged: ${label}\n${text.slice(0, 4000)}`);
    }
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

function assertNoText(result, pattern) {
  const text = typeof result === 'string' ? result : resultText(result);
  if (pattern.test(text))
    throw new Error(`Did not expect ${pattern} in result:\n${text.slice(0, 4000)}`);
}

// Counts nodes reported for one axe rule in a scan_page result. Each rule block
// is `Violation rule: <id> ...` down to its `Violations...: [...]` JSON array.
function assertViolationNodeCount(result, ruleId, expected) {
  const text = resultText(result);
  const blocks = [...text.matchAll(new RegExp(`Violation rule: ${ruleId} [\\s\\S]*?Violations[^:]*: (\\[[\\s\\S]*?\\n\\])`, 'g'))];
  // A zero expectation must mean "the rule is absent", not "the format changed":
  // require the report itself to be well formed before trusting an empty count.
  // The incomplete count is omitted entirely when includeIncomplete is false.
  if (!blocks.length && !/^Violations: \d+, (Incomplete: \d+, )?Passes: \d+/m.test(text))
    throw new Error(`scan_page output is not in the expected format:\n${text.slice(0, 2000)}`);
  const count = blocks.reduce((total, [, json]) => total + JSON.parse(json).length, 0);
  if (count !== expected)
    throw new Error(`Expected ${expected} ${ruleId} node(s), got ${count} in:\n${text.slice(0, 2000)}`);
}

async function assertToolError(name, args, pattern) {
  let text = '';
  try {
    text = resultText(await callTool(name, args));
  } catch (error) {
    if (pattern.test(error.message))
      return;
    throw new Error(`Expected ${name} to fail matching ${pattern}, got:\n${error.message}`);
  }
  throw new Error(`Expected ${name} to fail matching ${pattern}, but it succeeded:\n${text.slice(0, 2000)}`);
}

function refFor(snapshotText, label) {
  const lines = snapshotText.split('\n');
  const line = lines.find(candidate => candidate.includes(label) && candidate.includes('[ref='));
  const match = line?.match(/\[ref=([^\]]+)\]/);
  if (!match)
    throw new Error(`Could not find ref for ${label} in snapshot:\n${snapshotText.slice(0, 4000)}`);
  return match[1];
}

// Picks the number browser_network_requests printed for the first request whose
// line matches, so browser_network_request can be called with a real index.
function indexFor(listText, pattern) {
  const line = listText.split('\n').find(candidate => /^\[\d+\] /.test(candidate) && pattern.test(candidate));
  const match = line?.match(/^\[(\d+)\]/);
  if (!match)
    throw new Error(`Could not find a request matching ${pattern} in listing:\n${listText.slice(0, 4000)}`);
  return Number(match[1]);
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
    state.fixtureRequests.push(request.url);
    if (request.url === '/audit-site') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>AuditSite</title></head><body><img src="x"><h1>Audit Site</h1></body></html>');
      return;
    }
    // Gate page links to a child but lacks #only-on-child, so a scoped audit
    // errors on the gate. The child must still be crawled through it.
    if (request.url === '/audit-gate') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Gate</title></head><body><a href="/audit-gate-child">Child</a></body></html>');
      return;
    }
    if (request.url === '/audit-gate-child') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>GateChild</title></head><body><div id="only-on-child"><img src="x"></div></body></html>');
      return;
    }
    // Cookie-gated fixture: /login mints the session, /secure serves real
    // content only while it is present, /account/close destroys it.
    if (request.url === '/login') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'mcp_session=granted; Path=/',
      });
      response.end('<!doctype html><html><head><title>Login</title></head><body><h1>Signed In</h1></body></html>');
      return;
    }
    if (request.url === '/secure' || request.url === '/secure-2') {
      const signedIn = (request.headers.cookie ?? '').includes('mcp_session=granted');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(signedIn
        ? '<!doctype html><html><head><title>Members Area</title></head><body><img src="x"><h1>Members Only Content</h1></body></html>'
        : '<!doctype html><html><head><title>Login Required</title></head><body><h1>Please sign in</h1></body></html>');
      return;
    }
    if (request.url === '/account/close') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'mcp_session=; Path=/; Max-Age=0',
      });
      response.end('<!doctype html><html><head><title>Account Closed</title></head><body><h1>Account Closed</h1></body></html>');
      return;
    }
    // /goodbye clears the session and redirects, so the page that actually lost
    // the cookie is /signed-out rather than the URL the crawl asked for.
    if (request.url === '/goodbye') {
      response.writeHead(302, {
        'set-cookie': 'mcp_session=; Path=/; Max-Age=0',
        'location': '/signed-out',
      });
      response.end();
      return;
    }
    // /session/revoke clears the session and then redirects somewhere that refuses
    // the connection, so the navigation throws and no page is ever reached. The
    // session is gone all the same, and this URL is the one that ended it.
    if (request.url === '/session/revoke') {
      response.writeHead(302, {
        'set-cookie': 'mcp_session=; Path=/; Max-Age=0',
        'location': `http://127.0.0.1:${state.deadPort}/gone`,
      });
      response.end();
      return;
    }
    if (request.url === '/signed-out') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Signed Out</title></head><body><h1>Signed Out</h1></body></html>');
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
    if (request.url === '/network-png') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Network PNG</title></head><body><img src="/network-png.png" alt="pixel"></body></html>');
      return;
    }
    if (request.url === '/network-png.png') {
      response.writeHead(200, { 'content-type': 'image/png' });
      // A 1x1 transparent PNG: real binary bytes, so the tool must not try to
      // render it as text.
      response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
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
      // A port nothing listens on, for /session/revoke to redirect into. Bound and
      // released so it is free and safe, unlike the low ports Chromium blocks
      // outright — a blocked port fails the navigation after it commits, which
      // interrupts the next one.
      const deadServer = http.createServer();
      deadServer.listen(0, '127.0.0.1', () => {
        state.deadPort = deadServer.address().port;
        deadServer.close(() => resolve(() => new Promise(resolveClose => server.close(resolveClose))));
      });
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
