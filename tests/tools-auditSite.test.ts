import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import auditSiteTools from '../src/tools/auditSite.js';
import { Response } from '../src/response.js';
import * as axe from '../src/tools/axe.js';

function createViolation(id: string, html: string, target: string[] = ['#target']) {
  return {
    id,
    impact: 'serious' as const,
    tags: ['wcag2aa'],
    help: `${id} help`,
    helpUrl: `https://example.com/rules/${id}`,
    description: `${id} description`,
    nodes: [
      {
        target,
        html,
        failureSummary: `${id} failure`,
      },
    ],
  };
}

function createAxeResult(url: string, violations: any[]) {
  return {
    url,
    violations,
    incomplete: [],
    passes: [],
    inapplicable: [],
  } as any;
}

function createHarness(linkMap: Record<string, string[]>, options?: { startUrl?: string }) {
  const startUrl = options?.startUrl ?? 'https://example.com/';
  let currentUrl = 'about:blank';

  const crawlPage = {
    url: vi.fn(() => currentUrl),
    title: vi.fn(async () => `Title for ${currentUrl}`),
    evaluate: vi.fn(async () => linkMap[currentUrl] ?? []),
  };

  const crawlTab: any = {
    page: crawlPage,
    navigate: vi.fn(async (url: string) => {
      currentUrl = url;
    }),
    waitForTimeout: vi.fn(async () => undefined),
  };

  const originalTab: any = {
    page: {
      url: vi.fn(() => startUrl),
    },
    modalStates: vi.fn(() => []),
  };

  const tabs: any[] = [originalTab];
  const context = {
    currentTabOrDie: vi.fn(() => originalTab),
    tabs: vi.fn(() => tabs),
    newTab: vi.fn(async () => {
      tabs.push(crawlTab);
      return crawlTab;
    }),
    closeTab: vi.fn(async (index: number) => {
      tabs.splice(index, 1);
      return '';
    }),
    selectTab: vi.fn(async () => undefined),
    outputFile: vi.fn(async () => '/tmp/audit-site.json'),
    config: {},
  };

  originalTab.context = context;
  crawlTab.context = context;

  const response = new Response(context as any, 'audit_site', {});

  return {
    context,
    response,
    crawlTab,
  };
}

describe('audit_site tool', () => {
  const tool = auditSiteTools.find(entry => entry.schema.name === 'audit_site')!;
  let writeFileSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);
  });

  it('respects BFS maxPages and maxDepth limits', async () => {
    const { context, response, crawlTab } = createHarness({
      'https://example.com/': ['https://example.com/one', 'https://example.com/two', 'https://example.com/three'],
      'https://example.com/one': ['https://example.com/one/deep'],
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'links',
      maxPages: 2,
      maxDepth: 1,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: ['logout|signout'],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
    } as any, response);

    expect(crawlTab.navigate).toHaveBeenCalledTimes(2);
    const reportJson = writeFileSpy.mock.calls[0][1] as string;
    const report = JSON.parse(reportJson);
    expect(report.pages).toHaveLength(2);
    expect(report.pages.some((page: any) => page.url === 'https://example.com/one/deep')).toBe(false);
  });

  it('normalizes and filters internal links and writes report file', async () => {
    const { context, response } = createHarness({
      'https://example.com/': [
        'https://example.com/keep/',
        'https://example.com/keep/?utm_source=campaign',
        'https://example.com/keep/#fragment',
        'https://example.com/logout',
        'https://external.example.org/path',
      ],
      'https://example.com/keep': [],
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'links',
      maxPages: 5,
      maxDepth: 2,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: ['logout|signout'],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
    } as any, response);

    expect(context.outputFile).toHaveBeenCalled();
    expect(writeFileSpy).toHaveBeenCalledWith('/tmp/audit-site.json', expect.any(String), 'utf-8');

    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    const crawledUrls = report.pages.map((page: any) => page.url);
    expect(crawledUrls).toContain('https://example.com/keep');
    expect(crawledUrls.filter((url: string) => url === 'https://example.com/keep')).toHaveLength(1);
    expect(crawledUrls).not.toContain('https://example.com/logout');
    expect(crawledUrls).not.toContain('https://external.example.org/path');
  });

  it('aggregates violations and fingerprints unique occurrences across pages', async () => {
    const { context, response } = createHarness({
      'https://example.com/': ['https://example.com/a'],
      'https://example.com/a': [],
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      if (page.url() === 'https://example.com/')
        return createAxeResult(page.url(), [createViolation('color-contrast', '  <button>Label</button>  ')]);

      return createAxeResult(page.url(), [createViolation('color-contrast', '\n<button>Label</button>\n')]);
    });

    await tool.handle(context as any, {
      strategy: 'links',
      maxPages: 5,
      maxDepth: 2,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: ['logout|signout'],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
    } as any, response);

    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    const summaryViolation = report.summary.violations.find((entry: any) => entry.id === 'color-contrast');
    expect(summaryViolation.pagesAffected).toHaveLength(2);
    expect(summaryViolation.totalOccurrences).toBe(2);
    expect(summaryViolation.uniqueOccurrences).toBe(1);
  });

  it('throws a clear error when the active tab URL is not http(s)', async () => {
    const { context, response } = createHarness({}, { startUrl: 'about:blank' });

    await expect(tool.handle(context as any, {
      strategy: 'links',
      maxPages: 5,
      maxDepth: 2,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: ['logout|signout'],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
    } as any, response)).rejects.toThrow('Start URL must use http:// or https://');
  });

  it('rejects invalid excludePathPatterns', async () => {
    const { context, response } = createHarness({});

    await expect(tool.handle(context as any, {
      strategy: 'links',
      maxPages: 5,
      maxDepth: 2,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: ['(a)\\1'],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
    } as any, response)).rejects.toThrow('Invalid regex in excludePathPatterns[0]');
  });

  it('rejects excludePathPatterns that exceed maximum length', async () => {
    const { context, response } = createHarness({});

    await expect(tool.handle(context as any, {
      strategy: 'links',
      maxPages: 5,
      maxDepth: 2,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: ['a'.repeat(201)],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
    } as any, response)).rejects.toThrow('excludePathPatterns[0] is too long');
  });

  it('includes subdomains when sameOriginOnly=true and includeSubdomains=true', async () => {
    const { context, response } = createHarness({
      'https://example.com/': ['https://sub.example.com/page', 'https://external.example.org/path'],
      'https://sub.example.com/page': [],
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'links',
      maxPages: 5,
      maxDepth: 2,
      sameOriginOnly: true,
      includeSubdomains: true,
      excludePathPatterns: ['logout|signout'],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
    } as any, response);

    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    const crawledUrls = report.pages.map((page: any) => page.url);
    expect(crawledUrls).toContain('https://sub.example.com/page');
    expect(crawledUrls).not.toContain('https://external.example.org/path');
  });

  it('uses provided URLs to infer start origin when active tab URL is not http(s)', async () => {
    const { context, response } = createHarness({
      'https://example.com/start': [],
      'https://example.com/about': [],
      'https://other.example.org/offsite': [],
    }, { startUrl: 'about:blank' });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'provided',
      urls: ['https://example.com/start', 'https://example.com/about', 'https://other.example.org/offsite'],
      maxPages: 10,
      maxDepth: 0,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: ['logout|signout'],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
    } as any, response);

    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    const crawledUrls = report.pages.map((page: any) => page.url);
    expect(crawledUrls).toEqual(['https://example.com/start', 'https://example.com/about']);
    expect(report.summary.totals.skippedUrls).toBeGreaterThanOrEqual(1);
  });
});
