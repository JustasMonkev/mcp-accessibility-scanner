import { createHash } from 'node:crypto';
import RE2 from 're2';
import coreBundle from 'playwright-core/lib/coreBundle';
import type { Page, Request, Response } from 'playwright';
import type { FullConfig } from '../config.js';
import { z } from 'zod';
import { defineTabTool } from './tool.js';
import { reserveReportPath, writeJsonReport } from './report.js';
import type { JsonReportResource } from './report.js';
import type { Response as ToolResponse } from '../response.js';
import { TabEvents, type Tab } from '../tab.js';
import { truncateDataUrls } from '../utils/dataUrl.js';
import { HtmlPatternGroups } from '../utils/htmlPatterns.js';
import { logUnhandledError } from '../utils/log.js';
import { errorMessage } from '../utils/errors.js';
import { isHttpUrl } from '../utils/httpUrl.js';
import { selectRepresentativeUrls } from '../utils/representativeUrls.js';
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

type CrawlItem = {
  url: string;
  cookieUrl: string;
  depth: number;
  discoveredFrom: string | null;
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
  similarPatterns: number;
  similarPatternsCapped: boolean;
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
  patterns: HtmlPatternGroups<SummaryViolation['sampleNodes'][number]>;
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

const maxSampleNodes = 3;
const maxSimilarPatterns = 50;
const maxGroupedOccurrences = 500;

const impactPriority: Record<string, number> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
  unknown: 4,
};

const crawlStrategySchema = z.enum(['links', 'nav', 'sitemap', 'provided']);
const pageSelectionSchema = z.enum(['discovery', 'representative']);

const auditSiteSchema = z.object({
  startUrl: z.string().optional().describe('URL to start the crawl from. Defaults to the current tab URL.'),
  strategy: crawlStrategySchema.default('links').describe('How to discover pages to scan.'),
  urls: z.array(z.string()).optional().describe('Explicit URL list when strategy is "provided".'),
  sitemapUrl: z.string().optional().describe('URL of the sitemap to fetch when strategy is "sitemap".'),
  maxPages: z.number().int().min(1).max(200).default(25).describe('Maximum pages to scan.'),
  maxDepth: z.number().int().min(0).max(5).default(2).describe('Maximum crawl depth for link strategy.'),
  pageSelection: pageSelectionSchema.default('discovery').describe('Which URLs fill maxPages when strategy is "sitemap" or "provided" lists more. "discovery" takes them in listed order; "representative" builds a tree of URL templates (host, path, query; id-like parts masked). Every branch of a group gets a page when its share of the budget covers its branches (so every top-level section is scanned when maxPages is at least their number); the rest go by exact k-median, which favors populous groups.'),
  sameOriginOnly: z.boolean().default(true).describe('Restrict crawl to the start origin/host.'),
  includeSubdomains: z.boolean().default(false).describe('Only applies when sameOriginOnly=true. Also allows subdomains of the start host on the same scheme and port.'),
  excludePathPatterns: z.array(z.string().min(1)).default(defaultExcludePathPatterns).describe('Nonempty RE2 regex patterns applied to pathname+query, up to 200 characters each. Backreferences and lookaround are not supported. Use [] to disable exclusions.'),
  ignoreQueryParams: z.array(z.string()).default(defaultIgnoreQueryParams).describe('Query parameters dropped during URL normalization.'),
  includeIncomplete: z.boolean().default(true).describe('Also collect Axe "incomplete" results — checks Axe could not decide automatically. They are reported separately from violations.'),
  waitAfterNavigationMs: z.number().int().min(0).max(5000).default(250).describe('Extra wait after navigation before scanning.'),
  concurrency: z.number().int().min(1).max(8).default(4).describe('Pages audited at the same time, each in its own temporary tab. Discovered links are queued in visit order, so the same pages are chosen as with 1. Use 1 when pages depend on sessionStorage set by earlier crawled pages, or to pin a lost session cookie on exactly one page.'),
  ...axeScanSchemaShape,
  ...axeScopeSchemaShape,
  ...axeRuleSchemaShape,
}).superRefine((value, context) => {
  if (value.strategy === 'provided' && (!value.urls || !value.urls.length)) {
    context.addIssue({
      code: 'custom',
      path: ['urls'],
      message: 'urls is required when strategy="provided"',
    });
  }
  if (value.pageSelection === 'representative' && value.strategy !== 'sitemap' && value.strategy !== 'provided') {
    context.addIssue({
      code: 'custom',
      path: ['pageSelection'],
      message: 'pageSelection="representative" requires strategy="sitemap" or strategy="provided"',
    });
  }
});

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isAllowedByOrigin(candidate: URL, startUrl: URL, sameOriginOnly: boolean, includeSubdomains: boolean): boolean {
  if (!sameOriginOnly)
    return true;
  if (!includeSubdomains)
    return candidate.origin === startUrl.origin;
  const hostMatch = candidate.hostname === startUrl.hostname || candidate.hostname.endsWith(`.${startUrl.hostname}`);
  return hostMatch && candidate.protocol === startUrl.protocol && candidate.port === startUrl.port;
}

function buildExcludePathPatterns(patterns: string[]): RE2[] {
  return patterns.map((pattern, index) => {
    if (pattern.length > maxExcludeRegexPatternLength)
      throw new Error(`excludePathPatterns[${index}] is too long (${pattern.length}). Maximum supported length is ${maxExcludeRegexPatternLength}.`);
    try {
      return new RE2(pattern, 'i');
    } catch (error) {
      throw new Error(`Invalid regex in excludePathPatterns[${index}] ("${pattern}"): ${errorMessage(error)}`);
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
  if (!isHttpUrl(startUrl))
    throw new Error(`Start URL must use http:// or https://. Received "${startUrlValue}" (active tab: "${activeTabUrl}").`);
  return startUrl;
}

function inferStartUrlFromProvidedUrls(urls: string[] | undefined): string | undefined {
  for (const rawUrl of urls ?? []) {
    try {
      const candidate = new URL(rawUrl);
      if (isHttpUrl(candidate))
        return candidate.toString();
    } catch {}
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

  if (!isHttpUrl(url))
    return null;

  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (ignoredParams.has(key.toLowerCase()))
      url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url;
}

type CrawlCookie = { name: string, expires: number };

function cookieIdentity(cookie: { name: string, domain: string, path: string }): string {
  return `${cookie.name}\n${cookie.domain}\n${cookie.path}`;
}

async function readCrawlCookies(page: Page, urls: string[]): Promise<Map<string, CrawlCookie>> {
  const cookies = await page.context().cookies(urls);
  return new Map(cookies.map(cookie => [cookieIdentity(cookie), { name: cookie.name, expires: cookie.expires }]));
}

async function findCookieLoss(
  page: Page,
  urls: string[],
  baseline: Map<string, CrawlCookie>,
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
  const reachedUrl = page.url();
  const url = !/^https?:\/\//i.test(reachedUrl) || reachedUrl === urlBeforeNavigation ? requestedUrl : reachedUrl;
  return {
    url,
    cookies: [...new Set(missing.map(([, cookie]) => cookie.name))],
    identities: missing.map(([identity]) => identity),
  };
}

async function readPage(page: Page, linkSelector: string): Promise<{ title: string, links: string[] }> {
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

const namedXmlEntities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function invalidSitemapEntityError(): Error {
  return new Error('Invalid XML entity in sitemap location.');
}

function isXmlCharacter(code: number): boolean {
  return code === 9 || code === 10 || code === 13
    || (code >= 0x20 && code <= 0xD7FF)
    || (code >= 0xE000 && code <= 0xFFFD)
    || (code >= 0x10000 && code <= 0x10FFFF);
}

function decodeXmlEntity(entity: string): string {
  if (Object.hasOwn(namedXmlEntities, entity))
    return namedXmlEntities[entity];
  if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity))
    throw invalidSitemapEntityError();
  const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
  if (!isXmlCharacter(code))
    throw invalidSitemapEntityError();
  return String.fromCodePoint(code);
}

function decodeSitemapLocation(value: string): string {
  const tokens = /<!\[CDATA\[|&([^&;]*);?/g;
  const parts: string[] = [];
  let copied = 0;
  for (let token = tokens.exec(value); token; token = tokens.exec(value)) {
    parts.push(value.slice(copied, token.index));
    if (token[0] === '<![CDATA[') {
      const end = value.indexOf(']]>', tokens.lastIndex);
      if (end === -1)
        throw new Error('Unterminated CDATA in sitemap location.');
      parts.push(value.slice(tokens.lastIndex, end));
      tokens.lastIndex = end + 3;
    } else {
      if (!token[0].endsWith(';'))
        throw invalidSitemapEntityError();
      parts.push(decodeXmlEntity(token[1]));
    }
    copied = tokens.lastIndex;
  }
  parts.push(value.slice(copied));
  return parts.join('');
}

const maxSitemapBytes = 10 * 1024 * 1024;

async function readSitemapBody(response: globalThis.Response): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > maxSitemapBytes)
      throw new Error('Sitemap exceeds the 10 MiB limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

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
      const xmlText = await readSitemapBody(response);
      for (const [, doctype, tag] of xmlText.matchAll(/<!--[\s\S]*?(?:-->|$)|<\?[\s\S]*?(?:\?>|$)|(<!DOCTYPE)(?=\s)|<(?:[\w.-]+:)?([a-z][\w.-]*)(?=[\s/>])/gi)) {
        if (doctype)
          throw new Error('Sitemap document type declarations are not supported. Pass a direct URL sitemap without a DOCTYPE or use the provided URL strategy.');
        if (!tag)
          continue;
        if (tag.toLowerCase() === 'sitemapindex')
          throw new Error('Sitemap indexes are not supported. Pass a direct URL sitemap in sitemapUrl or use the provided URL strategy.');
        break;
      }
      return [...xmlText.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)]
          .map(match => decodeSitemapLocation(match[1]).trim()).filter(Boolean);
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function parseSitemapUrl(input: string, base: URL, scope: CrawlScope, config: FullConfig): string {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    throw new Error(`Invalid sitemap URL "${input}".`);
  }
  if (!isHttpUrl(url))
    throw new Error(`Sitemap URL must use http:// or https://. Received "${input}".`);
  if (url.username || url.password)
    throw new Error('Sitemap URL must not contain credentials.');
  if (!scope.allowsOrigin(url))
    throw new Error(`Sitemap URL "${input}" is outside the allowed crawl scope (start origin ${scope.startUrl.origin}).`);
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
      patterns: new HtmlPatternGroups(maxSimilarPatterns, maxGroupedOccurrences),
    };
    summary.pagesAffected.add(pageUrl);
    summary.totalOccurrences += violation.nodes.length;

    for (const node of violation.nodes) {
      const normalizedHtml = normalizeWhitespace(node.html ?? '');
      const fingerprint = createHash('sha256').update(normalizedHtml, 'utf16le').digest('base64url');
      if (summary.fingerprints.has(fingerprint))
        continue;
      summary.fingerprints.add(fingerprint);
      summary.patterns.add(normalizedHtml, {
        pageUrl,
        target: [...(node.target ?? [])],
        html: node.html ?? '',
        failureSummary: node.failureSummary ?? null,
      });
    }

    summaryByRuleId.set(violation.id, summary);
  }
}

function toSortedSummaryViolations(summaryByRuleId: Map<string, ViolationSummaryAggregate>): SummaryViolation[] {
  return [...summaryByRuleId.values()].map(summary => {
    const patterns = summary.patterns.summarize(maxSampleNodes);
    return {
      id: summary.id,
      impact: summary.impact,
      tags: summary.tags,
      help: summary.help,
      helpUrl: summary.helpUrl,
      description: summary.description,
      pagesAffected: [...summary.pagesAffected],
      totalOccurrences: summary.totalOccurrences,
      uniqueOccurrences: summary.fingerprints.size,
      similarPatterns: patterns.count,
      similarPatternsCapped: patterns.capped,
      sampleNodes: patterns.samples,
    };
  }).sort((first, second) => {
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
      .map(violation => `- ${violation.id} (${violation.impact ?? 'unknown'}): ${violation.pagesAffected.length} pages, ${violation.totalOccurrences} nodes, ${violation.similarPatterns} ${violation.similarPatterns === 1 ? 'pattern' : 'patterns'}${violation.similarPatternsCapped ? ' (partial)' : ''}`);
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

function openDialog(tab: Tab) {
  return tab.modalStates().find(state => state.type === 'dialog');
}

function dialogFailure(description: string): Error {
  const named = truncateDataUrls(description);
  const shown = named.length > 200 ? `${named.slice(0, 200)}…` : named;
  return new Error(`The page opened a dialog that the crawl does not answer, so it was not audited: ${shown}`);
}

function watchForDialog(tab: Tab, requestedUrl: string) {
  let listener: ((state: { type: string, description: string }) => void) | undefined;
  let fired = false;
  let navigationResponse: Response | undefined;
  let committed = false;
  let raisedByOutgoingDocument = false;
  const hasOutgoingDocument = tab.page.url() !== 'about:blank';
  let navigationMayHaveStarted = false;
  const withoutFragment = (url: string) => url.split('#')[0];
  const requested = withoutFragment(new URL(requestedUrl).href);
  const isRequestedNavigation = (request: Request) => {
    for (let hop: Request | null = request; hop; hop = hop.redirectedFrom()) {
      if (withoutFragment(hop.url()) === requested)
        return true;
    }
    return false;
  };
  const onResponse = (response: Response) => {
    const request = response.request();
    if (request.isNavigationRequest() && response.frame() === tab.page.mainFrame() && isRequestedNavigation(request))
      navigationResponse = response;
  };
  tab.page.on('response', onResponse);
  const failed = new Promise<never>((_, reject) => {
    const present = openDialog(tab);
    if (present) {
      fired = true;
      raisedByOutgoingDocument = true;
      reject(dialogFailure(present.description));
      return;
    }
    listener = state => {
      if (state.type !== 'dialog')
        return;
      fired = true;
      raisedByOutgoingDocument = !navigationMayHaveStarted || (hasOutgoingDocument && !committed);
      reject(dialogFailure(state.description));
    };
    tab.on(TabEvents.modalState, listener);
  });
  failed.catch(() => {});
  const initScript = tab.page.addInitScript(({ onNewDocument }) => {
    if (window === window.top)
      void onNewDocument(location.href).catch(() => {});
  }, {
    onNewDocument: async (url: string) => {
      if (navigationResponse && !navigationResponse.request().redirectedTo() && withoutFragment(url) === withoutFragment(navigationResponse.url()))
        committed = true;
    },
  }, { exposeFunctions: true });
  return {
    ready: () => Promise.race([initScript.then(() => {
      navigationMayHaveStarted = true;
    }), failed]),
    guard: <T>(work: Promise<T>): Promise<T> => Promise.race([work, failed]),
    fired: () => fired,
    raisedByOutgoingDocument: () => raisedByOutgoingDocument,
    stop: async () => {
      if (!fired)
        await Promise.race([initScript.then(script => script.dispose()).catch(logUnhandledError), failed]).catch(() => {});
      tab.page.off('response', onResponse);
      if (listener)
        tab.off(TabEvents.modalState, listener);
    },
  };
}

type AuditSiteParams = z.output<typeof auditSiteSchema>;
type DiscoveredLinks = { links: string[], depth: number, discoveredFrom: string };

class CrawlScope {
  readonly startUrl: URL;
  private readonly _ignoredParams: Set<string>;
  private readonly _excludePatterns: RE2[];
  private readonly _params: AuditSiteParams;

  constructor(startUrl: URL, params: AuditSiteParams) {
    this.startUrl = startUrl;
    this._params = params;
    this._ignoredParams = new Set(params.ignoreQueryParams.map(param => param.toLowerCase()));
    this._excludePatterns = buildExcludePathPatterns(params.excludePathPatterns);
  }

  allowsOrigin(candidate: URL): boolean {
    return isAllowedByOrigin(candidate, this.startUrl, this._params.sameOriginOnly, this._params.includeSubdomains);
  }

  admit(rawUrl: string): string | null {
    const normalizedUrl = normalizeUrl(rawUrl, this.startUrl, this._ignoredParams);
    if (!normalizedUrl || !this.allowsOrigin(normalizedUrl) || isExcludedByPath(normalizedUrl, this._excludePatterns))
      return null;
    return normalizedUrl.toString();
  }
}

class CrawlFrontier {
  readonly queue: CrawlItem[] = [];
  readonly visited = new Set<string>();
  skippedUrls = 0;
  representativeSelection: { candidates: number, selected: number } | null = null;
  private readonly _queued = new Set<string>();
  private readonly _scope: CrawlScope;
  private readonly _maxPages: number;

  constructor(scope: CrawlScope, maxPages: number) {
    this._scope = scope;
    this._maxPages = maxPages;
  }

  enqueue(rawUrl: string, depth: number, discoveredFrom: string | null): void {
    const url = this._admitUnseen(rawUrl);
    if (!url)
      return;
    if (this.queue.length + this.visited.size >= this._maxPages) {
      this.skippedUrls++;
      return;
    }
    this.queue.push({ url, cookieUrl: url, depth, discoveredFrom });
    this._queued.add(url);
  }

  enqueueListed(rawUrls: string[], discoveredFrom: string | null, pageSelection: AuditSiteParams['pageSelection']): void {
    if (pageSelection !== 'representative') {
      for (const url of rawUrls)
        this.enqueue(url, 0, discoveredFrom);
      return;
    }
    const candidates = new Set<string>();
    for (const url of rawUrls) {
      const admitted = this._admitUnseen(url);
      if (!admitted)
        continue;
      if (candidates.has(admitted))
        this.skippedUrls++;
      else
        candidates.add(admitted);
    }
    const selected = selectRepresentativeUrls([...candidates], this._maxPages);
    this.skippedUrls += candidates.size - selected.length;
    for (const url of selected)
      this.enqueue(url, 0, discoveredFrom);
    this.representativeSelection = { candidates: candidates.size, selected: selected.length };
  }

  takeUnvisited(): CrawlItem | undefined {
    while (this.queue.length) {
      const item = this.queue.shift()!;
      this._queued.delete(item.url);
      if (!this.visited.has(item.url)) {
        this.visited.add(item.url);
        return item;
      }
      this.skippedUrls++;
    }
    return undefined;
  }

  private _admitUnseen(rawUrl: string): string | null {
    const url = this._scope.admit(rawUrl);
    if (!url || this.visited.has(url) || this._queued.has(url)) {
      this.skippedUrls++;
      return null;
    }
    return url;
  }
}

class OrderedLinkCommits {
  dequeued = 0;
  private _committed = 0;
  private readonly _pending = new Map<number, DiscoveredLinks>();
  private readonly _waiters: (() => void)[] = [];
  private readonly _onCommit: (discovered: DiscoveredLinks) => void;

  constructor(onCommit: (discovered: DiscoveredLinks) => void) {
    this._onCommit = onCommit;
  }

  get allCommitted(): boolean {
    return this._committed === this.dequeued;
  }

  commit(sequence: number, discovered: DiscoveredLinks): void {
    this._pending.set(sequence, discovered);
    for (let next = this._pending.get(this._committed); next; next = this._pending.get(this._committed)) {
      this._pending.delete(this._committed);
      this._committed++;
      this._onCommit(next);
    }
    this.wakeWaiters();
  }

  waitForCommit(): Promise<void> {
    return new Promise<void>(resolve => this._waiters.push(resolve));
  }

  wakeWaiters(): void {
    for (const wake of this._waiters.splice(0))
      wake();
  }
}

type SessionLoss = { url: string, cookies: string[], concurrentUrls?: string[] };

class SessionLossDetector {
  readonly losses: SessionLoss[] = [];
  private readonly _scopeUrls: string[];
  private readonly _scope: Set<string>;
  private readonly _initialIdentities: Set<string>;
  private readonly _baseline: Map<string, CrawlCookie>;
  private readonly _activeSinceCheck = new Map<number, string>();
  private readonly _inFlight = new Set<number>();
  private _checks: Promise<void> = Promise.resolve();

  private constructor(scopeUrls: string[], initialIdentities: Set<string>, baseline: Map<string, CrawlCookie>) {
    this._scopeUrls = scopeUrls;
    this._scope = new Set(scopeUrls);
    this._initialIdentities = initialIdentities;
    this._baseline = baseline;
  }

  static async create(page: Page, scopeUrls: string[]): Promise<SessionLossDetector> {
    const initialIdentities = new Set((await page.context().cookies().catch(() => [])).map(cookieIdentity));
    const baseline = await readCrawlCookies(page, scopeUrls);
    return new SessionLossDetector([...scopeUrls], initialIdentities, baseline);
  }

  async widenScope(page: Page, cookieUrl: string): Promise<void> {
    if (this._scope.has(cookieUrl))
      return;
    this._scope.add(cookieUrl);
    this._scopeUrls.push(cookieUrl);
    const discovered = await readCrawlCookies(page, [cookieUrl]).catch(() => null);
    for (const [identity, cookie] of discovered ?? []) {
      if (this._initialIdentities.has(identity) && !this._baseline.has(identity))
        this._baseline.set(identity, cookie);
    }
  }

  pageStarted(sequence: number, url: string): void {
    this._inFlight.add(sequence);
    this._activeSinceCheck.set(sequence, url);
  }

  pageFinished(sequence: number): void {
    this._inFlight.delete(sequence);
  }

  check(page: Page, sequence: number, requestedUrl: string, urlBeforeNavigation: string): Promise<void> {
    const check = this._checks.then(async () => {
      const activeDuringWindow = [...this._activeSinceCheck];
      if (this._baseline.size) {
        const loss = await findCookieLoss(page, [...this._scopeUrls], new Map(this._baseline), requestedUrl, urlBeforeNavigation);
        if (loss)
          this._recordLoss(loss, sequence);
      }
      for (const [other] of activeDuringWindow) {
        if (!this._inFlight.has(other))
          this._activeSinceCheck.delete(other);
      }
    });
    this._checks = check.catch(() => {});
    return check;
  }

  private _recordLoss(loss: { url: string, cookies: string[], identities: string[] }, sequence: number): void {
    const concurrentUrls = [...this._activeSinceCheck].filter(([other]) => other !== sequence).map(([, url]) => url);
    this.losses.push(concurrentUrls.length ? { url: loss.url, cookies: loss.cookies, concurrentUrls } : { url: loss.url, cookies: loss.cookies });
    for (const identity of loss.identities) {
      this._baseline.delete(identity);
      this._initialIdentities.delete(identity);
    }
  }
}

function assertSitemapFetchSupported(context: Tab['context']): void {
  const browser = context.config.browser;
  const factory = context.options.browserContextFactory;
  if (browser.remoteEndpoint || browser.cdpEndpoint || ('name' in factory && factory.name === 'vscode'))
    throw new Error('Sitemap fetches run on the MCP host and do not support remoteEndpoint, cdpEndpoint, or browser_connect providers. Use the provided URL strategy with an attached browser.');
  if (browser.launchOptions.proxy || browser.contextOptions.proxy)
    throw new Error('Sitemap fetches do not support browser proxies. Use the provided URL strategy when a proxy is required.');
}

async function seedFrontier(frontier: CrawlFrontier, scope: CrawlScope, params: AuditSiteParams, context: Tab['context']): Promise<void> {
  const startUrl = scope.startUrl;
  if (params.strategy === 'provided') {
    frontier.enqueueListed(params.urls ?? [], null, params.pageSelection);
    return;
  }
  if (params.strategy === 'sitemap') {
    assertSitemapFetchSupported(context);
    const validateUrl = (input: string, base: URL) => parseSitemapUrl(input, base, scope, context.config);
    const sitemapUrl = validateUrl(params.sitemapUrl ?? new URL('sitemap.xml', startUrl).toString(), startUrl);
    frontier.enqueueListed(await extractSitemapUrls(sitemapUrl, validateUrl), sitemapUrl, params.pageSelection);
    return;
  }
  frontier.enqueue(startUrl.toString(), 0, null);
}

function linkSelectorFor(params: AuditSiteParams, depth: number): string {
  if (params.strategy === 'links' && depth < params.maxDepth)
    return allLinksSelector;
  if (params.strategy === 'nav' && depth === 0)
    return navLinksSelector;
  return '';
}

function newPageReport(item: CrawlItem): PageReport {
  return {
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
}

type PageFindings = { violations: AxeViolation[], incomplete: AxeViolation[] | null };
type DialogWatch = ReturnType<typeof watchForDialog>;
type PageVisit = { tab: Tab, item: CrawlItem, report: PageReport, dialogWatch: DialogWatch };

async function scanCrawledPage({ tab, item, report, dialogWatch }: PageVisit, scope: CrawlScope, params: AuditSiteParams, commitLinks: (links: string[]) => void): Promise<PageFindings> {
  await dialogWatch.ready();
  await dialogWatch.guard(tab.navigate(item.url));
  await dialogWatch.guard(tab.waitForTimeout(params.waitAfterNavigationMs));

  const reachedUrl = tab.page.url();
  if (!scope.admit(reachedUrl))
    throw new Error(`Requested URL "${item.url}" reached "${truncateDataUrls(reachedUrl)}", which is outside the allowed crawl scope or matches excludePathPatterns. The destination was not audited.`);

  const { title, links } = await dialogWatch.guard(readPage(tab.page, linkSelectorFor(params, item.depth)));
  report.title = title;
  commitLinks(links);

  const axeResult = await dialogWatch.guard(runAxeScan(tab.page, axeScanOptions(params)));
  const violations = prepareAxeResults(axeResult.violations, params.maxNodesPerViolation);
  report.status = 'scanned';
  report.unscannedFrames = axeResult.unscannedFrames;
  report.violations = violations.trimmed;
  report.summary = summarizeAxeViolations(violations.deduped);

  if (!params.includeIncomplete)
    return { violations: violations.deduped, incomplete: null };
  const incomplete = prepareAxeResults(axeResult.incomplete, params.maxNodesPerViolation);
  report.incomplete = incomplete.trimmed;
  return { violations: violations.deduped, incomplete: incomplete.deduped };
}

async function closeTabIfOpen(context: Tab['context'], tab: Tab | undefined): Promise<void> {
  const index = tab ? context.tabs().indexOf(tab) : -1;
  if (index !== -1)
    await context.closeTab(index).catch(logUnhandledError);
}

function topSummaryEntries(violations: SummaryViolation[]) {
  return violations.slice(0, 5).map(violation => ({
    id: violation.id,
    impact: violation.impact ?? null,
    pagesAffected: violation.pagesAffected.length,
    totalOccurrences: violation.totalOccurrences,
    similarPatterns: violation.similarPatterns,
    similarPatternsCapped: violation.similarPatternsCapped,
    helpUrl: violation.helpUrl,
  }));
}

type SiteReportInput = {
  startUrl: URL,
  params: AuditSiteParams,
  scanStartedAt: number,
  pages: PageReport[],
  summary: SummaryReport,
  representativeSelection: CrawlFrontier['representativeSelection'],
  sessionLosses: SessionLoss[],
  crawlTabRestarts: { url: string }[],
};

function buildSiteReport({ startUrl, params, scanStartedAt, pages, summary, representativeSelection, sessionLosses, crawlTabRestarts }: SiteReportInput) {
  return {
    version: 'v2',
    metadata: {
      startUrl: startUrl.toString(),
      strategy: params.strategy,
      options: {
        maxPages: params.maxPages,
        maxDepth: params.maxDepth,
        pageSelection: params.pageSelection,
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
        concurrency: params.concurrency,
      },
      startedAt: new Date(scanStartedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - scanStartedAt,
    },
    pages,
    summary,
    representativeSelection,
    sessionLosses,
    crawlTabRestarts,
  };
}

function siteStructuredContent(report: ReturnType<typeof buildSiteReport>, reportResource: JsonReportResource, pagesWithUnscannedFrames: PageReport[], scannedPagesByViolations: PageReport[]) {
  return {
    kind: 'audit_site',
    version: 'v2',
    report: reportResource,
    crawl: {
      startUrl: report.metadata.startUrl,
      strategy: report.metadata.strategy,
      durationMs: report.metadata.durationMs,
    },
    totals: report.summary.totals,
    representativeSelection: report.representativeSelection,
    sessionLosses: report.sessionLosses,
    crawlTabRestarts: report.crawlTabRestarts,
    pagesWithUnscannedFrames: pagesWithUnscannedFrames.map(page => ({
      url: page.url,
      unscannedFrames: page.unscannedFrames,
    })),
    topViolations: topSummaryEntries(report.summary.violations),
    topIncomplete: topSummaryEntries(report.summary.incomplete),
    topPages: scannedPagesByViolations
        .slice(0, 5)
        .map(page => ({
          url: page.url,
          title: page.title,
          totalViolations: page.summary?.totalRules ?? 0,
          totalNodes: page.summary?.totalNodes ?? 0,
        })),
  };
}

function orNone(lines: string[]): string[] {
  return lines.length ? lines : ['- None'];
}

function renderSiteSummary(options: {
  pagesWithUnscannedFrames: PageReport[],
  sessionLosses: SessionLoss[],
  crawlTabRestarts: { url: string }[],
  representativeSelection: { candidates: number, selected: number } | null,
  summary: SummaryReport,
  scannedPagesByViolations: PageReport[],
  includeIncomplete: boolean,
  reportPath: string,
}): string {
  const { summary, sessionLosses, crawlTabRestarts, representativeSelection } = options;
  const frameWarning = unscannedFrameLines(
      options.pagesWithUnscannedFrames.map(page => `${page.url}: ${page.unscannedFrames.join(', ')}`),
      { unit: 'page(s)', maxEntries: 10, trailingLines: [''] }
  );
  const sessionWarning = sessionLosses.length ? [
    ...sessionLosses.map(loss => `WARNING: cookie(s) ${loss.cookies.join(', ')} present when the crawl started disappeared while loading ${loss.url}${loss.concurrentUrls ? `, or one of the pages loading at the same time: ${loss.concurrentUrls.join(', ')}` : ''}.`),
    'If one of these was a session cookie, pages scanned after the URL that dropped it were audited as a signed-out user. Add that URL to excludePathPatterns, sign in again, and re-run.',
    '',
  ] : [];
  const restartWarning = crawlTabRestarts.length ? [
    ...crawlTabRestarts.map(restart => `WARNING: a dialog froze the crawl tab, so the crawl continued in a fresh tab from ${restart.url}.`),
    'Per-tab state such as sessionStorage from earlier pages was not carried over; if the site keeps its session there, pages from that URL on may have been audited in a different session.',
    '',
  ] : [];
  return [
    ...frameWarning,
    ...sessionWarning,
    ...restartWarning,
    ...(representativeSelection ? [`Representative selection: queued ${representativeSelection.selected} of ${representativeSelection.candidates} listed URLs, spread across site sections and URL templates.`] : []),
    `Scanned pages: ${summary.totals.scannedPages}`,
    `Errored pages: ${summary.totals.erroredPages}`,
    `Skipped URLs: ${summary.totals.skippedUrls}`,
    '',
    'Top violations by pages affected:',
    ...orNone(summarizeTopViolations(summary.violations, 10)),
    ...(options.includeIncomplete ? [
      '',
      'Top incomplete (needs review — verify these on the page):',
      ...orNone(summarizeTopViolations(summary.incomplete, 10)),
    ] : []),
    '',
    'Per-page summary (top 20 by violation count):',
    ...orNone(summarizeTopPages(options.scannedPagesByViolations, 20)),
    '',
    `JSON report: ${options.reportPath}`,
  ].join('\n');
}

function requestedStartUrl(params: AuditSiteParams): string | undefined {
  if (params.startUrl !== undefined || params.strategy !== 'provided')
    return params.startUrl;
  return inferStartUrlFromProvidedUrls(params.urls);
}

type CrawlSetup = {
  context: Tab['context'];
  params: AuditSiteParams;
  scope: CrawlScope;
  frontier: CrawlFrontier;
  response: ToolResponse;
};

type CrawlWorker = { tab: Tab | undefined, abandoned: boolean };

class SiteCrawl {
  readonly pages: PageReport[] = [];
  readonly crawlTabRestarts: { url: string }[] = [];
  erroredPages = 0;
  private readonly _setup: CrawlSetup;
  private readonly _session: SessionLossDetector;
  private readonly _workers: CrawlWorker[];
  private readonly _retiredTabs: Tab[] = [];
  private readonly _pageFindings = new Map<PageReport, PageFindings>();
  private readonly _linkCommits: OrderedLinkCommits;
  private _processedPages = 0;
  private _stopped = false;

  static async open(setup: CrawlSetup): Promise<SiteCrawl> {
    const firstTab = await setup.context.newTab();
    const session = await SessionLossDetector.create(firstTab.page, setup.frontier.queue.map(item => item.cookieUrl));
    return new SiteCrawl(setup, firstTab, session);
  }

  private constructor(setup: CrawlSetup, firstTab: Tab, session: SessionLossDetector) {
    this._setup = setup;
    this._session = session;
    const workerCount = Math.min(setup.params.concurrency, setup.params.maxPages);
    this._workers = Array.from({ length: workerCount }, (_, index) => ({ tab: index === 0 ? firstTab : undefined, abandoned: false }));
    this._linkCommits = new OrderedLinkCommits(({ links, depth, discoveredFrom }) => {
      for (const link of links)
        setup.frontier.enqueue(link, depth, discoveredFrom);
    });
  }

  get sessionLosses(): SessionLoss[] {
    return this._session.losses;
  }

  async run(): Promise<void> {
    const failures: unknown[] = [];
    await Promise.all(this._workers.map(worker => this._runWorker(worker).catch(error => {
      failures.push(error);
      this._stopped = true;
      this._linkCommits.wakeWaiters();
    })));
    if (failures.length)
      throw failures[0];
  }

  async closeTabs(originalTab: Tab): Promise<void> {
    const { context } = this._setup;
    for (const crawlOwnedTab of [...this._workers.map(worker => worker.tab), ...this._retiredTabs])
      await closeTabIfOpen(context, crawlOwnedTab);
    const originalTabIndex = context.tabs().indexOf(originalTab);
    if (originalTabIndex !== -1)
      await context.selectTab(originalTabIndex).catch(logUnhandledError);
  }

  aggregatedFindings(): Pick<SummaryReport, 'violations' | 'incomplete'> {
    const violations = new Map<string, ViolationSummaryAggregate>();
    const incomplete = new Map<string, ViolationSummaryAggregate>();
    for (const page of this.pages) {
      const findings = this._pageFindings.get(page);
      if (!findings)
        continue;
      aggregateIntoSummary(violations, findings.violations, page.url);
      if (findings.incomplete)
        aggregateIntoSummary(incomplete, findings.incomplete, page.url);
    }
    return { violations: toSortedSummaryViolations(violations), incomplete: toSortedSummaryViolations(incomplete) };
  }

  private async _runWorker(worker: CrawlWorker): Promise<void> {
    const { frontier, params } = this._setup;
    while (!this._stopped) {
      if (!frontier.queue.length) {
        if (this._linkCommits.allCommitted)
          return;
        await this._linkCommits.waitForCommit();
        continue;
      }
      if (this.pages.length >= params.maxPages)
        return;
      const item = frontier.takeUnvisited();
      if (item)
        await this._auditPage(worker, item, this._linkCommits.dequeued++);
    }
  }

  private async _auditPage(worker: CrawlWorker, queuedItem: CrawlItem, sequence: number): Promise<void> {
    const pageIndex = this.pages.push(newPageReport(queuedItem)) - 1;
    const commitLinks = this._linkCommitterFor(queuedItem, sequence);
    this._session.pageStarted(sequence, queuedItem.url);
    try {
      let item = queuedItem;
      while (await this._attemptPage(worker, item, { pageIndex, sequence }, commitLinks) === 'retry')
        item = { ...item, retriedAfterOutgoingDialog: true };
    } finally {
      this._session.pageFinished(sequence);
      commitLinks([]);
    }
  }

  private _linkCommitterFor(item: CrawlItem, sequence: number): (links: string[]) => void {
    let committed = false;
    return links => {
      if (committed)
        return;
      committed = true;
      this._linkCommits.commit(sequence, { links, depth: item.depth + 1, discoveredFrom: item.url });
    };
  }

  private async _attemptPage(worker: CrawlWorker, item: CrawlItem, slot: { pageIndex: number, sequence: number }, commitLinks: (links: string[]) => void): Promise<'done' | 'retry'> {
    const report = newPageReport(item);
    this.pages[slot.pageIndex] = report;
    const tab = await this._readyTab(worker, item);
    const urlBeforeNavigation = tab.page.url();
    const dialogWatch = watchForDialog(tab, item.url);
    let retry = false;
    try {
      this._pageFindings.set(report, await scanCrawledPage({ tab, item, report, dialogWatch }, this._setup.scope, this._setup.params, commitLinks));
    } catch (error) {
      retry = !item.retriedAfterOutgoingDialog && dialogWatch.raisedByOutgoingDocument();
      if (!retry) {
        this.erroredPages++;
        report.status = 'error';
        report.error = errorMessage(error);
      }
    } finally {
      await dialogWatch.stop();
      worker.abandoned = dialogWatch.fired();
      if (!retry)
        this._session.pageFinished(slot.sequence);
      await this._session.check(tab.page, slot.sequence, retry ? urlBeforeNavigation : item.url, urlBeforeNavigation);
      if (!retry)
        await this._reportPageProgress(report, item.url);
    }
    return retry ? 'retry' : 'done';
  }

  private async _readyTab(worker: CrawlWorker, item: CrawlItem): Promise<Tab> {
    worker.tab ??= await this._setup.context.newTab();
    await this._session.widenScope(worker.tab.page, item.cookieUrl);
    if (worker.abandoned || openDialog(worker.tab))
      await this._replaceTabFrozenByDialog(worker, worker.tab, item.url);
    return worker.tab;
  }

  private async _replaceTabFrozenByDialog(worker: CrawlWorker, frozenTab: Tab, url: string): Promise<void> {
    worker.abandoned = false;
    this._retiredTabs.push(frozenTab);
    worker.tab = await this._setup.context.newTab();
    this.crawlTabRestarts.push({ url });
    await closeTabIfOpen(this._setup.context, frozenTab);
  }

  private async _reportPageProgress(report: PageReport, url: string): Promise<void> {
    this._processedPages++;
    const { params, response } = this._setup;
    const verb = report.status === 'scanned' ? 'Scanned' : 'Failed';
    await response.reportProgress({
      progress: this._processedPages,
      total: params.maxPages,
      message: `${verb} page ${this._processedPages}/${params.maxPages}: ${url}`,
    });
  }
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
    assertRuleOptionsValid({ rules: params.withRules, disableRules: params.disableRules });

    const context = tab.context;
    const reportPath = await reserveReportPath(context, response, params.reportFile, 'audit-site');
    const scanStartedAt = Date.now();
    const startUrl = parseStartUrl(requestedStartUrl(params), tab.page.url());
    const scope = new CrawlScope(startUrl, params);
    const frontier = new CrawlFrontier(scope, params.maxPages);
    await seedFrontier(frontier, scope, params, context);

    await response.reportProgress({
      progress: 0,
      total: params.maxPages,
      message: `Initialized site audit with ${frontier.queue.length} queued URL(s).`,
    });

    const crawl = await SiteCrawl.open({ context, params, scope, frontier, response });
    try {
      await crawl.run();
    } finally {
      await crawl.closeTabs(tab);
    }

    const { pages, crawlTabRestarts } = crawl;
    const pagesWithUnscannedFrames = pages.filter(page => page.unscannedFrames.length);
    const scannedPagesByViolations = sortScannedPagesByViolations(pages);
    const summary: SummaryReport = {
      totals: {
        scannedPages: scannedPagesByViolations.length,
        erroredPages: crawl.erroredPages,
        skippedUrls: frontier.skippedUrls,
        queuedUrls: frontier.visited.size,
      },
      ...crawl.aggregatedFindings(),
    };
    const { representativeSelection } = frontier;
    const sessionLosses = crawl.sessionLosses;

    const report = buildSiteReport({ startUrl, params, scanStartedAt, pages, summary, representativeSelection, sessionLosses, crawlTabRestarts });
    const reportResource = await writeJsonReport(response, reportPath, report, {
      name: 'audit-site-report',
      title: 'Audit site JSON report',
      description: 'Aggregated JSON report for the site accessibility crawl.',
    });
    response.setStructuredContent(siteStructuredContent(report, reportResource, pagesWithUnscannedFrames, scannedPagesByViolations));

    response.addCode('// Crawled pages in a temporary tab and aggregated Axe violations.');
    response.addResult(renderSiteSummary({
      pagesWithUnscannedFrames,
      sessionLosses,
      crawlTabRestarts,
      representativeSelection,
      summary,
      scannedPagesByViolations,
      includeIncomplete: params.includeIncomplete,
      reportPath: reportResource.path,
    }));
  },
});

export default [
  auditSite,
];
