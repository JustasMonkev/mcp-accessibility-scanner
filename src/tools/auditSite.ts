import crypto from 'crypto';
import fs from 'fs';
import RE2 from 're2';
import { z } from 'zod';
import { defineTabTool } from './tool.js';
import { sanitizeForFilePath } from '../utils/fileUtils.js';
import {
  axeTagValues,
  dedupeAxeNodes,
  runAxeScan,
  summarizeAxeViolations,
  trimAxeResults,
  type AxeTag,
  type AxeViolation,
  type TrimmedAxeViolation
} from './axe.js';

type CrawlStrategy = 'links' | 'nav' | 'sitemap' | 'provided';

type CrawlItem = {
  url: string;
  depth: number;
  discoveredFrom: string | null;
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
  violations: TrimmedAxeViolation[];
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
  violationsTag: z.array(z.enum(axeTagValues)).min(1).default([...axeTagValues]).describe('Axe tags to include in scans.'),
  maxNodesPerViolation: z.number().int().min(1).max(50).default(10).describe('Maximum nodes kept per violation in the report.'),
  waitAfterNavigationMs: z.number().int().min(0).max(5000).default(250).describe('Extra wait after navigation before scanning.'),
  reportFile: z.string().optional().describe('Output JSON report file name.'),
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

function safeIsoTimestampForFileName() {
  return sanitizeForFilePath(new Date().toISOString());
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

  const sortedParams = [...url.searchParams.entries()].sort(([first], [second]) => first.localeCompare(second));
  url.search = '';
  for (const [key, value] of sortedParams)
    url.searchParams.append(key, value);

  if (url.pathname !== '/' && url.pathname.endsWith('/'))
    url.pathname = url.pathname.slice(0, -1);

  return url;
}

async function extractLinks(page: import('playwright').Page): Promise<string[]> {
  return await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href]'))
        .map(anchor => (anchor as HTMLAnchorElement).href)
        .filter(Boolean);
  });
}

async function extractNavLinks(page: import('playwright').Page): Promise<string[]> {
  return await page.evaluate(() => {
    const selectors = 'nav a[href], header a[href], [role="navigation"] a[href]';
    return Array.from(document.querySelectorAll(selectors))
        .map(anchor => (anchor as HTMLAnchorElement).href)
        .filter(Boolean);
  });
}

async function extractSitemapUrls(page: import('playwright').Page, sitemapUrl: string): Promise<string[]> {
  const response = await page.request.get(sitemapUrl, { timeout: 15000 });
  if (!response.ok())
    throw new Error(`Failed to fetch sitemap ${sitemapUrl}: ${response.status()} ${response.statusText()}`);
  const xmlText = await response.text();
  const matches = [...xmlText.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)];
  return matches.map(match => match[1].replace('<![CDATA[', '').replace(']]>', '').trim()).filter(Boolean);
}

function summarizeTopViolations(violations: SummaryViolation[], count: number): string[] {
  return violations
      .slice(0, count)
      .map(violation => `- ${violation.id} (${violation.impact ?? 'unknown'}): ${violation.pagesAffected.length} pages, ${violation.totalOccurrences} nodes`);
}

function summarizeTopPages(pages: PageReport[], count: number): string[] {
  return pages
      .filter(page => page.status === 'scanned')
      .sort((first, second) => (second.summary?.totalRules ?? 0) - (first.summary?.totalRules ?? 0))
      .slice(0, count)
      .map(page => `- ${page.url}: ${page.summary?.totalRules ?? 0} violations, ${page.summary?.totalNodes ?? 0} nodes`);
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
    const context = tab.context;
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

    const summaryByViolation = new Map<string, {
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
    }>();

    const enqueueUrl = (rawUrl: string, depth: number, discoveredFrom: string | null) => {
      const normalizedUrl = normalizeUrl(rawUrl, startUrl, ignoredParams);
      if (!normalizedUrl) {
        skippedUrls++;
        return;
      }

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
        depth,
        discoveredFrom,
      });
      queued.add(normalizedUrlString);
    };

    if (params.strategy === 'provided') {
      for (const url of params.urls ?? [])
        enqueueUrl(url, 0, null);
    } else if (params.strategy === 'sitemap') {
      const sitemapUrl = params.sitemapUrl ?? new URL('sitemap.xml', startUrl).toString();
      const temporaryTab = await context.newTab();
      try {
        const sitemapUrls = await extractSitemapUrls(temporaryTab.page, sitemapUrl);
        for (const url of sitemapUrls)
          enqueueUrl(url, 0, sitemapUrl);
      } finally {
        const tabIndex = context.tabs().indexOf(temporaryTab);
        if (tabIndex !== -1)
          await context.closeTab(tabIndex);
      }
    } else {
      enqueueUrl(startUrl.toString(), 0, null);
    }

    const crawlTab = await context.newTab();
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
        };
        pages.push(pageReport);

        try {
          await crawlTab.navigate(item.url);
          await crawlTab.waitForTimeout(params.waitAfterNavigationMs);
          pageReport.title = await crawlTab.page.title();

          const axeResult = await runAxeScan(crawlTab.page, params.violationsTag as AxeTag[]);
          const dedupedViolations = axeResult.violations.map(violation => ({
            ...violation,
            nodes: dedupeAxeNodes(violation.nodes),
          }));
          const trimmedViolations = trimAxeResults({ violations: dedupedViolations }, { maxNodesPerViolation: params.maxNodesPerViolation });

          pageReport.status = 'scanned';
          pageReport.violations = trimmedViolations;
          pageReport.summary = summarizeAxeViolations(trimmedViolations);

          for (const violation of dedupedViolations) {
            const existingSummary = summaryByViolation.get(violation.id);
            const summary = existingSummary ?? {
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
            summary.pagesAffected.add(item.url);
            summary.totalOccurrences += violation.nodes.length;

            for (const node of violation.nodes) {
              const nodeHtml = normalizeWhitespace(node.html ?? '');
              const fingerprint = crypto.createHash('sha256').update(`${violation.id}|${nodeHtml}`).digest('hex');
              if (summary.fingerprints.has(fingerprint))
                continue;
              summary.fingerprints.add(fingerprint);
              if (summary.sampleNodes.length < 3) {
                summary.sampleNodes.push({
                  pageUrl: item.url,
                  target: [...(node.target ?? [])],
                  html: node.html ?? '',
                  failureSummary: node.failureSummary ?? null,
                });
              }
            }

            summaryByViolation.set(violation.id, summary);
          }

          if (params.strategy === 'links' && item.depth < params.maxDepth) {
            const links = await extractLinks(crawlTab.page);
            for (const link of links)
              enqueueUrl(link, item.depth + 1, item.url);
          }

          if (params.strategy === 'nav' && item.depth === 0) {
            const links = await extractNavLinks(crawlTab.page);
            for (const link of links)
              enqueueUrl(link, item.depth + 1, item.url);
          }
        } catch (error) {
          erroredPages++;
          pageReport.status = 'error';
          pageReport.error = error instanceof Error ? error.message : String(error);
        }
      }
    } finally {
      const crawlTabIndex = context.tabs().indexOf(crawlTab);
      if (crawlTabIndex !== -1)
        await context.closeTab(crawlTabIndex);
      const originalTabIndex = context.tabs().indexOf(originalTab);
      if (originalTabIndex !== -1)
        await context.selectTab(originalTabIndex);
    }

    const summaryViolations: SummaryViolation[] = [...summaryByViolation.values()].map(summary => ({
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

    const summary: SummaryReport = {
      totals: {
        scannedPages: pages.filter(page => page.status === 'scanned').length,
        erroredPages,
        skippedUrls,
        queuedUrls: visited.size,
      },
      violations: summaryViolations,
    };

    const report = {
      version: 'v1',
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
          maxNodesPerViolation: params.maxNodesPerViolation,
          waitAfterNavigationMs: params.waitAfterNavigationMs,
        },
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - scanStartedAt,
      },
      pages,
      summary,
    };

    const reportFileName = sanitizeForFilePath(params.reportFile ?? `audit-site-${safeIsoTimestampForFileName()}.json`);
    const reportPath = await context.outputFile(reportFileName);
    await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');

    const topViolations = summarizeTopViolations(summaryViolations, 10);
    const topPages = summarizeTopPages(pages, 20);
    response.addCode('// Crawled pages in a temporary tab and aggregated Axe violations.');
    response.addResult([
      `Scanned pages: ${summary.totals.scannedPages}`,
      `Errored pages: ${summary.totals.erroredPages}`,
      `Skipped URLs: ${summary.totals.skippedUrls}`,
      '',
      'Top violations by pages affected:',
      ...(topViolations.length ? topViolations : ['- None']),
      '',
      'Per-page summary (top 20 by violation count):',
      ...(topPages.length ? topPages : ['- None']),
      '',
      `JSON report: ${reportPath}`,
    ].join('\n'));
  },
});

export default [
  auditSite,
];
