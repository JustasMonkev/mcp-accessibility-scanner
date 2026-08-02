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

export const pages = new Map([
  ['/', heavyPage()],
  ['/heavy.html', heavyPage()],
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
