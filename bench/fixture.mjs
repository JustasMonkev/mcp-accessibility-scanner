/**
 * Deterministic pages served to the benchmarked MCP server.
 *
 * The markup is generated from a fixed seed so every run - and every revision
 * compared against another - scans exactly the same DOM.
 */

const seededRandom = seed => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

function heavyPage() {
  const random = seededRandom(42);
  const rows = [];
  for (let index = 0; index < 220; index++) {
    const label = `Item ${index}`;
    // A mix of named and unnamed controls so axe finds real violations and the
    // aria snapshot has interactive refs to click.
    const missingAlt = random() < 0.2;
    // Every fifth button is genuinely unnamed - no label, and an aria-hidden
    // glyph for its only content - so the scan really does report button-name.
    const unnamed = index % 5 === 0;
    rows.push([
      '<li class="row">',
      `<a href="/page-${index % 12}.html">${label} link</a>`,
      unnamed
        ? `<button id="btn-${index}"><span aria-hidden="true">&#9654;</span></button>`
        : `<button id="btn-${index}" aria-label="Action ${index}">Go ${index}</button>`,
      `<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" ${missingAlt ? '' : `alt="Thumb ${index}"`}>`,
      `<span class="muted" style="color:#bbb;background:#fff">Low contrast text ${index}</span>`,
      '</li>',
    ].join(''));
  }
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<title>Benchmark heavy page</title>',
    '<style>.row{display:flex;gap:4px;align-items:center}.muted{font-size:12px}',
    'button{min-width:12px;min-height:12px}img{width:16px;height:16px}</style>',
    '</head><body>',
    '<a href="#main" class="skip">Skip to main content</a>',
    '<header><nav><a href="/page-1.html">Home</a><a href="/page-2.html">Docs</a></nav></header>',
    '<main id="main"><h1>Benchmark heavy page</h1>',
    '<form><label>Search <input aria-label="Search" name="q"></label>',
    '<select aria-label="Sort"><option>Newest</option><option>Oldest</option></select>',
    '<button type="button" id="submit" aria-label="Submit search">Submit</button></form>',
    `<ul>${rows.join('')}</ul>`,
    '</main></body></html>',
  ].join('');
}

function smallPage(index) {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    `<title>Benchmark page ${index}</title></head><body>`,
    `<main><h1>Page ${index}</h1>`,
    `<p>Body copy for page ${index}.</p>`,
    `<a href="/page-${(index + 1) % 12}.html">Next page</a>`,
    `<a href="/page-${(index + 2) % 12}.html">Skip ahead</a>`,
    `<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">`,
    '<button><span aria-hidden="true">&#9654;</span></button>',
    '</main></body></html>',
  ].join('');
}

const pixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function screenReaderPage(count, prefix, ancestorDepth = 0) {
  const controls = Array.from({ length: count }, (_, index) => {
    const id = `${prefix}-${index}`;
    switch (index % 5) {
      case 0: return `<button id="${id}"></button>`;
      case 1: return `<a id="${id}" href="/target-${id}">More</a>`;
      case 2: return `<img id="${id}" src="${pixel}" alt="camera.jpeg">`;
      case 3: return `<button id="${id}"><span><span>Account ${id}</span></span></button>`;
      default: return `<a id="${id}" href="/target-${id}">Product ${id}</a>`;
    }
  });
  return '<!doctype html><html lang="en"><meta charset="utf-8"><title>Screen reader workload</title>'
    + `<style>${ancestorDepth ? 'button,a,img' : 'main>*'}{display:block;width:240px;height:24px;margin:0;border:0;padding:0}</style>`
    + `<body><main>${'<div role="presentation">'.repeat(ancestorDepth)}${controls.join('')}${'</div>'.repeat(ancestorDepth)}</main></body></html>`;
}

function screenReaderExpectation(groups, elements) {
  const selectors = {
    'missing-accessible-name': [],
    'uninformative-accessible-name': [],
    'filename-as-accessible-name': [],
    'label-in-name-mismatch': [],
    'duplicate-accessible-name': [],
    'reading-order-mismatch': [],
  };
  for (const { count, prefix } of groups) {
    for (let index = 0; index < count; index++) {
      if (index % 5 === 0)
        selectors['missing-accessible-name'].push(`button#${prefix}-${index}`);
      if (index % 5 === 1)
        selectors['uninformative-accessible-name'].push(`a#${prefix}-${index}`);
      if (index % 5 === 2)
        selectors['filename-as-accessible-name'].push(`img#${prefix}-${index}`);
    }
    selectors['duplicate-accessible-name'].push(`a#${prefix}-1`);
  }
  return { elements, selectors };
}

export const screenReaderCases = [{
  name: 'audit_screen_reader',
  path: '/page-0.html',
  args: {},
  options: { checkNames: true, checkReadingOrder: true, maxElements: 400, maxFindingsPerCheck: 20 },
  expected: {
    elements: 6,
    selectors: {
      'missing-accessible-name': ['button'],
      'uninformative-accessible-name': [],
      'filename-as-accessible-name': [],
      'label-in-name-mismatch': [],
      'duplicate-accessible-name': [],
      'reading-order-mismatch': [],
    },
  },
}, ...[400, 2000].flatMap(elements => [true, false].map(checkNames => ({
  name: `audit_screen_reader (${elements} elements, names ${checkNames ? 'on' : 'off'})`,
  path: `/screen-reader-${elements}.html`,
  options: { checkNames, checkReadingOrder: true, maxElements: elements, maxFindingsPerCheck: 20 },
  expected: screenReaderExpectation([{ count: elements - 1, prefix: `sr-${elements}` }], elements),
})))];

const frameGroups = Array.from({ length: 3 }, (_, index) => ({ count: 131, prefix: `sr-frame-${index}` }));
screenReaderCases.push({
  name: 'audit_screen_reader (400 elements, 30 ancestors, names off)',
  path: '/screen-reader-nested.html',
  options: { checkNames: false, checkReadingOrder: true, maxElements: 400, maxFindingsPerCheck: 20 },
  expected: screenReaderExpectation([{ count: 399, prefix: 'sr-nested' }], 400),
});
screenReaderCases.push({
  name: 'audit_screen_reader (400 elements, 3 frames, names on)',
  path: '/screen-reader-frames.html',
  options: { checkNames: true, checkReadingOrder: true, maxElements: 400, maxFindingsPerCheck: 20 },
  expected: screenReaderExpectation(frameGroups, 400),
});

export const pages = new Map([
  ['/', heavyPage()],
  ['/heavy.html', heavyPage()],
  ...[400, 2000].map(elements => [`/screen-reader-${elements}.html`, screenReaderPage(elements - 1, `sr-${elements}`)]),
  ['/screen-reader-nested.html', screenReaderPage(399, 'sr-nested', 30)],
  ['/screen-reader-frames.html', '<!doctype html><html lang="en"><title>Screen reader frames</title>'
    + '<style>iframe{display:block;width:800px;height:250px;border:0}</style><body><main>'
    + frameGroups.map(({ prefix }) => `<iframe title="${prefix}" src="/${prefix}.html"></iframe>`).join('')
    + '</main></body></html>'],
  ...frameGroups.map(({ count, prefix }) => [`/${prefix}.html`, screenReaderPage(count, prefix)]),
  ...Array.from({ length: 12 }, (_, index) => [`/page-${index}.html`, smallPage(index)]),
]);

/** A string with many embedded data URLs, for the string-processing micro benchmark. */
export function dataUrlHeavyText(repeat = 400) {
  const payload = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'.repeat(4);
  const lines = [];
  for (let index = 0; index < repeat; index++) {
    lines.push(`- img "Thumb ${index}" [ref=e${index}]:`);
    lines.push(`  - /url: data:image/gif;base64,${payload}`);
    lines.push(`- text: plain aria node ${index} with no url at all`);
    lines.push(`- link "Item ${index}" [ref=e${index}b]:`);
    lines.push(`  - /url: https://example.com/page-${index}`);
  }
  return lines.join('\n');
}

/** A large aria snapshot with no data URLs at all - the common case. */
export function plainSnapshotText(repeat = 2000) {
  const lines = [];
  for (let index = 0; index < repeat; index++) {
    lines.push(`- listitem [ref=e${index}]:`);
    lines.push(`  - link "Item ${index} link" [ref=e${index}a]: /page-${index % 12}.html`);
    lines.push(`  - button "Action ${index}" [ref=e${index}b]`);
    lines.push(`  - text: Low contrast text ${index}`);
  }
  return lines.join('\n');
}
