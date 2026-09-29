import RE2 from 're2';
import coreBundle from 'playwright-core/lib/coreBundle';
import type { FullConfig } from '../config.js';
import { z } from 'zod';
import { defineTabTool } from './tool.js';
import { writeJsonReport } from './report.js';
import { TabEvents, type Tab } from '../tab.js';
import { truncateDataUrls } from '../utils/dataUrl.js';
import { safeIsoTimestampForFileName } from '../utils/fileUtils.js';
import { logUnhandledError } from '../utils/log.js';
import {
  assertRuleOptionsValid,
  axeRuleSchemaShape,
  axeScanOptions,
  axeScanSchemaShape,
  axeScopeSchemaShape,
  prepareAxeResults,
  runAxeScan,
  summarizeAxeViolations,
  unscannedFrameLines,
  type AxeViolation,
} from './axe.js';

type CrawlStrategy = 'links' | 'nav' | 'sitemap' | 'provided';

type CrawlItem = {
  url: string;
  cookieUrl: string;
  depth: number;
  discoveredFrom: string | null;
  // Set when a dialog from the previous page cut this item's navigation short.
  retriedAfterOutgoingDialog?: boolean;
};

type PageScanStatus = 'scanned' | 'error';

type PageReport = {
  url: string;
  title: string;
  depth: number;
  discoveredFrom: string | null;
  status: PageScanStatus;
  error: string | null;
  summary: ReturnType<typeof summarizeAxeViolations> | null;
  violations: AxeViolation[];
  incomplete: AxeViolation[];
  // Frames Axe never reached on this page, so a page with no violations is
  // distinguishable from a page that was only partly scanned.
  unscannedFrames: string[];
};

type SummaryViolation = {
  id: string;
  impact: AxeViolation['impact'];
  tags: string[];
  help: string;
  helpUrl: string;
  description: string;
  pagesAffected: string[];
  totalOccurrences: number;
  uniqueOccurrences: number;
  sampleNodes: {
    pageUrl: string;
    target: AxeViolation['nodes'][number]['target'];
    html: string;
    failureSummary: string | null;
  }[];
};

type SummaryReport = {
  totals: {
    scannedPages: number;
    erroredPages: number;
    skippedUrls: number;
    queuedUrls: number;
  };
  violations: SummaryViolation[];
  incomplete: SummaryViolation[];
};

type ViolationSummaryAggregate = {
  id: string;
  impact: AxeViolation['impact'];
  tags: string[];
  help: string;
  helpUrl: string;
  description: string;
  pagesAffected: Set<string>;
  totalOccurrences: number;
  fingerprints: Set<string>;
  sampleNodes: SummaryViolation['sampleNodes'];
};

const defaultIgnoreQueryParams = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
];

const defaultExcludePathPatterns = [
  'logout|signout',
];

const maxExcludeRegexPatternLength = 200;

const impactPriority: Record<string, number> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
  unknown: 4,
};

const crawlStrategySchema = z.enum(['links', 'nav', 'sitemap', 'provided']);

const auditSiteSchema = z.object({
  startUrl: z.string().optional().describe('URL to start the crawl from. Defaults to the current tab URL.'),
  strategy: crawlStrategySchema.default('links').describe('How to discover pages to scan.'),
  urls: z.array(z.string()).optional().describe('Explicit URL list when strategy is "provided".'),
  sitemapUrl: z.string().optional().describe('URL of the sitemap to fetch when strategy is "sitemap".'),
  maxPages: z.number().int().min(1).max(200).default(25).describe('Maximum pages to scan.'),
  maxDepth: z.number().int().min(0).max(5).default(2).describe('Maximum crawl depth for link strategy.'),
  sameOriginOnly: z.boolean().default(true).describe('Restrict crawl to the start origin/host.'),
  includeSubdomains: z.boolean().default(false).describe('Only applies when sameOriginOnly=true. When enabled, also allows subdomains of the start host (e.g. blog.example.com when start host is example.com). Ignored when sameOriginOnly=false.'),
  excludePathPatterns: z.array(z.string()).default(defaultExcludePathPatterns).describe('Regex patterns applied to pathname+query. Avoid complex nested quantifiers to prevent performance issues.'),
  ignoreQueryParams: z.array(z.string()).default(defaultIgnoreQueryParams).describe('Query parameters dropped during URL normalization.'),
  includeIncomplete: z.boolean().default(true).describe('Also collect Axe "incomplete" results — checks Axe could not decide automatically. They are reported separately from violations.'),
  waitAfterNavigationMs: z.number().int().min(0).max(5000).default(250).describe('Extra wait after navigation before scanning.'),
  ...axeScanSchemaShape,
  ...axeScopeSchemaShape,
  ...axeRuleSchemaShape,
}).superRefine((value, context) => {
  if (value.strategy === 'provided' && (!value.urls || !value.urls.length)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['urls'],
      message: 'urls is required when strategy="provided"',
    });
  }
});

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// 32-bit FNV-1a hash; gives occurrence dedup a fixed-size key so the
// per-violation fingerprint sets do not retain full HTML strings.
function fastFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function isAllowedByOrigin(candidate: URL, startUrl: URL, sameOriginOnly: boolean, includeSubdomains: boolean): boolean {
  if (!sameOriginOnly)
    return true;
  if (!includeSubdomains)
    return candidate.origin === startUrl.origin;
  const hostMatch = candidate.hostname === startUrl.hostname || candidate.hostname.endsWith(`.${startUrl.hostname}`);
  return hostMatch && candidate.protocol === startUrl.protocol;
}

function buildExcludePathPatterns(patterns: string[]): RE2[] {
  return patterns.map((pattern, index) => {
    if (pattern.length > maxExcludeRegexPatternLength)
      throw new Error(`excludePathPatterns[${index}] is too long (${pattern.length}). Maximum supported length is ${maxExcludeRegexPatternLength}.`);
    try {
      return new RE2(pattern, 'i');
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid regex in excludePathPatterns[${index}] ("${pattern}"): ${errorText}`);
    }
  });
}

function parseStartUrl(startUrlInput: string | undefined, activeTabUrl: string): URL {
  const startUrlValue = startUrlInput ?? activeTabUrl;
  let startUrl: URL;
  try {
    startUrl = new URL(startUrlValue);
  } catch {
    throw new Error(`Invalid start URL "${startUrlValue}". Provide params.startUrl with an absolute http(s) URL or navigate the active tab (currently "${activeTabUrl}") first.`);
  }
  if (startUrl.protocol !== 'http:' && startUrl.protocol !== 'https:')
    throw new Error(`Start URL must use http:// or https://. Received "${startUrlValue}" (active tab: "${activeTabUrl}").`);
  return startUrl;
}

function inferStartUrlFromProvidedUrls(urls: string[] | undefined): string | undefined {
  for (const rawUrl of urls ?? []) {
    try {
      const candidate = new URL(rawUrl);
      if (candidate.protocol === 'http:' || candidate.protocol === 'https:')
        return candidate.toString();
    } catch {
      // Ignore invalid entries here; validation happens when enqueueing URLs.
    }
  }
  return undefined;
}


function isExcludedByPath(candidate: URL, excludePatterns: RE2[]): boolean {
  const value = `${candidate.pathname}${candidate.search}`;
  return excludePatterns.some(pattern => pattern.test(value));
}

function normalizeUrl(rawUrl: string, baseUrl: URL, ignoredParams: Set<string>): URL | null {
  let url: URL;
  try {
    url = new URL(rawUrl, baseUrl);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return null;

  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (ignoredParams.has(key.toLowerCase()))
      url.searchParams.delete(key);
  }

  const sortedParams = [...url.searchParams.entries()].sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0));
  url.search = '';
  for (const [key, value] of sortedParams)
    url.searchParams.append(key, value);

  return url;
}

/**
 * Cookies the crawled URLs would actually send, keyed by name + domain + path and
 * mapped to the name and expiry needed to report on them. Scoping to the crawl URLs
 * keeps an unrelated origin's expiring cookie from raising a false alarm, and keying
 * on the full identity stops a same-named cookie elsewhere from masking a deleted one.
 * Values are deliberately not compared: a rotating CSRF token is not a lost session.
 * Ceiling: a session cookie scoped to a path below the crawl URLs is not tracked.
 */
async function readCrawlCookies(page: import('playwright').Page, urls: string[]): Promise<Map<string, { name: string, expires: number }>> {
  const cookies = await page.context().cookies(urls);
  return new Map(cookies.map(cookie => [`${cookie.name}\n${cookie.domain}\n${cookie.path}`, { name: cookie.name, expires: cookie.expires }]));
}

/**
 * Baseline cookies the context no longer carries, or null when nothing is missing.
 *
 * A cookie whose own expiry has already passed was deleted by the clock rather than
 * by the site, so it is not a lost session: Cloudflare's `__cf_bm` lives 30 minutes
 * and would otherwise warn on any longer crawl. Cookies are still not classified as
 * "authentication" ones — no cookie attribute marks that, and every proxy for it
 * (httpOnly, session scope) misfires both ways on real sites, which would turn a
 * false warning into a missed logout.
 *
 * A cookie read failure yields no loss: the context is gone, and aborting here would
 * throw away the pages already scanned along with the navigation error for this one.
 *
 * The identities of the missing cookies are returned so the caller can drop them
 * from the baseline: each cookie is reported once, at the URL where it vanished,
 * and monitoring continues afterwards — an analytics cookie expiring early in the
 * crawl must not mask the real session cookie being dropped ten pages later.
 */
async function findCookieLoss(
  page: import('playwright').Page,
  urls: string[],
  baseline: Map<string, { name: string, expires: number }>,
  requestedUrl: string,
  urlBeforeNavigation: string
): Promise<{ url: string, cookies: string[], identities: string[] } | null> {
  const current = await readCrawlCookies(page, urls).catch(() => null);
  if (!current)
    return null;
  const now = Date.now();
  const missing = [...baseline]
      .filter(([identity, cookie]) => !current.has(identity) && !(cookie.expires > 0 && cookie.expires * 1000 <= now));
  if (!missing.length)
    return null;
  // The page reached after redirects is the one that dropped the cookie, and the one
  // worth excluding; the queued URL may only have pointed at it. A navigation that
  // never committed leaves the tab on the previous page, which is innocent — there
  // the URL asked for is the one whose response dropped the cookie.
  const reachedUrl = page.url();
  const url = !reachedUrl || reachedUrl === urlBeforeNavigation ? requestedUrl : reachedUrl;
  return {
    url,
    cookies: [...new Set(missing.map(([, cookie]) => cookie.name))],
    identities: missing.map(([identity]) => identity),
  };
}

/**
 * Title and outgoing links in one round trip: both are wanted for every crawled
 * page, and a second evaluate per page is pure latency on a 200-page crawl.
 * `linkSelector` is empty when this page contributes no links (depth exhausted,
 * or a strategy that only reads the entry page).
 */
async function readPage(page: import('playwright').Page, linkSelector: string): Promise<{ title: string, links: string[] }> {
  return await page.evaluate(selector => ({
    title: document.title,
    links: selector
      ? Array.from(document.querySelectorAll<HTMLAnchorElement>(selector))
          .map(anchor => anchor.href)
          .filter(Boolean)
      : [],
  }), linkSelector);
}

const allLinksSelector = 'a[href]';
const navLinksSelector = 'nav a[href], header a[href], [role="navigation"] a[href]';

async function extractSitemapUrls(sitemapUrl: string, validateUrl: (input: string, base: URL) => string): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    for (let redirects = 0; ; redirects++) {
      const response = await fetch(sitemapUrl, { redirect: 'manual', signal: controller.signal, credentials: 'omit' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects >= 20)
          throw new Error('Sitemap redirect is missing Location or exceeds 20 redirects.');
        sitemapUrl = validateUrl(location, new URL(sitemapUrl));
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Failed to fetch sitemap ${sitemapUrl}: ${response.status} ${response.statusText}`);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body) {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 10 * 1024 * 1024)
            throw new Error('Sitemap exceeds the 10 MiB limit.');
          chunks.push(chunk);
        }
      }
      const xmlText = Buffer.concat(chunks).toString('utf8');
      return [...xmlText.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)]
          .map(match => match[1].replace('<![CDATA[', '').replace(']]>', '').trim()).filter(Boolean);
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function parseSitemapUrl(input: string, base: URL, startUrl: URL, sameOriginOnly: boolean, includeSubdomains: boolean, config: FullConfig): string {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    throw new Error(`Invalid sitemap URL "${input}".`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error(`Sitemap URL must use http:// or https://. Received "${input}".`);
  if (url.username || url.password)
    throw new Error('Sitemap URL must not contain credentials.');
  if (!isAllowedByOrigin(url, startUrl, sameOriginOnly, includeSubdomains))
    throw new Error(`Sitemap URL "${input}" is outside the allowed crawl scope (start origin ${startUrl.origin}).`);
  // Use the same glob matcher as context.route(), with block rules taking priority.
  const matches = (origin: string) => coreBundle.iso.urlMatches(undefined, url.href, `*://${origin}/**`);
  if (config.network.blockedOrigins?.some(matches) ||
      (config.network.allowedOrigins?.length && !config.network.allowedOrigins.some(matches)))
    throw new Error(`Sitemap URL "${input}" is blocked by the server network policy.`);
  return url.href;
}

function aggregateIntoSummary(
  summaryByRuleId: Map<string, ViolationSummaryAggregate>,
  violations: AxeViolation[],
  pageUrl: string
) {
  for (const violation of violations) {
    const existingSummary = summaryByRuleId.get(violation.id);
    const summary: ViolationSummaryAggregate = existingSummary ?? {
      id: violation.id,
      impact: violation.impact,
      tags: [...violation.tags],
      help: violation.help,
      helpUrl: violation.helpUrl,
      description: violation.description,
      pagesAffected: new Set<string>(),
      totalOccurrences: 0,
      fingerprints: new Set<string>(),
      sampleNodes: [],
    };
    summary.pagesAffected.add(pageUrl);
    summary.totalOccurrences += violation.nodes.length;

    for (const node of violation.nodes) {
      // The fingerprint set is scoped to one violation id, so the
      // normalized node HTML alone identifies a unique occurrence.
      const fingerprint = fastFingerprint(normalizeWhitespace(node.html ?? ''));
      if (summary.fingerprints.has(fingerprint))
        continue;
      summary.fingerprints.add(fingerprint);
      if (summary.sampleNodes.length < 3) {
        summary.sampleNodes.push({
          pageUrl,
          target: [...(node.target ?? [])],
          html: node.html ?? '',
          failureSummary: node.failureSummary ?? null,
        });
      }
    }

    summaryByRuleId.set(violation.id, summary);
  }
}

function toSortedSummaryViolations(summaryByRuleId: Map<string, ViolationSummaryAggregate>): SummaryViolation[] {
  return [...summaryByRuleId.values()].map(summary => ({
    id: summary.id,
    impact: summary.impact,
    tags: summary.tags,
    help: summary.help,
    helpUrl: summary.helpUrl,
    description: summary.description,
    pagesAffected: [...summary.pagesAffected],
    totalOccurrences: summary.totalOccurrences,
    uniqueOccurrences: summary.fingerprints.size,
    sampleNodes: summary.sampleNodes,
  })).sort((first, second) => {
    const firstImpact = impactPriority[first.impact ?? 'unknown'] ?? impactPriority.unknown;
    const secondImpact = impactPriority[second.impact ?? 'unknown'] ?? impactPriority.unknown;
    if (firstImpact !== secondImpact)
      return firstImpact - secondImpact;
    return second.pagesAffected.length - first.pagesAffected.length;
  });
}

function summarizeTopViolations(violations: SummaryViolation[], count: number): string[] {
  return violations
      .slice(0, count)
      .map(violation => `- ${violation.id} (${violation.impact ?? 'unknown'}): ${violation.pagesAffected.length} pages, ${violation.totalOccurrences} nodes`);
}

function sortScannedPagesByViolations(pages: PageReport[]): PageReport[] {
  return pages
      .filter(page => page.status === 'scanned')
      .sort((first, second) => (second.summary?.totalRules ?? 0) - (first.summary?.totalRules ?? 0));
}

function summarizeTopPages(sortedScannedPages: PageReport[], count: number): string[] {
  return sortedScannedPages
      .slice(0, count)
      .map(page => `- ${page.url}: ${page.summary?.totalRules ?? 0} violations, ${page.summary?.totalNodes ?? 0} nodes`);
}

/**
 * The crawl answers no dialog: it is not the crawl's to dismiss, and accepting an
 * alert or confirm would change what the page under audit does. A dialog freezes
 * its tab, though: navigation waits out the whole navigation timeout and a
 * `page.evaluate` never returns, so a page that opens one while it loads would
 * otherwise fail every later URL, or hang the crawl for good. The page is given up
 * on as soon as its dialog opens, and the crawl carries on in a fresh tab.
 */
function openDialog(tab: Tab) {
  return tab.modalStates().find(state => state.type === 'dialog');
}

function dialogFailure(description: string): Error {
  const named = truncateDataUrls(description);
  const shown = named.length > 200 ? `${named.slice(0, 200)}…` : named;
  return new Error(`The page opened a dialog that the crawl does not answer, so it was not audited: ${shown}`);
}

/**
 * Fails `guard`ed work the moment a dialog opens on the tab. The abandoned call
 * stays pending until the tab is closed, which rejects it; the race has already
 * taken a handler on it, so that rejection is not reported again.
 */
function watchForDialog(tab: Tab, requestedUrl: string) {
  let listener: ((state: { type: string, description: string }) => void) | undefined;
  let fired = false;
  // A document runs no script before it commits, so a dialog that opens before the
  // main frame commits a navigation comes from the outgoing document. Counted by
  // commit rather than compared by URL: a reload of the same URL commits too. A new
  // document commits only after its navigation response, and to that response's URL;
  // framenavigated alone also fires for a same-document change (pushState, a hash)
  // the outgoing page makes, before or after that response. Only the navigation the
  // crawl asked for counts, redirects included, not one the outgoing page started.
  let navigationResponse: import('playwright').Response | undefined;
  let committed = false;
  let raisedByOutgoingDocument = false;
  const withoutFragment = (url: string) => url.split('#')[0];
  const requested = withoutFragment(new URL(requestedUrl).href);
  const isRequestedNavigation = (request: import('playwright').Request) => {
    for (let hop: import('playwright').Request | null = request; hop; hop = hop.redirectedFrom()) {
      if (withoutFragment(hop.url()) === requested)
        return true;
    }
    return false;
  };
  const onResponse = (response: import('playwright').Response) => {
    const request = response.request();
    if (request.isNavigationRequest() && response.frame() === tab.page.mainFrame() && isRequestedNavigation(request))
      navigationResponse = response;
  };
  const isCommitUrl = (frameUrl: string, response: import('playwright').Response) =>
    frameUrl === response.url() || !!response.request().redirectedFrom() && withoutFragment(frameUrl) === response.url();
  const onFrameNavigated = (frame: import('playwright').Frame) => {
    // A terminal 3xx can commit a document too. Check the actual redirect chain
    // here, once any successor request exists, rather than excluding its status.
    // Crawl URLs carry no fragment, so a new document commits exactly at the
    // response URL; a hash change by an outgoing page already at that URL adds one.
    // Only a redirect's Location can add a fragment to the committed URL itself.
    if (frame === tab.page.mainFrame() && navigationResponse && !navigationResponse.request().redirectedTo() && isCommitUrl(frame.url(), navigationResponse))
      committed = true;
  };
  tab.page.on('framenavigated', onFrameNavigated);
  tab.page.on('response', onResponse);
  const failed = new Promise<never>((_, reject) => {
    const present = openDialog(tab);
    if (present) {
      fired = true;
      reject(dialogFailure(present.description));
      return;
    }
    listener = state => {
      if (state.type !== 'dialog')
        return;
      fired = true;
      raisedByOutgoingDocument = !committed;
      reject(dialogFailure(state.description));
    };
    tab.on(TabEvents.modalState, listener);
  });
  // A dialog can open while nothing is being guarded; the next guard still sees it.
  failed.catch(() => {});
  return {
    guard: <T>(work: Promise<T>): Promise<T> => Promise.race([work, failed]),
    /** A dialog opened: work on the tab may have been abandoned mid-call. */
    fired: () => fired,
    /** True when the dialog came from the document being navigated away from. */
    raisedByOutgoingDocument: () => raisedByOutgoingDocument,
    stop: () => {
      tab.page.off('framenavigated', onFrameNavigated);
      tab.page.off('response', onResponse);
      if (listener)
        tab.off(TabEvents.modalState, listener);
    },
  };
}

const auditSite = defineTabTool({
  capability: 'core',
  schema: {
    name: 'audit_site',
    title: 'Audit multiple pages',
    description: 'Crawl internal pages and aggregate accessibility violations across the site.',
    inputSchema: auditSiteSchema,
    type: 'destructive',
  },

  handle: async (tab, params, response) => {
    // Rule ids apply to the whole run, so a bad one must fail before any tab is
    // opened or any URL visited; leaving it to the per-page scan would crawl the
    // entire site and write a "completed" report of nothing but errored pages.
    assertRuleOptionsValid({ rules: params.withRules, disableRules: params.disableRules });

    const context = tab.context;
    const reportFileName = params.reportFile ?? `audit-site-${safeIsoTimestampForFileName()}.json`;
    const reportPath = await context.outputFile(reportFileName, params.reportFile !== undefined);
    if (params.reportFile !== undefined)
      response.deleteFileOnError(reportPath);
    const originalTab = tab;
    const queue: CrawlItem[] = [];
    const queued = new Set<string>();
    const visited = new Set<string>();
    const pages: PageReport[] = [];
    let skippedUrls = 0;
    let erroredPages = 0;

    const scanStartedAt = Date.now();
    const startedAtIso = new Date(scanStartedAt).toISOString();
    const activeTabUrl = originalTab.page.url();
    const inferredStartUrl = !params.startUrl && params.strategy === 'provided'
      ? inferStartUrlFromProvidedUrls(params.urls)
      : undefined;
    const startUrl = parseStartUrl(params.startUrl ?? inferredStartUrl, activeTabUrl);
    const ignoredParams = new Set(params.ignoreQueryParams.map(param => param.toLowerCase()));
    const excludePatterns = buildExcludePathPatterns(params.excludePathPatterns);

    const summaryByViolation = new Map<string, ViolationSummaryAggregate>();
    const summaryByIncomplete = new Map<string, ViolationSummaryAggregate>();

    const enqueueUrl = (rawUrl: string, depth: number, discoveredFrom: string | null) => {
      const normalizedUrl = normalizeUrl(rawUrl, startUrl, ignoredParams);
      if (!normalizedUrl) {
        skippedUrls++;
        return;
      }

      // Cookie matching is path-boundary aware, so the cookie scope URL keeps
      // the trailing slash that crawl-key normalization strips below.
      const cookieUrl = normalizedUrl.toString();
      if (normalizedUrl.pathname !== '/' && normalizedUrl.pathname.endsWith('/'))
        normalizedUrl.pathname = normalizedUrl.pathname.slice(0, -1);

      if (!isAllowedByOrigin(normalizedUrl, startUrl, params.sameOriginOnly, params.includeSubdomains)) {
        skippedUrls++;
        return;
      }

      if (isExcludedByPath(normalizedUrl, excludePatterns)) {
        skippedUrls++;
        return;
      }

      const normalizedUrlString = normalizedUrl.toString();
      if (visited.has(normalizedUrlString) || queued.has(normalizedUrlString)) {
        skippedUrls++;
        return;
      }

      if (queue.length + visited.size >= params.maxPages) {
        skippedUrls++;
        return;
      }

      queue.push({
        url: normalizedUrlString,
        cookieUrl,
        depth,
        discoveredFrom,
      });
      queued.add(normalizedUrlString);
    };

    if (params.strategy === 'provided') {
      for (const url of params.urls ?? [])
        enqueueUrl(url, 0, null);
    } else if (params.strategy === 'sitemap') {
      if (context.config.browser.remoteEndpoint || context.config.browser.cdpEndpoint || ('name' in context.options.browserContextFactory && context.options.browserContextFactory.name === 'vscode'))
        throw new Error('Sitemap fetches run on the MCP host and do not support remoteEndpoint, cdpEndpoint, or browser_connect providers. Use the provided URL strategy with an attached browser.');
      if (context.config.browser.launchOptions.proxy || context.config.browser.contextOptions.proxy)
        throw new Error('Sitemap fetches do not support browser proxies. Use the provided URL strategy when a proxy is required.');
      const validateUrl = (input: string, base: URL) => parseSitemapUrl(input, base, startUrl, params.sameOriginOnly, params.includeSubdomains, context.config);
      const sitemapUrl = validateUrl(params.sitemapUrl ?? new URL('sitemap.xml', startUrl).toString(), startUrl);
      const sitemapUrls = await extractSitemapUrls(sitemapUrl, validateUrl);
      for (const url of sitemapUrls)
        enqueueUrl(url, 0, sitemapUrl);
    } else {
      enqueueUrl(startUrl.toString(), 0, null);
    }

    await response.reportProgress({
      progress: 0,
      total: params.maxPages,
      message: `Initialized site audit with ${queue.length} queued URL(s).`,
    });

    let crawlTab = await context.newTab();
    // Crawl tabs given up on because a dialog froze them; each is closed, and the
    // sweep below covers one whose close failed.
    const retiredTabs: Tab[] = [];
    let crawlTabAbandoned = false;
    // Cookies the crawl URLs carry before the crawl are the session the caller
    // signed in with. If one disappears mid-crawl every later page is audited as a
    // signed-out user, which still looks like a clean run, so record where it happened.
    const cookieScopeUrls = queue.map(item => item.cookieUrl);
    const cookieScope = new Set(cookieScopeUrls);
    // The whole jar is snapshotted once, so a URL discovered mid-crawl can only
    // add identities that existed when the crawl started. Without this, a cookie
    // minted by an earlier crawled page would enter the baseline at discovery
    // and its later removal would be misreported as losing a crawl-start cookie.
    const initialCookieIdentities = new Set(
        (await crawlTab.page.context().cookies().catch(() => []))
            .map(cookie => `${cookie.name}\n${cookie.domain}\n${cookie.path}`));
    const baselineCookies = await readCrawlCookies(crawlTab.page, cookieScopeUrls);
    const sessionLosses: { url: string, cookies: string[] }[] = [];
    // The first URL audited in each replacement crawl tab.
    const crawlTabRestarts: { url: string }[] = [];
    let processedPages = 0;
    try {
      while (queue.length && pages.length < params.maxPages) {
        const item = queue.shift()!;
        queued.delete(item.url);
        if (visited.has(item.url)) {
          skippedUrls++;
          continue;
        }
        visited.add(item.url);

        const pageReport: PageReport = {
          url: item.url,
          title: '',
          depth: item.depth,
          discoveredFrom: item.discoveredFrom,
          status: 'error',
          error: null,
          summary: null,
          violations: [],
          incomplete: [],
          unscannedFrames: [],
        };
        pages.push(pageReport);

        // URLs discovered mid-crawl join cookie tracking before they are visited:
        // a session cookie scoped below the start URL (say /app, discovered from /)
        // is invisible to the start-URL baseline, so deleting it later would
        // otherwise never raise a warning. Read before navigating — the visit
        // itself may be what drops the cookie. Only identities from the crawl-start
        // jar snapshot may join, so the warning's "present when the crawl started"
        // stays literally true. Ceiling: a crawl-start cookie deleted before its
        // scope URL is discovered is not seen by this live read and goes
        // unreported — accepted, because deciding which snapshot cookies apply to
        // a URL ourselves would reimplement browser cookie matching, and getting
        // that wrong turns into false session-loss warnings.
        if (!cookieScope.has(item.cookieUrl)) {
          cookieScope.add(item.cookieUrl);
          cookieScopeUrls.push(item.cookieUrl);
          const discovered = await readCrawlCookies(crawlTab.page, [item.cookieUrl]).catch(() => null);
          for (const [identity, cookie] of discovered ?? []) {
            if (initialCookieIdentities.has(identity) && !baselineCookies.has(identity))
              baselineCookies.set(identity, cookie);
          }
        }

        // A dialog the previous page left open freezes this tab for every later URL.
        // It goes, dialog and all, and the crawl continues in a new tab; the tab the
        // tool was called from is never touched. A tab whose dialog was answered
        // elsewhere (a headed or shared CDP browser) goes too: the navigation or scan
        // abandoned for that dialog may resume and race the next page.
        if (crawlTabAbandoned || openDialog(crawlTab)) {
          crawlTabAbandoned = false;
          const frozenTab = crawlTab;
          retiredTabs.push(frozenTab);
          crawlTab = await context.newTab();
          // A new tab starts without the old one's sessionStorage, so pages from here
          // on may run in a different session; the report says where that began.
          crawlTabRestarts.push({ url: item.url });
          // Best effort: closing a frozen page can time out, and that must not end
          // the crawl it was retired to rescue. The final sweep tries it again.
          const frozenIndex = context.tabs().indexOf(frozenTab);
          if (frozenIndex !== -1)
            await context.closeTab(frozenIndex).catch(logUnhandledError);
        }

        const urlBeforeNavigation = crawlTab.page.url();
        const dialogWatch = watchForDialog(crawlTab, item.url);
        let retryItem = false;
        try {
          await dialogWatch.guard(crawlTab.navigate(item.url));
          await dialogWatch.guard(crawlTab.waitForTimeout(params.waitAfterNavigationMs));

          // Discover before scanning. A scoped scan throws when an
          // includeSelectors entry is absent from this page, and that must not
          // silently drop every descendant reachable only through it.
          let linkSelector = '';
          if (params.strategy === 'links' && item.depth < params.maxDepth)
            linkSelector = allLinksSelector;
          else if (params.strategy === 'nav' && item.depth === 0)
            linkSelector = navLinksSelector;

          const { title, links } = await dialogWatch.guard(readPage(crawlTab.page, linkSelector));
          pageReport.title = title;
          for (const link of links)
            enqueueUrl(link, item.depth + 1, item.url);

          const axeResult = await dialogWatch.guard(runAxeScan(crawlTab.page, axeScanOptions(params)));
          const violations = prepareAxeResults(axeResult.violations, params.maxNodesPerViolation);

          pageReport.status = 'scanned';
          pageReport.unscannedFrames = axeResult.unscannedFrames;
          pageReport.violations = violations.trimmed;
          pageReport.summary = summarizeAxeViolations(violations.trimmed);
          aggregateIntoSummary(summaryByViolation, violations.deduped, item.url);

          if (params.includeIncomplete) {
            const incomplete = prepareAxeResults(axeResult.incomplete, params.maxNodesPerViolation);
            pageReport.incomplete = incomplete.trimmed;
            aggregateIntoSummary(summaryByIncomplete, incomplete.deduped, item.url);
          }
        } catch (error) {
          // A timer on the previous page can raise its dialog while this URL is
          // still loading, even a reload of the same URL. That is not this page's
          // dialog, so it is audited again,
          // once, in the fresh tab the abandoned one is replaced with.
          if (!item.retriedAfterOutgoingDialog && dialogWatch.raisedByOutgoingDocument()) {
            retryItem = true;
          } else {
            erroredPages++;
            pageReport.status = 'error';
            pageReport.error = error instanceof Error ? error.message : String(error);
          }
        } finally {
          dialogWatch.stop();
          crawlTabAbandoned = dialogWatch.fired();
          // Checked after failed navigations too: a logout URL that clears the cookie
          // and then times out still ended the session, and skipping it pins the
          // warning on the next page that happens to load — an innocent route.
          // Monitoring never stops at the first loss: reported cookies leave the
          // baseline, so each later disappearance is still caught and attributed
          // to its own URL instead of being masked by an earlier, unrelated one.
          if (baselineCookies.size) {
            // A retried page never loaded: the outgoing page that raised the dialog
            // is the one that ran in the meantime, so a loss is laid at its door.
            const loss = await findCookieLoss(crawlTab.page, cookieScopeUrls, baselineCookies, retryItem ? urlBeforeNavigation : item.url, urlBeforeNavigation);
            if (loss) {
              sessionLosses.push({ url: loss.url, cookies: loss.cookies });
              // Removed from the jar snapshot too, or a later-discovered URL
              // could re-admit an already-reported cookie to the baseline and
              // report the same loss twice.
              for (const identity of loss.identities) {
                baselineCookies.delete(identity);
                initialCookieIdentities.delete(identity);
              }
            }
          }
          if (retryItem) {
            // Not counted or reported: the page runs again next, in a fresh tab.
            pages.splice(pages.indexOf(pageReport), 1);
            visited.delete(item.url);
            queue.unshift({ ...item, retriedAfterOutgoingDialog: true });
            queued.add(item.url);
          } else {
            processedPages++;
            const message = pageReport.status === 'scanned'
              ? `Scanned page ${processedPages}/${params.maxPages}: ${item.url}`
              : `Failed page ${processedPages}/${params.maxPages}: ${item.url}`;
            await response.reportProgress({
              progress: processedPages,
              total: params.maxPages,
              message,
            });
          }
        }
      }
    } finally {
      // Each step is best effort, so one tab that will not close neither leaves
      // the others open nor keeps the caller's tab unselected, and cleanup never
      // discards the report built below. A tab left open still shows under Open tabs.
      for (const crawlOwnedTab of [crawlTab, ...retiredTabs]) {
        const crawlTabIndex = context.tabs().indexOf(crawlOwnedTab);
        if (crawlTabIndex !== -1)
          await context.closeTab(crawlTabIndex).catch(logUnhandledError);
      }
      const originalTabIndex = context.tabs().indexOf(originalTab);
      if (originalTabIndex !== -1)
        await context.selectTab(originalTabIndex).catch(logUnhandledError);
    }

    const summaryViolations = toSortedSummaryViolations(summaryByViolation);
    const summaryIncomplete = toSortedSummaryViolations(summaryByIncomplete);

    // A partly-scanned page reports fewer violations, and a reader counting them
    // must know which pages those numbers are incomplete for.
    const pagesWithUnscannedFrames = pages.filter(page => page.unscannedFrames.length);
    const scannedPagesByViolations = sortScannedPagesByViolations(pages);
    const summary: SummaryReport = {
      totals: {
        scannedPages: scannedPagesByViolations.length,
        erroredPages,
        skippedUrls,
        queuedUrls: visited.size,
      },
      violations: summaryViolations,
      incomplete: summaryIncomplete,
    };

    const report = {
      // v2: the singular `sessionLoss` object became the `sessionLosses` list,
      // so a consumer keying its parser on the version has a signal.
      version: 'v2',
      metadata: {
        startUrl: startUrl.toString(),
        strategy: params.strategy as CrawlStrategy,
        options: {
          maxPages: params.maxPages,
          maxDepth: params.maxDepth,
          sameOriginOnly: params.sameOriginOnly,
          includeSubdomains: params.includeSubdomains,
          excludePathPatterns: params.excludePathPatterns,
          ignoreQueryParams: params.ignoreQueryParams,
          violationsTag: params.violationsTag,
          includeIncomplete: params.includeIncomplete,
          includeSelectors: params.includeSelectors ?? null,
          excludeSelectors: params.excludeSelectors ?? null,
          withRules: params.withRules ?? null,
          disableRules: params.disableRules ?? null,
          maxNodesPerViolation: params.maxNodesPerViolation,
          waitAfterNavigationMs: params.waitAfterNavigationMs,
        },
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - scanStartedAt,
      },
      pages,
      summary,
      sessionLosses,
      crawlTabRestarts,
    };

    const reportResource = await writeJsonReport(response, reportPath, report, {
      name: 'audit-site-report',
      title: 'Audit site JSON report',
      description: 'Aggregated JSON report for the site accessibility crawl.',
    });
    response.setStructuredContent({
      kind: 'audit_site',
      // Mirrors the JSON report version: v2 replaced the singular sessionLoss
      // object with the sessionLosses list on both surfaces.
      version: 'v2',
      report: reportResource,
      crawl: {
        startUrl: report.metadata.startUrl,
        strategy: report.metadata.strategy,
        durationMs: report.metadata.durationMs,
      },
      totals: summary.totals,
      sessionLosses,
      crawlTabRestarts,
      pagesWithUnscannedFrames: pagesWithUnscannedFrames.map(page => ({
        url: page.url,
        unscannedFrames: page.unscannedFrames,
      })),
      topViolations: summaryViolations.slice(0, 5).map(violation => ({
        id: violation.id,
        impact: violation.impact ?? null,
        pagesAffected: violation.pagesAffected.length,
        totalOccurrences: violation.totalOccurrences,
        helpUrl: violation.helpUrl,
      })),
      topIncomplete: summaryIncomplete.slice(0, 5).map(item => ({
        id: item.id,
        impact: item.impact ?? null,
        pagesAffected: item.pagesAffected.length,
        totalOccurrences: item.totalOccurrences,
        helpUrl: item.helpUrl,
      })),
      topPages: scannedPagesByViolations
          .slice(0, 5)
          .map(page => ({
            url: page.url,
            title: page.title,
            totalViolations: page.summary?.totalRules ?? 0,
            totalNodes: page.summary?.totalNodes ?? 0,
          })),
    });

    const topViolations = summarizeTopViolations(summaryViolations, 10);
    const topIncomplete = summarizeTopViolations(summaryIncomplete, 10);
    const topPages = summarizeTopPages(scannedPagesByViolations, 20);
    const frameWarning = unscannedFrameLines(
        pagesWithUnscannedFrames.map(page => `${page.url}: ${page.unscannedFrames.join(', ')}`),
        { unit: 'page(s)', maxEntries: 10, trailingLines: [''] }
    );
    const sessionWarning = sessionLosses.length ? [
      ...sessionLosses.map(loss => `WARNING: cookie(s) ${loss.cookies.join(', ')} present when the crawl started disappeared while loading ${loss.url}.`),
      'If one of these was a session cookie, pages scanned after the URL that dropped it were audited as a signed-out user. Add that URL to excludePathPatterns, sign in again, and re-run.',
      '',
    ] : [];
    const restartWarning = crawlTabRestarts.length ? [
      ...crawlTabRestarts.map(restart => `WARNING: a dialog froze the crawl tab, so the crawl continued in a fresh tab from ${restart.url}.`),
      'Per-tab state such as sessionStorage from earlier pages was not carried over; if the site keeps its session there, pages from that URL on may have been audited in a different session.',
      '',
    ] : [];
    response.addCode('// Crawled pages in a temporary tab and aggregated Axe violations.');
    response.addResult([
      ...frameWarning,
      ...sessionWarning,
      ...restartWarning,
      `Scanned pages: ${summary.totals.scannedPages}`,
      `Errored pages: ${summary.totals.erroredPages}`,
      `Skipped URLs: ${summary.totals.skippedUrls}`,
      '',
      'Top violations by pages affected:',
      ...(topViolations.length ? topViolations : ['- None']),
      ...(params.includeIncomplete ? [
        '',
        'Top incomplete (needs review — verify these on the page):',
        ...(topIncomplete.length ? topIncomplete : ['- None']),
      ] : []),
      '',
      'Per-page summary (top 20 by violation count):',
      ...(topPages.length ? topPages : ['- None']),
      '',
      `JSON report: ${reportResource.path}`,
    ].join('\n'));
  },
});

export default [
  auditSite,
];
