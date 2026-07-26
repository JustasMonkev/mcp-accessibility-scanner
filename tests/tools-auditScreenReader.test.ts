import fs from 'fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import auditScreenReaderTools, {
  analyzeScreenReader,
  collectElementFacts,
  parseAriaSnapshot,
  type ElementFacts,
  type Rect,
  type ScreenReaderCheck,
  type ScreenReaderNode,
} from '../src/tools/auditScreenReader.js';
import { Response } from '../src/response.js';

function node(overrides: Partial<ScreenReaderNode>): ScreenReaderNode {
  return {
    role: 'generic',
    name: null,
    level: null,
    ref: 'e1',
    depth: 0,
    parent: null,
    tagName: 'div',
    selector: 'div',
    visibleText: null,
    href: null,
    rect: null,
    direction: 'ltr',
    positionFixed: false,
    floating: false,
    ariaHidden: false,
    childCount: 0,
    ...overrides,
  };
}

function rect(x: number, y: number, width = 100, height = 20): Rect {
  return { x, y, width, height };
}

function analyze(nodes: ScreenReaderNode[], maxFindingsPerCheck = 20) {
  return analyzeScreenReader(nodes, { checkNames: true, checkReadingOrder: true, maxFindingsPerCheck });
}

function checks(nodes: ScreenReaderNode[]): ScreenReaderCheck[] {
  return analyze(nodes).findings.map(finding => finding.check);
}

describe('parseAriaSnapshot', () => {
  it('parses roles, names, refs, levels and parent links', () => {
    const nodes = parseAriaSnapshot([
      '- generic [active] [ref=e1]:',
      '  - link "click here" [ref=e2] [cursor=pointer]:',
      '    - /url: /a',
      '  - heading "Title" [level=2] [ref=e3]',
      '  - button "Say \\"hi\\" now" [ref=e4]: Hi',
      '  - text: loose text',
    ].join('\n'));

    expect(nodes.map(entry => entry.role)).toEqual(['generic', 'link', 'heading', 'button', 'text']);
    expect(nodes[1]).toMatchObject({ name: 'click here', ref: 'e2', parent: 0 });
    expect(nodes[2]).toMatchObject({ level: 2, ref: 'e3', parent: 0 });
    expect(nodes[3].name).toBe('Say "hi" now');
    expect(nodes[4].ref).toBeNull();
  });

  it('parses keys Playwright YAML-quotes because of the accessible name', () => {
    // Verified against Playwright 1.61.1: yamlEscapeKeyIfNeeded single-quotes the
    // whole key (role, name, ref) for ": ", " #", braces and backticks.
    const nodes = parseAriaSnapshot([
      '- generic [active] [ref=e1]:',
      '  - \'button "Warning: Delete" [ref=e2]\'',
      '  - \'link "Item #1" [ref=e3] [cursor=pointer]\':',
      '    - /url: /a',
      '  - \'button "It\'\'s {here}" [ref=e4]\': Go',
      '  - \'menu "Files:" [ref=e5]\':',
      '    - menuitem "Open" [ref=e6]',
    ].join('\n'));

    expect(nodes.map(entry => entry.role)).toEqual(['generic', 'button', 'link', 'button', 'menu', 'menuitem']);
    expect(nodes[1]).toMatchObject({ name: 'Warning: Delete', ref: 'e2', parent: 0 });
    expect(nodes[2]).toMatchObject({ name: 'Item #1', ref: 'e3', parent: 0 });
    expect(nodes[3]).toMatchObject({ name: 'It\'s {here}', ref: 'e4', parent: 0 });
    // A dropped container used to re-parent its children onto the grandparent.
    expect(nodes[5]).toMatchObject({ name: 'Open', ref: 'e6', parent: 4 });
  });
});

describe('analyzeScreenReader accessible names', () => {
  it('flags controls and images with no accessible name', () => {
    expect(checks([node({ role: 'textbox', ref: 'e1' })])).toEqual(['missing-accessible-name']);
    expect(checks([node({ role: 'img', ref: 'e1' })])).toEqual(['missing-accessible-name']);
  });

  it('ignores aria-hidden elements, which the snapshot still lists', () => {
    expect(checks([
      node({ role: 'img', ref: 'e1', ariaHidden: true }),
      node({ role: 'button', ref: 'e2', ariaHidden: true, visibleText: 'Decorative' }),
      node({ role: 'link', ref: 'e3', ariaHidden: true, name: 'Read more', href: '/a' }),
    ])).toEqual([]);
  });

  it('inherits aria-hidden across an iframe, where closest() cannot see it', () => {
    // Playwright inlines the child frame's tree under the iframe node, but inside
    // that document nothing links back to <iframe aria-hidden="true">.
    const frame = (ariaHidden: boolean) => [
      node({ role: 'iframe', ref: 'e1', tagName: 'iframe', ariaHidden }),
      node({ role: 'generic', ref: 'f1e1', parent: 0 }),
      node({ role: 'button', ref: 'f1e2', parent: 1 }),
    ];
    expect(checks(frame(true))).toEqual([]);
    expect(checks(frame(false))).toEqual(['missing-accessible-name']);
  });

  it('does not flag containers, text nodes or named controls', () => {
    expect(checks([
      node({ role: 'generic', ref: 'e1' }),
      node({ role: 'paragraph', ref: 'e2', visibleText: 'Some prose' }),
      node({ role: 'button', ref: 'e3', name: 'Save', visibleText: 'Save' }),
      node({ role: 'button', ref: null, name: null }),
    ])).toEqual([]);
  });

  it('flags names that are useless out of context but keeps specific ones', () => {
    expect(checks([node({ role: 'link', ref: 'e1', name: 'Read more', visibleText: 'Read more', href: '/a' })]))
        .toEqual(['uninformative-accessible-name']);
    expect(checks([node({ role: 'link', ref: 'e1', name: 'Read more about pricing', visibleText: 'Read more about pricing', href: '/a' })]))
        .toEqual([]);
    expect(checks([node({ role: 'link', ref: 'e1', name: 'Click here!', visibleText: 'Click here!', href: '/a' })]))
        .toEqual(['uninformative-accessible-name']);
  });

  it('flags an exposed option with no name but not a named one', () => {
    // A closed <select> exposes no refs, so this only fires for a rendered
    // listbox, where a blank row is an unpickable choice.
    expect(checks([node({ role: 'option', ref: 'e1' })])).toEqual(['missing-accessible-name']);
    expect(checks([node({ role: 'option', ref: 'e1', name: 'Apples', visibleText: 'Apples' })])).toEqual([]);
  });

  it('flags file names used as alt text but not descriptions that mention a photo', () => {
    expect(checks([node({ role: 'img', ref: 'e1', name: 'IMG_1234.jpg' })]))
        .toEqual(['filename-as-accessible-name']);
    expect(checks([node({ role: 'img', ref: 'e1', name: 'DSC00123' })]))
        .toEqual(['filename-as-accessible-name']);
    expect(checks([node({ role: 'img', ref: 'e1', name: 'Photo of the 2024 team offsite' })]))
        .toEqual([]);
  });

  it('does not read a link or button named after a file as bad alt text', () => {
    // Only an image is described by its name; a download link named after the
    // file it fetches has nothing to fix.
    expect(checks([node({ role: 'link', ref: 'e1', name: 'logo.png', visibleText: 'logo.png', href: '/logo.png' })]))
        .toEqual([]);
    expect(checks([node({ role: 'button', ref: 'e1', name: 'IMG_1234.jpg', visibleText: 'IMG_1234.jpg' })]))
        .toEqual([]);
  });

  it('flags visible label and accessible name mismatches without punctuation or case noise', () => {
    expect(checks([node({ role: 'button', ref: 'e1', name: 'Submit form', visibleText: 'Send' })]))
        .toEqual(['label-in-name-mismatch']);
    expect(checks([node({ role: 'button', ref: 'e1', name: 'Search products', visibleText: 'Search' })]))
        .toEqual([]);
    expect(checks([node({ role: 'button', ref: 'e1', name: 'save changes', visibleText: 'SAVE CHANGES!' })]))
        .toEqual([]);
  });

  it('does not treat container text or icon-only controls as a label mismatch', () => {
    expect(checks([
      node({ role: 'link', ref: 'e1', name: 'Product card', visibleText: 'Nice hat 19.99 Add to cart', childCount: 3 }),
      node({ role: 'button', ref: 'e2', name: 'Close dialog', visibleText: '×' }),
    ])).toEqual([]);
  });

  it('flags sibling controls that share a name but lead elsewhere', () => {
    const siblings = [
      node({ role: 'list', ref: 'e1' }),
      node({ role: 'link', ref: 'e2', parent: 0, name: 'Download', visibleText: 'Download', href: '/a.pdf' }),
      node({ role: 'link', ref: 'e3', parent: 0, name: 'Download', visibleText: 'Download', href: '/b.pdf' }),
    ];
    expect(checks(siblings)).toEqual(['duplicate-accessible-name']);
  });

  it('does not flag repeated names with the same target or in different containers', () => {
    expect(checks([
      node({ role: 'list', ref: 'e1' }),
      node({ role: 'link', ref: 'e2', parent: 0, name: 'Home', visibleText: 'Home', href: '/' }),
      node({ role: 'link', ref: 'e3', parent: 0, name: 'Home', visibleText: 'Home', href: '/' }),
    ])).toEqual([]);

    expect(checks([
      node({ role: 'listitem', ref: 'e1' }),
      node({ role: 'listitem', ref: 'e2' }),
      node({ role: 'button', ref: 'e3', parent: 0, name: 'Edit', visibleText: 'Edit' }),
      node({ role: 'button', ref: 'e4', parent: 1, name: 'Edit', visibleText: 'Edit' }),
    ])).toEqual([]);
  });

  it('does not claim controls differ when their destination is not observable', () => {
    // Two "Save" submit buttons in one form, or an ARIA link with no href: the
    // audit cannot see what either one does, so it cannot call them ambiguous.
    expect(checks([
      node({ role: 'form', ref: 'e1' }),
      node({ role: 'button', ref: 'e2', parent: 0, name: 'Save', visibleText: 'Save' }),
      node({ role: 'button', ref: 'e3', parent: 0, name: 'Save', visibleText: 'Save' }),
    ])).toEqual([]);

    expect(checks([
      node({ role: 'list', ref: 'e1' }),
      node({ role: 'link', ref: 'e2', parent: 0, name: 'Download', visibleText: 'Download', href: '/a.pdf' }),
      node({ role: 'link', ref: 'e3', parent: 0, name: 'Download', visibleText: 'Download' }),
    ])).toEqual([]);
  });
});

describe('analyzeScreenReader reading order', () => {
  // Every reading-order participant needs rendered text; see the icon-only test below.
  function block(ref: string, text: string, x: number, y: number, overrides: Partial<ScreenReaderNode> = {}) {
    return node({ role: 'paragraph', ref, parent: 0, name: null, visibleText: text, rect: rect(x, y), ...overrides });
  }

  it('flags a single row whose visual order is reversed', () => {
    const result = analyze([
      node({ role: 'generic', ref: 'e1', selector: 'div.toolbar', visibleText: 'First in DOM Second in DOM' }),
      block('e2', 'First in DOM', 200, 10, { role: 'button', name: 'First in DOM' }),
      block('e3', 'Second in DOM', 50, 10, { role: 'button', name: 'Second in DOM' }),
    ]);
    expect(result.findings.map(finding => finding.check)).toEqual(['reading-order-mismatch']);
    expect(result.findings[0].problem).toContain('First in DOM');
    expect(result.findings[0].fix).toContain('Reorder the source');
  });

  it('flags a column whose visual order is reversed by absolute positioning', () => {
    expect(checks([
      node({ role: 'generic', ref: 'e1' }),
      block('e2', 'Lower but first in DOM', 10, 200),
      block('e3', 'Upper but second in DOM', 10, 10),
    ])).toEqual(['reading-order-mismatch']);
  });

  it('accepts a matching row, a matching column and a right-to-left row', () => {
    expect(checks([
      node({ role: 'generic', ref: 'e1' }),
      block('e2', 'Back', 10, 10, { role: 'button', name: 'Back' }),
      block('e3', 'Next', 200, 10, { role: 'button', name: 'Next' }),
    ])).toEqual([]);

    expect(checks([
      node({ role: 'generic', ref: 'e1' }),
      block('e2', 'Top paragraph', 10, 10),
      block('e3', 'Bottom paragraph', 10, 200),
    ])).toEqual([]);

    expect(checks([
      node({ role: 'generic', ref: 'e1', direction: 'rtl' }),
      block('e2', 'الأول', 300, 10, { role: 'link', name: 'الأول', href: '/1', direction: 'rtl' }),
      block('e3', 'الثاني', 150, 10, { role: 'link', name: 'الثاني', href: '/2', direction: 'rtl' }),
    ])).toEqual([]);
  });

  it('flags a right-to-left row only when it contradicts right-to-left reading', () => {
    expect(checks([
      node({ role: 'generic', ref: 'e1', direction: 'rtl' }),
      block('e2', 'الأول', 150, 10, { role: 'link', name: 'الأول', href: '/1', direction: 'rtl' }),
      block('e3', 'الثاني', 300, 10, { role: 'link', name: 'الثاني', href: '/2', direction: 'rtl' }),
    ])).toEqual(['reading-order-mismatch']);
  });

  it('ignores two-dimensional layouts such as CSS multi-column and grids', () => {
    // DOM order goes down column one then column two; row-major comparison would
    // wrongly call this a mismatch.
    expect(checks([
      node({ role: 'generic', ref: 'e1' }),
      block('e2', 'Column one top', 10, 100),
      block('e3', 'Column one bottom', 10, 140),
      block('e4', 'Column two top', 200, 100),
      block('e5', 'Column two bottom', 200, 140),
    ])).toEqual([]);
  });

  it('ignores an icon-only control rendered before its label', () => {
    // Disclosure arrows and leading icons carry no text, so their position is a
    // rendering detail rather than a change of reading sequence.
    expect(checks([
      node({ role: 'listitem', ref: 'e1' }),
      block('e2', 'Legislation', 60, 200, { role: 'link', name: 'Legislation', href: '#legislation' }),
      node({ role: 'button', ref: 'e3', parent: 0, name: 'Toggle Legislation subsection', visibleText: '', rect: rect(37, 201, 22, 22) }),
    ])).toEqual([]);
  });

  it('ignores floated media placed beside a later paragraph', () => {
    expect(checks([
      node({ role: 'generic', ref: 'e1' }),
      block('e2', 'Figure caption', 756, 628, { role: 'figure', name: 'Figure caption', floating: true }),
      block('e3', 'Body paragraph', 264, 347),
    ])).toEqual([]);
  });

  it('ignores off-canvas, clipped, fixed and overlapping boxes', () => {
    expect(checks([
      node({ role: 'generic', ref: 'e1' }),
      block('e2', 'Skip to content', -9999, 10, { role: 'link', name: 'Skip to content' }),
      block('e3', 'Clipped', 10, 10, { role: 'link', name: 'Clipped', rect: rect(10, 10, 1, 1) }),
      block('e4', 'Sticky header', 10, 500, { role: 'banner', positionFixed: true }),
      block('e5', 'First paragraph', 10, 10),
      block('e6', 'Overlapping paragraph', 15, 15),
    ])).toEqual([]);
  });

  it('reads direction from the children when the parent carries none of its own', () => {
    // An iframe element's direction is the embedding page's, and a parent that
    // was never measured has no direction at all; both would otherwise be read
    // as ltr and turn a correct right-to-left row into a false mismatch.
    const rtlRow = (parent: Partial<ScreenReaderNode>) => [
      node({ role: 'iframe', ref: 'e1', tagName: 'iframe', direction: 'ltr', ...parent }),
      block('f1e2', 'rishon', 300, 10, { role: 'link', name: 'rishon', href: '/1', direction: 'rtl' }),
      block('f1e3', 'sheni', 150, 10, { role: 'link', name: 'sheni', href: '/2', direction: 'rtl' }),
    ];
    expect(checks(rtlRow({ rect: rect(0, 0, 300, 80) }))).toEqual([]);
    expect(checks(rtlRow({ ref: null, rect: null, tagName: null }))).toEqual([]);

    // The same row in the wrong right-to-left order is still reported.
    expect(checks([
      node({ role: 'iframe', ref: 'e1', tagName: 'iframe', rect: rect(0, 0, 300, 80) }),
      block('f1e2', 'rishon', 150, 10, { role: 'link', name: 'rishon', href: '/1', direction: 'rtl' }),
      block('f1e3', 'sheni', 300, 10, { role: 'link', name: 'sheni', href: '/2', direction: 'rtl' }),
    ])).toEqual(['reading-order-mismatch']);
  });

  it('ignores elements that were not measured', () => {
    expect(checks([
      node({ role: 'generic', ref: 'e1' }),
      block('e2', 'Unmeasured', 0, 0, { rect: null }),
      block('e3', 'Measured', 10, 10),
    ])).toEqual([]);
  });
});

describe('analyzeScreenReader bounds and toggles', () => {
  it('caps findings per check while still counting and reporting the truncation', () => {
    const nodes = Array.from({ length: 5 }, (_, index) => node({ role: 'textbox', ref: `e${index + 1}` }));
    const result = analyze(nodes, 2);
    expect(result.findings).toHaveLength(2);
    expect(result.countByCheck['missing-accessible-name']).toBe(5);
    expect(result.truncatedChecks).toEqual(['missing-accessible-name']);
  });

  it('honours the check toggles', () => {
    const nodes = [
      node({ role: 'textbox', ref: 'e1' }),
      node({ role: 'generic', ref: 'e2' }),
      node({ role: 'button', ref: 'e3', parent: 1, name: 'Back', visibleText: 'Back', rect: rect(200, 10) }),
      node({ role: 'button', ref: 'e4', parent: 1, name: 'Next', visibleText: 'Next', rect: rect(50, 10) }),
    ];
    expect(analyzeScreenReader(nodes, { checkNames: false, checkReadingOrder: true, maxFindingsPerCheck: 20 })
        .findings.map(finding => finding.check)).toEqual(['reading-order-mismatch']);
    expect(analyzeScreenReader(nodes, { checkNames: true, checkReadingOrder: false, maxFindingsPerCheck: 20 })
        .findings.map(finding => finding.check)).toEqual(['missing-accessible-name']);
  });
});

const baseFacts: ElementFacts = {
  tagName: 'div',
  selector: 'div',
  visibleText: null,
  href: null,
  rect: null,
  direction: 'ltr',
  positionFixed: false,
  floating: false,
  ariaHidden: false,
};

function snapshotOf(entries: { role: string; ref: string }[]): string {
  return ['- generic:', ...entries.map(entry => `  - ${entry.role} [ref=${entry.ref}]`)].join('\n');
}

function createToolHarness(options: {
  snapshot: string;
  factsFor?: (ref: string) => Partial<ElementFacts>;
  staleRefs?: (ref: string) => boolean;
  staleDelayMs?: number;
}) {
  const concurrency = { current: 0, max: 0 };
  const frame: any = {
    evaluate: vi.fn(async (_collect: unknown, handles: { ref: string }[]) =>
      handles.map(handle => ({ ...baseFacts, ...options.factsFor?.(handle.ref) }))),
  };
  const page: any = {
    ariaSnapshot: vi.fn(async () => options.snapshot),
    frames: vi.fn(() => [frame]),
    mainFrame: vi.fn(() => frame),
    url: vi.fn(() => 'https://example.com/'),
    locator: vi.fn((selector: string) => ({
      elementHandle: async () => {
        const ref = selector.replace('aria-ref=', '');
        const stale = options.staleRefs?.(ref) ?? false;
        concurrency.current++;
        concurrency.max = Math.max(concurrency.max, concurrency.current);
        await new Promise(resolve => setTimeout(resolve, stale ? options.staleDelayMs ?? 0 : 0));
        concurrency.current--;
        return stale ? null : { ref, ownerFrame: async () => frame, dispose: async () => undefined };
      },
    })),
  };
  const tab: any = {
    modalStates: () => [],
    page,
    context: { outputFile: async (name: string) => `/tmp/${name}` },
  };
  const context: any = { currentTabOrDie: () => tab, config: {} };
  return { context, response: new Response(context, 'audit_screen_reader', {}), concurrency };
}

describe('audit_screen_reader tool measurement', () => {
  const tool = auditScreenReaderTools.find(entry => entry.schema.name === 'audit_screen_reader')!;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);
  });

  async function run(harness: ReturnType<typeof createToolHarness>, maxElements: number) {
    await tool.handle(harness.context, {
      checkNames: true,
      checkReadingOrder: true,
      maxElements,
      maxFindingsPerCheck: 20,
    } as any, harness.response);
    return harness.response.result();
  }

  it('spends the element budget on elements a screen reader can reach', async () => {
    // The AI snapshot also refs aria-hidden subtrees: slicing the raw ref list
    // let 60 decorative icons eat the whole budget and hide the two real defects.
    const harness = createToolHarness({
      snapshot: snapshotOf([
        ...Array.from({ length: 60 }, (_, index) => ({ role: 'img', ref: `h${index}` })),
        { role: 'button', ref: 'b1' },
        { role: 'button', ref: 'b2' },
      ]),
      factsFor: ref => ref.startsWith('h') ? { ariaHidden: true } : {},
    });

    const result = await run(harness, 50);
    expect(result).toContain('Elements analyzed: 62');
    expect(result).toContain('missing-accessible-name | 2');
  });

  it('still stops at the budget when every element is reachable', async () => {
    const harness = createToolHarness({
      snapshot: snapshotOf(Array.from({ length: 62 }, (_, index) => ({ role: 'button', ref: `b${index}` }))),
    });

    const result = await run(harness, 50);
    expect(result).toContain('Elements analyzed: 50');
    expect(result).toContain('truncated: analyzed the first 50 of 62');
    expect(result).toContain('missing-accessible-name | 50');
  });

  it('stops at the budget when it is not a multiple of the chunk size', async () => {
    const harness = createToolHarness({
      snapshot: snapshotOf(Array.from({ length: 120 }, (_, index) => ({ role: 'button', ref: `b${index}` }))),
    });

    // A whole extra chunk used to be taken: 100 elements analyzed for maxElements 51.
    expect(await run(harness, 51)).toContain('Elements analyzed: 51');
    expect(await run(createToolHarness({
      snapshot: snapshotOf(Array.from({ length: 120 }, (_, index) => ({ role: 'button', ref: `b${index}` }))),
    }), 5)).toContain('Elements analyzed: 5');
  });

  it('resolves refs in parallel batches so a stale snapshot cannot stall the audit', async () => {
    // Every ref of a rerendered page times out; resolving them one at a time
    // costs one full timeout per element.
    const harness = createToolHarness({
      snapshot: snapshotOf(Array.from({ length: 120 }, (_, index) => ({ role: 'button', ref: `b${index}` }))),
      staleRefs: () => true,
      staleDelayMs: 5,
    });

    // Nothing resolved means nothing was evaluated: reporting "Findings: 0"
    // here would present an unaudited page as clean.
    await expect(run(harness, 50)).rejects.toThrow(/None of the 100 accessibility tree elements could be resolved/);
    expect(harness.concurrency.max).toBe(50);
  });

  it('warns when part of the snapshot went stale instead of silently skipping it', async () => {
    // A partial rerender: the resolved half is still audited, but the result
    // must say the other half was never evaluated.
    const harness = createToolHarness({
      snapshot: snapshotOf(Array.from({ length: 10 }, (_, index) => ({ role: 'button', ref: `b${index}` }))),
      staleRefs: ref => Number(ref.slice(1)) >= 5,
    });

    const result = await run(harness, 50);
    expect(result).toContain('Elements analyzed: 10');
    expect(result).toContain('WARNING: 5 of these went stale before measurement');
    // The five resolved nameless buttons are still reported.
    expect(result).toContain('missing-accessible-name | 5');
  });
});

describe('collectElementFacts in a real page', () => {
  let browser: Browser | undefined;

  beforeEach(async () => {
    browser ??= await chromium.launch();
  });

  it('takes the visible label of button-like inputs from value', async () => {
    const page = await browser!.newPage();
    await page.setContent(`
      <input type="submit" id="send" value="Send" aria-label="Submit form">
      <input type="reset" id="clear" value="Clear">
      <input type="submit" id="bare">
      <input type="text" id="text" value="typed text" aria-label="Query">
      <button id="save">Save</button>
      <button id="icon"><svg width="12" height="12"></svg></button>`);
    const handles = await Promise.all(['#send', '#clear', '#bare', '#text', '#save', '#icon']
        .map(selector => page.$(selector)));

    const facts = await page.evaluate(collectElementFacts, handles as any);

    // #bare has no value: the UA renders "Submit" but exposes no label to copy,
    // and #text holds user input rather than a label.
    expect(facts.map(fact => fact.visibleText)).toEqual(['Send', 'Clear', null, null, 'Save', null]);
    await page.close();
  });

  it('reads the visible label a web component renders in its shadow root', async () => {
    const page = await browser!.newPage();
    await page.setContent(`
      <my-btn id="host" role="button" aria-label="Cancel"></my-btn>
      <my-empty id="empty" role="button" aria-label="Menu"></my-empty>
      <script>
        customElements.define('my-btn', class extends HTMLElement {
          connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<span>Send</span>'; }
        });
        customElements.define('my-empty', class extends HTMLElement {
          connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<svg width="12" height="12"></svg>'; }
        });
      </script>`);
    const handles = await Promise.all(['#host', '#empty'].map(selector => page.$(selector)));

    const facts = await page.evaluate(collectElementFacts, handles as any);

    // The icon-only host still has no visible label to mismatch against.
    expect(facts.map(fact => fact.visibleText)).toEqual(['Send', null]);
    await page.close();
  });

  it('treats aria-hidden values case-insensitively, as ARIA enumerated tokens are', async () => {
    const page = await browser!.newPage();
    await page.setContent(`
      <div aria-hidden="TRUE"><button id="upper">Hidden upper</button></div>
      <div aria-hidden="true"><button id="lower">Hidden lower</button></div>
      <div aria-hidden="false"><button id="shown">Shown</button></div>`);
    const handles = await Promise.all(['#upper', '#lower', '#shown'].map(selector => page.$(selector)));

    const facts = await page.evaluate(collectElementFacts, handles as any);

    // aria-hidden="TRUE" removes the subtree from the accessibility tree exactly
    // like "true"; a case-sensitive selector reported its content as reachable.
    expect(facts.map(fact => fact.ariaHidden)).toEqual([true, true, false]);
    await page.close();
  });

  it('collects no visible text from an element that is itself hidden from sight', async () => {
    const page = await browser!.newPage();
    await page.setContent(`
      <button id="ghost" style="opacity:0" aria-label="Submit">Send</button>
      <button id="gone" style="visibility:hidden" aria-label="Submit">Send</button>
      <button id="folded" style="visibility:collapse" aria-label="Submit">Send</button>
      <button id="shown" aria-label="Submit">Send</button>`);
    const handles = await Promise.all(['#ghost', '#gone', '#folded', '#shown'].map(selector => page.$(selector)));

    const facts = await page.evaluate(collectElementFacts, handles as any);

    // A fully invisible control shows no label at all, so its child text must
    // not feed a label-in-name mismatch; only #shown really displays "Send".
    // visibility:collapse renders like hidden outside table rows/columns.
    expect(facts.map(fact => fact.visibleText)).toEqual([null, null, null, 'Send']);
    await page.close();
  });

  it('counts only slot-assigned light children of a shadow host as visible', async () => {
    const page = await browser!.newPage();
    await page.setContent(`
      <my-slotted id="slotted" role="button" aria-label="Cancel"><span>Slotted</span></my-slotted>
      <my-noslot id="noslot" role="button" aria-label="Cancel"><span>Ghost</span></my-noslot>
      <my-fallback id="fallback" role="button" aria-label="Cancel"></my-fallback>
      <script>
        customElements.define('my-slotted', class extends HTMLElement {
          connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<slot></slot>'; }
        });
        customElements.define('my-noslot', class extends HTMLElement {
          connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<span>Shadow label</span>'; }
        });
        customElements.define('my-fallback', class extends HTMLElement {
          connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<slot>Fallback</slot>'; }
        });
      </script>`);
    const handles = await Promise.all(['#slotted', '#noslot', '#fallback'].map(selector => page.$(selector)));

    const facts = await page.evaluate(collectElementFacts, handles as any);

    // A shadow tree replaces the host's light children: only slot-assigned
    // nodes render. "Ghost" has no slot to land in, so it shows nowhere; an
    // empty slot renders its own fallback content.
    expect(facts.map(fact => fact.visibleText)).toEqual(['Slotted', 'Shadow label', 'Fallback']);
    await page.close();
  });

  it('keeps text from a descendant that restores visibility under a hidden ancestor', async () => {
    const page = await browser!.newPage();
    await page.setContent(`
      <button id="restored" style="visibility:hidden" aria-label="Submit"><span style="visibility:visible">Send</span></button>
      <button id="inherited" style="visibility:hidden" aria-label="Submit"><span>Send</span></button>`);
    const handles = await Promise.all(['#restored', '#inherited'].map(selector => page.$(selector)));

    const facts = await page.evaluate(collectElementFacts, handles as any);

    // visibility, unlike display/opacity/clip, is restorable below a hidden
    // ancestor: the first span renders, so "Send" really is the visible label;
    // the second inherits hidden and shows nothing.
    expect(facts.map(fact => fact.visibleText)).toEqual(['Send', null]);
    await page.close();
  });

  it('walks content of boxless and collapsed-but-overflowing elements', async () => {
    const page = await browser!.newPage();
    await page.setContent(`
      <div id="contents" style="display:contents">Send</div>
      <div id="contents-clip" style="display:contents; clip-path: inset(0)">Send</div>
      <div id="overflowing" style="width:1px;height:1px;overflow:visible">Send</div>
      <div id="clipped" style="width:1px;height:1px;overflow:hidden">Send</div>`);
    const handles = await Promise.all(['#contents', '#contents-clip', '#overflowing', '#clipped'].map(selector => page.$(selector)));

    const facts = await page.evaluate(collectElementFacts, handles as any);

    // display:contents has a 0x0 rect but renders its content in the parent's
    // box — with no box there is nothing for a clip-path to clip either, even
    // one whose inset would swallow the 0x0 rect — and a collapsed box with
    // visible overflow paints its text outside itself; only the clipping
    // collapsed box (the sr-only shape) hides it.
    expect(facts.map(fact => fact.visibleText)).toEqual(['Send', 'Send', 'Send', null]);
    await page.close();
  });

  it('honours legacy clip only where it applies, on positioned elements', async () => {
    const page = await browser!.newPage();
    await page.setContent(`
      <div id="static-clip" style="clip: rect(0 0 0 0)">Send</div>
      <div id="positioned-clip" style="position: absolute; clip: rect(0 0 0 0)">Send</div>`);
    const handles = await Promise.all(['#static-clip', '#positioned-clip'].map(selector => page.$(selector)));

    const facts = await page.evaluate(collectElementFacts, handles as any);

    // clip is inert on statically positioned boxes — that text really renders —
    // while the classic sr-only shape (absolute + clip) hides everything.
    expect(facts.map(fact => fact.visibleText)).toEqual(['Send', null]);
    await page.close();
  });

  it('collects no text from a control hidden by an ancestor its own style cannot see', async () => {
    const page = await browser!.newPage();
    await page.setContent(`
      <div style="opacity:0"><button id="in-opacity" aria-label="Submit">Send</button></div>
      <div style="position:absolute;width:1px;height:1px;overflow:hidden"><button id="in-sronly" aria-label="Submit">Send</button></div>
      <div><button id="in-visible" aria-label="Submit">Send</button></div>`);
    const handles = await Promise.all(['#in-opacity', '#in-sronly', '#in-visible'].map(selector => page.$(selector)));

    const facts = await page.evaluate(collectElementFacts, handles as any);

    // opacity is not inherited and a clipping wrapper leaves the child's rect
    // untouched, so neither shows up in the control's own computed style — the
    // ancestors must be walked, or invisible labels feed label-in-name checks.
    expect(facts.map(fact => fact.visibleText)).toEqual([null, null, 'Send']);
    await page.close();
  });

  it('hides a clip-path inset only when it leaves no painted area', async () => {
    const page = await browser!.newPage();
    await page.setContent(`
      <div id="sr-only" style="clip-path: inset(50%); width:100px; height:100px">Send</div>
      <div id="half" style="clip-path: inset(50% 0 0 0); width:100px; height:100px">Send</div>
      <div id="swallowed" style="clip-path: inset(0 0 100% 0); width:100px; height:100px">Send</div>`);
    const handles = await Promise.all(['#sr-only', '#half', '#swallowed'].map(selector => page.$(selector)));

    const facts = await page.evaluate(collectElementFacts, handles as any);

    // inset(50% 0 0 0) computes to "inset(50% 0px 0px)" — the same prefix as
    // the sr-only inset(50%) — yet paints the whole bottom half; only insets
    // whose remaining region has no area hide the text, whichever edge
    // combination collapses it.
    expect(facts.map(fact => fact.visibleText)).toEqual([null, 'Send', null]);
    await page.close();
  });

  it('walks a slotted element through its slot, catching hidden shadow wrappers', async () => {
    const page = await browser!.newPage();
    await page.setContent(`
      <ghost-card id="in-hidden-wrapper" role="button" aria-label="Submit"><span>Send</span></ghost-card>
      <plain-card id="in-visible-wrapper" role="button" aria-label="Submit"><span>Send</span></plain-card>
      <script>
        customElements.define('ghost-card', class extends HTMLElement {
          connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<div style="opacity:0"><slot></slot></div>'; }
        });
        customElements.define('plain-card', class extends HTMLElement {
          connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<div><slot></slot></div>'; }
        });
      </script>`);
    const handles = await Promise.all(
        ['#in-hidden-wrapper span', '#in-visible-wrapper span'].map(selector => page.$(selector)));

    const facts = await page.evaluate(collectElementFacts, handles as any);

    // A slotted element renders where its slot sits: its flat-tree ancestors
    // are the slot and the shadow-tree wrapper around it, not the host's light
    // parent chain. parentElement skips straight to the host, so a walk using
    // it misses the opacity:0 wrapper and reports text nobody can see.
    expect(facts.map(fact => fact.visibleText)).toEqual([null, 'Send']);
    await page.close();
  });

  it('treats zero-scale transforms as hidden, but not other transforms', async () => {
    const page = await browser!.newPage();
    await page.setContent(`
      <button id="scale0" style="transform: scale(0)" aria-label="Submit">Send</button>
      <button id="scalex0" style="transform: scaleX(0)" aria-label="Submit">Send</button>
      <button id="rotated" style="transform: rotate(45deg)" aria-label="Submit">Send</button>
      <div style="transform: scale(0)"><button id="in-scale0" aria-label="Submit">Send</button></div>`);
    const handles = await Promise.all(['#scale0', '#scalex0', '#rotated', '#in-scale0'].map(selector => page.$(selector)));

    const facts = await page.evaluate(collectElementFacts, handles as any);

    // A singular transform collapses the painted area — overflow included, so
    // the collapsed-box exception for visible overflow must not apply. A
    // rotation keeps the full area painted and its label really shows. The
    // wrapper case needs the ancestor walk: the child's own rect collapses but
    // its computed transform is none.
    expect(facts.map(fact => fact.visibleText)).toEqual([null, null, 'Send', null]);
    await page.close();
  });

  it('resolves link destinations so relative and absolute forms compare equal', async () => {
    const page = await browser!.newPage();
    await page.route('https://example.com/**', route => route.fulfill({
      contentType: 'text/html',
      body: `
        <a id="relative" href="/help">Help</a>
        <a id="absolute" href="https://example.com/help">Help</a>
        <a id="other" href="/support">Help</a>
        <a id="nohref">Help</a>`,
    }));
    await page.goto('https://example.com/docs/');
    const handles = await Promise.all(['#relative', '#absolute', '#other', '#nohref']
        .map(selector => page.$(selector)));

    const facts = await page.evaluate(collectElementFacts, handles as any);

    expect(facts[0].href).toBe(facts[1].href);
    expect(facts[2].href).not.toBe(facts[0].href);
    // No href at all stays unobservable, so duplicate names are never claimed.
    expect(facts[3].href).toBeNull();
    await page.close();
  });

  afterAll(async () => {
    await browser?.close();
  });
});
