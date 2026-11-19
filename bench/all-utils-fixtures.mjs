import assert from 'node:assert/strict';

const snapshot = Array.from({ length: 140 }, (_, i) => `  - paragraph "Item ${i}" [ref=e${i}]`).join('\n');
const html = '<input type="text" role="combobox" name="search">';
const raw = 'data:image/svg+xml,<svg>ok</svg>';
const encoded = 'data%3Aimage%2Fsvg%2Bxml%2C%3csvg%3e';
const code = '(value = /[(]/) => `name ${value}`';
const label = { name: 'Search', active: true, nested: ['first', 'second'] };
const urls = Array.from({ length: 100 }, (_, i) => `https://local.test/docs/s${i % 8}/p${i}?lang=en`);
const message = { toString: () => raw + ' after message' };
const error = new Error('fixture error');

export function fixtures(modules, { tab, endpoint, output, importMetadata }) {
  const rows = new Map();
  function add(module, name, run, options = {}) {
    rows.set(module + '/' + name, { run, ...options });
  }
  function cases(module, inputs) {
    for (const [name, args] of Object.entries(inputs)) {
      if (modules[module][name])
        add(module, name, () => modules[module][name](...args));
    }
  }

  const aria = modules.ariaCompression;
  const line = '  - gridcell "Item 123" [ref=e2]';
  cases('ariaCompression', {
    compressAriaSnapshot: [snapshot], signature: [line], roleOf: [line], shouldKeepLine: ['gridcell', true, false],
    shouldKeepSubtree: ['button'], shouldKeepRefProtectedDescendants: ['gridcell', true],
    shouldKeepCursorPointerRef: [true, true], isRowContainerRole: ['grid'], indentOf: [line],
    compressionKey: [aria.parseSnapshotLines(line)[0]], isProtectedLine: [aria.parseSnapshotLines(line)[0]],
  });
  add('ariaCompression', 'parseSnapshotLines', () => aria.parseSnapshotLines(snapshot), {
    project: lines => lines.map(({ text, indent, parentIndex }) => [text, indent, parentIndex]),
  });

  cases('codegen', { escapeWithQuotes: ['Send "now"', '"'], quote: ["cart's item"], formatObject: [label], formatObjectOrVoid: [label] });
  cases('errors', { errorMessage: [error] });
  cases('httpUrl', { isHttpUrl: [new URL('https://local.test/a')] });
  cases('fileUtils', { sanitizeForFilePath: ['unsafe / report?.txt'], truncateToUtf8Bytes: ['é🚀'.repeat(4096), 2000],
    truncateWithMarker: ['error 🚀 '.repeat(400), 2000], copyPrefix: ['abc🚀'], utf8Width: ['🚀'] });
  add('fileUtils', 'safeIsoTimestampForFileName', () => modules.fileUtils.safeIsoTimestampForFileName(), {
    project: result => assert.match(result, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{8}$/),
  });
  for (const [name, length] of [['createGuid', 32], ['createShortGuid', 8]])
    add('guid', name, () => modules.guid[name](), { project: result => assert.match(result, new RegExp(`^[a-f0-9]{${length}}$`)) });
  cases('guid', { createHash: ['a11y scan fingerprint'] });

  const d = modules.dataUrl;
  const match = d.parseDataUrl(raw, 0);
  cases('dataUrl', {
    truncateDataUrl: [encoded], truncateDataUrls: [raw + ' after message'], findDataUrlStart: ['ordinary prefix ' + raw, 0],
    dataUrlPrefixLengthAt: [encoded, 0], parseDataUrl: [encoded, 0], findDataUrlDelimiter: [encoded, 7],
    dataUrlDisplayPrefix: [raw, 0, { start: 18, end: 19 }, { raw: 'image/svg+xml', decoded: 'image/svg+xml', isEncoded: false }],
    compactDataUrlMetadata: ['image/png;name=file;base64'], encodeDataUrlMetadata: ['image/svg+xml', true],
    isValidDataUrlMetadata: ['image%2Fsvg%2Bxml', d.isEncodedPayloadTerminator ? true : 'image/svg+xml'],
    decodeDataUrlMetadata: ['image%2Fsvg%2Bxml', true], findDataUrlEnd: [raw + ' trailing', match],
    dataUrlQuoteAt: ['"' + raw, 1], isLineBreak: ['\n'], isWhitespace: ['\t'],
    isQueryParamBoundary: [raw + '&page=1', match, raw.length],
    isRawPayloadCompleteBefore: [raw, match.payloadStart, raw.length],
    isRawPayloadSuffixBoundary: [raw + ' ', match, raw.length, true],
    isQuotedDataUrlEnd: [raw + '"', match, raw.length], isRawMarkupPayload: [raw, match.payloadStart],
    looksLikeSourceLocationSuffix: ['file:123', 4], looksLikeQueryParam: ['page=2', 0], containsPercentEncoding: [encoded],
    isDataUrlStartBoundary: ['%20' + encoded, 3], isRawPayloadWrapperBoundary: [raw + ')', match, raw.length],
    isRawPayloadBoundarySuffix: ['&page=1', 0], isEncodedPayloadTerminator: ['%29', 0],
    percentEncodedCharBefore: ['%3c', 3], percentEncodedCharAt: ['%3c', 0], startsWithIgnoreCase: ['DATA%3A', 0, 'data%3a'],
  });
  add('dataUrl', 'formatConsoleMessage', msg => d.formatConsoleMessage(msg), { prepare: () => ({ ...message }) });
  d.formatConsoleMessage(message);
  add('dataUrl', 'formatConsoleMessage (cached)', () => d.formatConsoleMessage(message));

  cases('jsSource', { isFunctionSource: [code], skipAsyncKeyword: ['async /* comment */ value'], matchingDelimiter: [code, 0, '(', ')'],
    endOfString: ['`item ${x}`', 0], startsRegex: [code, code.indexOf('/')], endOfRegex: ['/a[bc]+/g', 0],
    skipTrivia: [' /* comment */ // more\n  function', 0], hasArrowHead: [code], matchingParen: [code, 0],
    stripEnclosingParens: ['(value)'] });

  const h = modules.htmlPatterns;
  const tokens = h.htmlTokens(html);
  const other = tokens.with(-1, '"other"');
  cases('htmlPatterns', { htmlTokens: [html], similar: [tokens, other], withinEditDistance: [tokens, other, 3],
    byKey: [{ key: 'a' }, { key: 'b' }], semanticSignature: [html] });
  add('htmlPatterns', 'rootAttributes', () => h.rootAttributes(html, 6), {
    project: attrs => attrs instanceof Map ? [attrs.get('type'), attrs.get('role')] : [attrs.type, attrs.role],
  });
  const group = () => new h.HtmlPatternGroups(4, 8);
  const populated = () => {
    const result = group();
    for (let i = 0; i < 12; i++)
      result.add(`<input type="text" value="${i}">`, i);
    return result;
  };
  add('htmlPatterns', 'HtmlPatternGroups.constructor', group, { project: g => g.summarize(2) });
  add('htmlPatterns', 'HtmlPatternGroups.add', g => g.add(html, 42), { prepare: group, project: (_, g) => g.summarize(2) });
  add('htmlPatterns', 'HtmlPatternGroups._prune', g => g._prune(), { prepare: populated, project: (_, g) => g.summarize(2), limit: 16 });
  add('htmlPatterns', 'HtmlPatternGroups.summarize', g => g.summarize(3), { prepare: populated, limit: 16 });

  const r = modules.representativeUrls;
  const tree = r.newNode(0);
  for (const [index, key] of ['a', 'a', 'b', 'c', 'd'].entries()) {
    const child = tree.children.get(key) ?? r.newNode(1);
    child.terminal.push(index);
    child.size++;
    tree.size++;
    tree.children.set(key, child);
  }
  r.solve(tree, 3);
  const parts = r.parts(tree);
  cases('representativeUrls', { templateSegments: [urls[0]], newNode: [1], parts: [tree], branchCount: [tree],
    coveredCount: [parts[1]], partCost: [parts[0], 1, 1], mergePart: [[0, 0], parts[1], 0, 3, 1],
    mergeParts: [tree, parts, 3, false], selectRepresentativeUrls: [urls, 12] });
  // Private DP storage differs across builds. Validate the allocation and selected URL indices.
  add('representativeUrls', 'parts', () => r.parts(tree), { project: list => list.map(p => [p.kind, p.size]) });
  function collect(t) {
    const out = [];
    if (r.collect.length === 4)
      r.collect(t, 3, 3, out);
    else
      r.collect(t, 3, out);
    return out;
  }
  add('representativeUrls', 'solve', t => r.solve(t, 3), { prepare: () => structuredClone(tree), project: (_, t) => collect(t), limit: 32 });
  add('representativeUrls', 'collect', () => collect(tree));

  const redactor = modules.urlRedaction.createUrlRedactor(['token']);
  const result = { content: [{ type: 'text', text: '?token=secret' }], structuredContent: { link: '/a?token=secret' } };
  add('urlRedaction', 'createUrlRedactor', () => modules.urlRedaction.createUrlRedactor(['token']), { project: redact => redact('?token=secret') });
  cases('urlRedaction', { redactToolResult: [result, redactor] });
  cases('log', { logUnhandledError: [error], testDebug: ['test debug message'] });
  for (const name of ['printToStdout', 'printToStderr'])
    add('terminal', name, () => modules.terminal[name]('scan complete'), { project: () => output.last });
  add('package', 'packageJSON (fresh module import)', importMetadata, { async: true, limit: 1, project: mod => mod.packageJSON.name });

  const resolved = Promise.resolve(42);
  const signal = new AbortController().signal;
  const t = modules.timeout;
  add('timeout', 'settleWithin', () => t.settleWithin(resolved, 10), { async: true });
  add('timeout', 'rejectAfterTimeout', () => t.rejectAfterTimeout(resolved, 10, 'timeout'), { async: true });
  add('timeout', 'rejectOnAbort', () => t.rejectOnAbort(() => resolved, signal), { async: true });

  const cdp = modules.cdpConnection;
  cases('cdpConnection', { isCdpMessage: [{ id: 1 }], filterAutoAttach: [{ method: 'Target.setAutoAttach', params: { autoAttach: true } }] });
  add('cdpConnection', 'websocketEndpoint', () => cdp.websocketEndpoint(endpoint, {}, signal), {
    async: true, limit: 1, project: addr => assert.match(addr, /^ws:\/\//),
  });
  add('cdpConnection', 'connectOverCDP', () => cdp.connectOverCDP(endpoint), {
    async: true, limit: 1, project: b => b.contexts().length, cleanup: b => b.close(),
  });

  const u = modules['tools/utils'];
  const activity = () => new u.PageActivity(tab);
  const activityOpts = { prepare: activity, cleanup: (_, a) => a.dispose(), limit: 1 };
  add('tools/utils', 'PageActivity.constructor', activity, { project: a => a._inFlightRequests.size, cleanup: a => a.dispose(), limit: 1 });
  add('tools/utils', 'PageActivity.waitUntilIdle', a => a.waitUntilIdle(0), { ...activityOpts, async: true });
  add('tools/utils', 'PageActivity.dispose', a => a.dispose(), { prepare: activity, limit: 1 });
  const request = { url: () => 'https://local.test/' };
  add('tools/utils', 'PageActivity._onRequest', a => a._onRequest(request), { ...activityOpts, project: (_, a) => a._inFlightRequests.size });
  add('tools/utils', 'PageActivity._onRequestSettled', a => a._onRequestSettled(request), {
    ...activityOpts, prepare: () => { const a = activity(); a._onRequest(request); return a; }, project: (_, a) => a._inFlightRequests.size,
  });
  add('tools/utils', 'PageActivity._onFrameNavigated', a => a._onFrameNavigated(tab.page.mainFrame()), activityOpts);
  add('tools/utils', 'waitForDomOnlyWork', () => u.waitForDomOnlyWork(tab, 0), { async: true, limit: 1 });
  add('tools/utils', 'waitForCompletion', () => u.waitForCompletion(tab, () => resolved, 0), { async: true, limit: 1 });
  add('tools/utils', 'waitForCompletion (default 500 ms settle)', () => u.waitForCompletion({ ...tab, context: { config: { timeouts: {} } } }, () => resolved), { async: true, limit: 1 });
  add('tools/utils', 'generateLocator', () => u.generateLocator(tab.page.getByRole('button', { name: 'Save' })), { async: true, limit: 1 });
  add('tools/utils', 'callOnPageNoTrace', () => u.callOnPageNoTrace(tab.page, p => p.title()), { async: true, limit: 1 });
  return rows;
}
