import axe from 'axe-core';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { truncateDataUrls } from '../utils/dataUrl.js';

import type * as playwright from 'playwright';

export const axeTagValues = [
  'wcag2a', 'wcag2aa', 'wcag2aaa', 'wcag21a', 'wcag21aa', 'wcag21aaa',
  'wcag22a', 'wcag22aa', 'wcag22aaa', 'section508', 'cat.aria', 'cat.color',
  'cat.forms', 'cat.keyboard', 'cat.language', 'cat.name-role-value',
  'cat.parsing', 'cat.semantics', 'cat.sensory-and-visual-cues',
  'cat.structure', 'cat.tables', 'cat.text-alternatives', 'cat.time-and-media',
  'best-practice', 'experimental',
] as const;

export type AxeTag = (typeof axeTagValues)[number];

// Default scan set: only tags that map to a conformance criterion, so a default
// report keeps meaning "this fails WCAG/Section 508".
//
// The `cat.*` tags are deliberately absent. Axe matches `runOnly` tags with OR,
// so keeping e.g. `cat.keyboard` in the default set pulls in best-practice rules
// like `region` and `landmark-one-main` that carry both tags — merely omitting
// the `best-practice` tag does not make those rules opt-in. Almost nothing is
// lost: the only rules reachable solely through a `cat.*` tag are `duplicate-id`
// and `duplicate-id-active`, both deprecated in Axe since WCAG dropped SC 4.1.1.
//
// Five rules tagged `experimental` also carry a real `wcag*` tag and therefore
// still run by default: css-orientation-lock (SC 1.3.4),
// label-content-name-mismatch (SC 2.5.3), p-as-heading, table-fake-caption and
// td-has-header (SC 1.3.1). That is deliberate. `experimental` in Axe describes
// how settled the heuristic is, not whether the criterion is real, so filtering
// them out would drop genuine conformance coverage from the default scan — the
// opposite of what this tag set is for.
export const defaultAxeTags: readonly AxeTag[] = axeTagValues.filter(
    tag => tag.startsWith('wcag') || tag === 'section508'
);
// The scan result carries only what the reporting tools read. Axe's own result
// object additionally holds the per-node check arrays and the full node list of
// every passing rule, which together are ~85% of a content-heavy page's result
// and are dropped inside the page rather than serialized across the CDP
// connection and thrown away here.
type AxeNode = {
  target: axe.NodeResult['target'];
  html: string;
  failureSummary: string | null;
};

export type AxeViolation = {
  id: string;
  impact: axe.ImpactValue | null | undefined;
  tags: string[];
  help: string;
  helpUrl: string;
  description: string;
  nodes: AxeNode[];
};

export type AxeScanResult = {
  url: string;
  violations: AxeViolation[];
  incomplete: AxeViolation[];
  // Only the rule count of these is ever reported, so only the ids survive.
  passes: { id: string }[];
  inapplicable: { id: string }[];
  // Child frames Axe could not be installed in, and whose contents therefore
  // contributed nothing to the results above. Empty on a scan that covered
  // everything, so an empty violation list means something only when this is.
  unscannedFrames: string[];
};

export type AxeScanOptions = {
  tags?: readonly AxeTag[];
  rules?: readonly string[];
  disableRules?: readonly string[];
  include?: readonly string[];
  exclude?: readonly string[];
};

// Shared by every scan tool so scoping means the same thing everywhere.
export const axeScopeSchemaShape = {
  includeSelectors: z.array(z.string().min(1)).optional().describe('CSS selectors to restrict the scan to, e.g. ["#checkout-form"]. Omit to scan the whole page. Each selector may match multiple elements.'),
  excludeSelectors: z.array(z.string().min(1)).optional().describe('CSS selectors to exclude from the scan, e.g. ["#cookie-banner", "iframe.chat-widget"]. Applied after includeSelectors, so it can carve regions out of an included subtree.'),
};

// Shared by every scan tool so rule filtering means the same thing everywhere.
export const axeRuleSchemaShape = {
  withRules: z.array(z.string().min(1)).min(1).optional().describe('Run only these Axe rule ids, e.g. ["color-contrast", "image-alt"]. Axe can run a rule list or a tag list but never both, so setting withRules ignores violationsTag entirely. Unknown rule ids are rejected rather than silently skipped, and so is an empty list — omit the option to scan by tags instead.'),
  disableRules: z.array(z.string().min(1)).optional().describe('Axe rule ids to skip, e.g. ["color-contrast"]. Unlike withRules this narrows whatever is already selected, so it applies to violationsTag and withRules alike. Disabling every rule in withRules is an error, not an empty scan. Unknown rule ids are rejected rather than silently skipped.'),
};

// The rule catalogue comes from the very axe-core build injected into the page
// (`axe.source` below), so ids can never drift from what the scan supports and
// no extra injection is needed to check them.
// Axe does reject unknown ids itself, but only from inside the page after
// injection, surfacing as an opaque `frame.evaluate` failure; checking up front
// names the bad id and costs nothing.
let knownRuleIds: Set<string> | undefined;
function assertRuleIdsExist(ruleIds: readonly string[], label: 'withRules' | 'disableRules') {
  if (!ruleIds.length)
    return;
  knownRuleIds ??= new Set(axe.getRules().map(rule => rule.ruleId));
  const unknown = ruleIds.filter(ruleId => !knownRuleIds!.has(ruleId));
  if (unknown.length)
    throw new Error(`Unknown Axe rule id(s) in ${label}: ${unknown.join(', ')}. See https://dequeuniversity.com/rules/axe/ for valid ids.`);
}

// Rule options are run-wide input and need no page, so a crawler can validate
// them once before navigating anything instead of failing every page in turn.
// Returns the rule list to actually run, empty when the caller passed none.
// (Scope selectors stay per-page on purpose: a component may legitimately be
// absent from some pages of a crawl.)
export function assertRuleOptionsValid(options: Pick<AxeScanOptions, 'rules' | 'disableRules'>): string[] {
  // An explicitly empty list is a contradiction, not a no-op: the caller asked
  // to run only the listed rules and listed none. Treating it like an omitted
  // option would silently fall back to the full tag set and scan far more than
  // requested — the same trap the disableRules-empties-withRules guard closes.
  if (options.rules && !options.rules.length)
    throw new Error('withRules is an empty list, which would silently fall back to scanning the full tag set. Omit withRules to scan by tags, or name at least one rule id.');
  assertRuleIdsExist(options.rules ?? [], 'withRules');
  assertRuleIdsExist(options.disableRules ?? [], 'disableRules');
  if (!options.rules?.length)
    return [];
  // axe's ruleShouldRun returns on the runOnly-is-a-rule-list branch before it
  // ever reads the per-rule `enabled` flag that disableRules sets, so passing
  // both would silently run a rule the caller asked to disable. Subtract here
  // so disableRules means the same thing next to withRules as next to tags.
  const disabled = new Set(options.disableRules ?? []);
  const rules = options.rules.filter(rule => !disabled.has(rule));
  // axe rejects an empty runOnly list with a message that names neither
  // option, and falling back to the tag set would scan far more than asked.
  if (!rules.length)
    throw new Error(`disableRules disabled every rule in withRules (${options.rules.join(', ')}), leaving nothing to scan.`);
  return rules;
}

// Axe only rejects a scope when the *whole* include set resolves to nothing, so
// one typo among several include selectors silently shrinks the scan and the
// report still looks clean. Resolve every selector ourselves first: a scan that
// quietly covers less than asked is worse than one that fails loudly.
async function assertScopeSelectorsResolve(
  page: playwright.Page,
  include: readonly string[],
  exclude: readonly string[]
) {
  if (!include.length && !exclude.length)
    return;
  // One round trip for both lists: the includes come first, so the counts split
  // back apart at `include.length`.
  const selectors = [...include, ...exclude];
  const counts = await page.evaluate(list => list.map(selector => {
    try {
      return document.querySelectorAll(selector).length;
    } catch {
      return -1;
    }
  }), selectors);

  for (const [label, list, offset] of [
    ['includeSelectors', include, 0],
    ['excludeSelectors', exclude, include.length],
  ] as const) {
    const invalid = list.filter((_, index) => counts[offset + index] === -1);
    if (invalid.length)
      throw new Error(`Invalid CSS in ${label}: ${invalid.join(', ')}`);
  }

  // An unmatched exclude only leaves extra content in scope, and a crawl may
  // legitimately hit pages without the excluded widget, so it is not an error.
  const unmatched = include.filter((_, index) => counts[index] === 0);
  if (unmatched.length)
    throw new Error(`No elements matched includeSelectors: ${unmatched.join(', ')}. The scan would have silently covered less of the page than requested.`);
}

// Set by the configure step below, and the only thing the coverage check
// trusts. A frame that navigated to a document carrying its own axe of the same
// version would answer a bare version probe while lacking the allowedOrigins
// configuration the top-level run needs - and so would go unscanned while
// looking covered.
//
// Ceiling: any in-page marker can be forged by the page itself. The name is
// distinctive enough that an accidental collision does not happen; a page
// deliberately evading its own audit is out of scope.
const axeReadyMarker = '__mcpAccessibilityScannerAxeReady';
let axeReadySequence = 0;
const axeReadyNonce = randomUUID();

// Axe's frame support needs its own copy in every frame, and the copy talks to
// the top-level run over postMessage. `<unsafe_all_origins>` is what lets a
// cross-origin frame answer; without it those frames go unscanned.
const axeConfigureSource = `;axe.configure({ allowedOrigins: ['<unsafe_all_origins>'], branding: { application: 'playwright' } });`;

// Injected fresh for every scan rather than reused when `window.axe` already
// looks right: that global belongs to the page, which may have installed its own
// axe or reconfigured ours since, and a scan must run this server's build and
// configuration. Re-injection costs ~70ms per frame against a multi-second scan.
async function injectAxe(frame: playwright.Frame, source: string): Promise<void> {
  await frame.evaluate(source);
}

// A child frame that never answers must not hang the scan. It goes unscanned
// instead - but not silently: a frame Axe never reached contributes no
// violations, and an unreported one turns into a clean-looking report.
const childFrameInjectionTimeoutMs = 1000;

// Every read from a child frame is bounded by it, not just the injection: an
// unresponsive renderer answers neither, and `frame.evaluate` has no timeout of
// its own, so an unbounded probe would hang the whole scan rather than produce
// the partial-coverage warning it exists to produce.
async function withFrameTimeout<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    // Both branches resolve: a rejected loser of the race would surface as an
    // unhandled rejection once the winner has already been awaited.
    return await Promise.race([
      work.catch(() => fallback),
      new Promise<T>(resolve => {
        timeoutId = setTimeout(() => resolve(fallback), childFrameInjectionTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

// Injections run a few at a time rather than all at once. Frames sharing a
// renderer run their evaluations on one thread, so launching every injection
// together starts every timeout clock together too, and a frame still queued
// behind its siblings is timed out for being slow before it has had a turn -
// the budget is meant to catch an unresponsive renderer, not a busy one.
//
// A pool fixes that because a frame's clock starts when a slot frees, never
// while it waits. Measured on a page of 48 same-origin frames: launching them
// all at once reported 28 healthy frames as unscanned and 96 frames reported
// every one of them; through the pool, none, at every size tried.
const frameInjectionConcurrency = 4;

async function withConcurrency<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  let next = 0;
  const results: R[] = [];
  await Promise.all(Array.from(
      { length: Math.min(frameInjectionConcurrency, items.length) },
      async () => {
        while (next < items.length) {
          const index = next++;
          results[index] = await run(items[index]);
        }
      },
  ));
  return results;
}

// A frame name is author-controlled and unbounded, so it is normalized and
// capped before going anywhere near a report.
const maxFrameNameLength = 80;
const maxFrameUrlLength = 2048;

// Identifies a frame for the coverage warning. The URL alone is not enough for
// a srcdoc or scripted about:blank frame - both report "about:blank" while
// holding a whole document - so the frame's name comes along when it has one.
// Both are truncated: a data: frame's URL is its document, a name can carry one
// too, and this string ends up in tool text, structured content and JSON
// reports alike.
function describeFrame(frame: playwright.Frame): string {
  const rawUrl = truncateDataUrls(frame.url()) || 'about:blank';
  const url = rawUrl.length > maxFrameUrlLength ? `${rawUrl.slice(0, maxFrameUrlLength - 3)}...` : rawUrl;
  const name = truncateDataUrls(frame.name().replace(/\s+/g, ' ').trim()).slice(0, maxFrameNameLength);
  return name ? `${url} (name="${name}")` : url;
}

// Whether this frame currently holds the Axe this server injected and
// configured. A frame that navigated after its injection - or that appeared
// since, or that carries only the page's own axe - answers no.
async function hasAxe(frame: playwright.Frame, token: string): Promise<boolean> {
  return withFrameTimeout(
      frame.evaluate(({ marker, token }) => (window as any)[marker] === token, { marker: axeReadyMarker, token }),
      false,
  );
}

// A frame the caller scoped out of the scan is not a coverage gap: its contents
// were never going to be reported. Answered from the iframe element in its
// parent document, so an `excludeSelectors: ["iframe.chat-widget"]` entry - the
// documented recipe for dropping a flaky third-party widget - does not produce a
// warning about the very frame it removed.
//
// The whole ancestor chain is walked, not just the immediate parent document,
// because `closest()` stops at a frame boundary while an Axe context does not:
// `includeSelectors: ["#main"]` covers an iframe nested inside an iframe inside
// `#main`, and an exclude naming an outer frame drops everything below it.
//
// Only a positive determination suppresses the warning. An unreachable frame
// element or a probe that cannot answer in time falls through to reporting, so
// no genuine gap is hidden by a check that failed to resolve.
async function isFrameInScope(
  frame: playwright.Frame,
  mainFrame: playwright.Frame,
  include: readonly string[],
  exclude: readonly string[]
): Promise<boolean> {
  let includeMatched = !include.length;
  for (let current = frame; current.parentFrame(); current = current.parentFrame()!) {
    // Bounded like every other child-frame read: `frameElement()` takes no
    // timeout of its own, so an unresponsive parent renderer would hang the
    // scan here - on the very check that exists to report unresponsive frames.
    const elementPromise = current.frameElement().catch(() => null);
    const element = await withFrameTimeout(elementPromise, null);
    if (!element) {
      // The lookup may still land after the bound; do not leak that handle.
      void elementPromise.then(late => late?.dispose().catch(() => {}));
      return true;
    }
    let matches: { included: boolean, excluded: boolean, hidden: boolean } | null;
    try {
      matches = await withFrameTimeout(element.evaluate((node, scope) => {
        // getRootNode() is only consulted on the branch that needs it: the
        // walk runs per ancestor per candidate selector, and the light-DOM
        // case (by far the common one) never reads the root at all.
        const composedParent = (element: Element) => {
          if (element.assignedSlot) {
            if (element.assignedSlot.parentElement)
              return element.assignedSlot.parentElement;
            const slotRoot = element.assignedSlot.getRootNode();
            return slotRoot instanceof ShadowRoot ? slotRoot.host : null;
          }
          if (element.parentElement)
            return element.parentElement;
          const root = element.getRootNode();
          return root instanceof ShadowRoot ? root.host : null;
        };
        const matchesAny = (selectors: string[]) => selectors.some(selector => {
          try {
            for (let current: Element | null = node as Element; current;) {
              if (current.matches(selector))
                return true;
              current = composedParent(current);
            }
            return false;
          } catch {
            return false;
          }
        });
        const roots: (Document | ShadowRoot)[] = [document];
        const modals: Element[] = [];
        for (const root of roots) {
          modals.push(...[...root.querySelectorAll('dialog:modal')].filter(modal => {
            const style = getComputedStyle(modal);
            const rect = modal.getBoundingClientRect();
            const visible = modal.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ??
              (style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility) && style.opacity !== '0');
            return visible &&
              rect.width > 0 && rect.height > 0 &&
              (modal.getRootNode() as Document | ShadowRoot).elementsFromPoint(rect.left + 1, rect.top + 1).includes(modal);
          }));
          for (const element of root.querySelectorAll('*')) {
            if (element.shadowRoot)
              roots.push(element.shadowRoot);
          }
        }
        const insideModal = modals.some(modal => {
          for (let current: Element | null = node as Element; current;) {
            if (current === modal)
              return true;
            current = composedParent(current);
          }
          return false;
        });
        let hidden = !!modals.length && !insideModal;
        for (let current: Element | null = node as Element; current;) {
          const parent = current.assignedSlot?.parentElement ?? current.parentElement;
          const style = getComputedStyle(current);
          const ariaHidden = current.getAttribute('aria-hidden') === 'true';
          const flattenedChildren = parent ? [...parent.children].flatMap(child => {
            if (child.localName !== 'slot')
              return [child];
            const assigned = (child as HTMLSlotElement).assignedElements({ flatten: true });
            return assigned.length ? assigned : [...child.children];
          }) : [];
          const closedDetails = parent?.localName === 'details' && !parent.hasAttribute('open') &&
            (current.localName !== 'summary' || flattenedChildren.find(child => child.localName === 'summary') !== current);
          const contentHidden = current !== node && style.getPropertyValue('content-visibility') === 'hidden';
          if (ariaHidden || style.display === 'none' || current.hasAttribute('inert') || closedDetails || contentHidden) {
            hidden = true;
            break;
          }
          current = composedParent(current);
        }
        const visibility = getComputedStyle(node as Element).visibility;
        hidden ||= visibility === 'hidden' || visibility === 'collapse';
        return { included: matchesAny(scope.include), excluded: matchesAny(scope.exclude), hidden };
      }, current.parentFrame() === mainFrame
        ? { include: [...include], exclude: [...exclude] }
        : { include: [], exclude: [] }), null);
    } finally {
      await element.dispose().catch(() => {});
    }
    if (!matches)
      return true;
    // Axe does not traverse a frame hidden from the accessibility tree, so a
    // failed injection there is not missing coverage.
    if (matches.hidden)
      return false;
    // Exclude wins wherever it matches: it drops the whole subtree under it.
    if (matches.excluded)
      return false;
    includeMatched ||= matches.included;
  }
  return includeMatched;
}

// Returns an identifier for every child frame Axe could not be installed in, so
// the caller can say what the scan did not cover. Every failure is reported
// whatever the URL scheme: injection into an empty about:blank frame succeeds,
// so a frame that reaches here failed for a reason worth knowing about.
//
// Duplicates are kept: two unnamed about:blank frames that both fail are two
// documents that went unscanned, and collapsing them would under-count.
async function injectAxeIntoFrames(
  page: playwright.Page,
  include: readonly string[],
  exclude: readonly string[]
): Promise<string[]> {
  const token = `${axe.version}:${axeReadyNonce}:${++axeReadySequence}`;
  const source = `${axe.source}${axeConfigureSource}window[${JSON.stringify(axeReadyMarker)}]=${JSON.stringify(token)};`;
  const mainFrame = page.mainFrame();
  await injectAxe(mainFrame, source);
  await withConcurrency(
      page.frames().filter(frame => frame !== mainFrame),
      frame => withFrameTimeout(injectAxe(frame, source), undefined),
  );

  // Coverage is decided here rather than from the injection results: a frame
  // that navigated while a slower sibling was still injecting has a new document
  // without Axe, and one that appeared since was never injected at all. Both
  // would otherwise contribute nothing to a report that still looked complete.
  // The frame list is re-read for the same reason.
  //
  // Ceiling: a frame that navigates between this check and the run below is
  // still missed. The window is microseconds rather than the length of the
  // slowest injection, but it cannot be closed from outside the page.
  const frameIds = new Map<playwright.Frame, number>();
  const frameId = (frame: playwright.Frame) => {
    if (!frameIds.has(frame))
      frameIds.set(frame, frameIds.size);
    return frameIds.get(frame)!;
  };
  let previousSignature: string | undefined;
  for (let round = 0; round < 4; round++) {
    const children = page.frames().filter(frame => frame !== mainFrame);
    const covered = await withConcurrency(children, frame => hasReachableAxe(frame, token));
    const withoutAxe = new Set(children.filter((_, index) => !covered[index]));

    // A frame whose own injection succeeded is still unreachable when an ancestor
    // has no Axe: the top-level run reaches a nested document only by relaying
    // through the frames above it, and a frame without Axe relays nothing.
    const missed = children.filter(frame => {
      for (let current: playwright.Frame | null = frame; current && current !== mainFrame; current = current.parentFrame()) {
        if (withoutAxe.has(current))
          return true;
      }
      return false;
    });
    const matches = await withConcurrency(missed, frame => isFrameInScope(frame, mainFrame, include, exclude));
    const inScope = new Map(missed.map((frame, index) => [frame, matches[index]]));
    const latest = page.frames().filter(frame => frame !== mainFrame);
    const attached = new Set(latest);
    const signature = `${children.map((frame, index) => `${frameId(frame)}:${covered[index] ? 1 : 0}:${inScope.get(frame) ? 1 : 0}`).join(',')}>${latest.map(frameId).join(',')}`;
    const reported = missed.filter(frame => attached.has(frame) && inScope.get(frame)).map(describeFrame);

    const unchanged = children.length === latest.length && children.every((frame, index) => frame === latest[index]);
    if (!unchanged) {
      previousSignature = undefined;
      continue;
    }
    // A healthy, unchanged frame tree had no slow scope probes to race with.
    if (!missed.length)
      return [];
    if (signature === previousSignature)
      return reported;
    previousSignature = signature;
  }
  throw new Error('The frame tree kept changing while Axe coverage was checked. Retry the scan once the page settles.');
}

async function hasReachableAxe(frame: playwright.Frame, token: string): Promise<boolean> {
  if (!await hasAxe(frame, token))
    return false;
  const elementPromise = frame.frameElement().catch(() => null);
  const element = await withFrameTimeout(elementPromise, null);
  if (!element) {
    void elementPromise.then(late => late?.dispose().catch(() => {}));
    return false;
  }
  let reachable: boolean;
  try {
    reachable = await withFrameTimeout(element.evaluate(node => {
      for (let current = node as Element; ;) {
        const root = current.getRootNode();
        if (!(root instanceof ShadowRoot))
          return true;
        if (root.host.shadowRoot !== root)
          return false;
        current = root.host;
      }
    }), false);
  } finally {
    await element.dispose().catch(() => {});
  }
  return reachable && await hasAxe(frame, token);
}

// Runs in the page. Keeps axe's own result shape minus the parts nothing reads:
// per-node check arrays, and the node lists of passing/inapplicable rules.
async function runAxeInPage({ context, options }: { context: unknown, options: unknown }) {
  const results = await (window as any).axe.run(context ?? document, options);
  const findings = (rules: any[]) => rules.map(rule => ({
    id: rule.id,
    impact: rule.impact,
    tags: rule.tags,
    help: rule.help,
    helpUrl: rule.helpUrl,
    description: rule.description,
    nodes: rule.nodes.map((node: any) => ({
      target: node.target,
      html: node.html,
      failureSummary: node.failureSummary ?? null,
    })),
  }));
  return {
    url: results.url,
    violations: findings(results.violations),
    incomplete: findings(results.incomplete),
    passes: results.passes.map((rule: any) => ({ id: rule.id })),
    inapplicable: results.inapplicable.map((rule: any) => ({ id: rule.id })),
  };
}

export async function runAxeScan(page: playwright.Page, options: AxeScanOptions = {}): Promise<AxeScanResult> {
  const rules = assertRuleOptionsValid(options);
  const include = options.include ?? [];
  const exclude = options.exclude ?? [];
  await assertScopeSelectorsResolve(page, include, exclude);

  // `runOnly` holds either a rule list or a tag list, never both. Explicit rule
  // ids are the more specific request, so they win over tags — and the per-rule
  // `enabled` flag disableRules would set is ignored on that branch, which is
  // why assertRuleOptionsValid already subtracted them from the list.
  const axeOptions: Record<string, unknown> = rules.length
    ? { runOnly: { type: 'rule', values: rules } }
    : { runOnly: { type: 'tag', values: [...(options.tags ?? defaultAxeTags)] } };
  if (!rules.length && options.disableRules?.length)
    axeOptions.rules = Object.fromEntries(options.disableRules.map(rule => [rule, { enabled: false }]));

  // exclude wins over include for overlapping subtrees, which is what "scan
  // this component minus the widget" needs.
  const context = include.length || exclude.length ? { include: [...include], exclude: [...exclude] } : null;

  const unscannedFrames = await injectAxeIntoFrames(page, include, exclude);
  const results = await page.evaluate(runAxeInPage, { context, options: axeOptions }) as AxeScanResult;
  return { ...results, unscannedFrames };
}

// A scan that could not reach a frame covered less than it looks like it did,
// so every tool that reports results says so in the same words.
export function unscannedFrameLines(unscannedFrames: string[]): string[] {
  if (!unscannedFrames.length)
    return [];
  return [
    '',
    `WARNING: Axe could not be installed in ${unscannedFrames.length} frame(s), whose contents were not scanned and contribute no findings above:`,
    ...unscannedFrames.map(url => `- ${url}`),
    'A frame that is still loading may succeed on a re-run; one that consistently fails must be audited on its own.',
  ];
}

/** @public */
export function dedupeAxeNodes(nodes: AxeNode[]): AxeNode[] {
  const seen = new Set<string>();
  return nodes.filter(node => {
    // The JSON-encoded target is self-delimiting, so appending the raw HTML
    // keeps the key unambiguous without serializing a wrapper object.
    const key = `${JSON.stringify(node.target ?? [])}|${node.html ?? ''}`;
    if (seen.has(key))
      return false;
    seen.add(key);
    return true;
  });
}

/** @public */
export function trimAxeResults(
  violations: AxeViolation[],
  options: { maxNodesPerViolation: number; dedupe?: boolean }
): AxeViolation[] {
  // Callers that already deduped node lists can pass `dedupe: false` to skip a
  // redundant second dedup pass over potentially large node sets.
  const shouldDedupe = options.dedupe ?? true;
  return violations.map(violation => ({
    ...violation,
    nodes: (shouldDedupe ? dedupeAxeNodes(violation.nodes) : violation.nodes).slice(0, options.maxNodesPerViolation),
  }));
}

// Dedupe once and reuse: callers need the deduped nodes for per-rule counting
// and aggregation, and the trimmed copy for the report payload.
export function prepareAxeResults(
  violations: AxeViolation[],
  maxNodesPerViolation: number
): { deduped: AxeViolation[]; trimmed: AxeViolation[] } {
  const deduped = violations.map(violation => ({
    ...violation,
    nodes: dedupeAxeNodes(violation.nodes),
  }));
  return { deduped, trimmed: trimAxeResults(deduped, { maxNodesPerViolation, dedupe: false }) };
}

export function summarizeAxeViolations(violations: AxeViolation[]) {
  const byImpact: Record<string, number> = {};
  const byRuleId: Record<string, number> = {};
  let totalNodes = 0;

  for (const violation of violations) {
    const impact = violation.impact ?? 'unknown';
    const nodeCount = violation.nodes.length;
    byImpact[impact] = (byImpact[impact] ?? 0) + nodeCount;
    byRuleId[violation.id] = (byRuleId[violation.id] ?? 0) + nodeCount;
    totalNodes += nodeCount;
  }

  return {
    totalRules: violations.length,
    totalNodes,
    byImpact,
    byRuleId,
  };
}
