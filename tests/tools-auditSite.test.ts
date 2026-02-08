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

function createHarness(
  linkMap: Record<string, string[]>,
  options?: {
    startUrl?: string;
    navLinkMap?: Record<string, string[]>;
    redirectMap?: Record<string, string>;
    sitemapXmlByUrl?: Record<string, string>;
  }
) {
  const startUrl = options?.startUrl ?? 'https://example.com/';
  let currentUrl = 'about:blank';
  const navLinkMap = options?.navLinkMap ?? {};
  const redirectMap = options?.redirectMap ?? {};

  const crawlPage = {
    url: vi.fn(() => currentUrl),
    title: vi.fn(async () => `Title for ${currentUrl}`),
    evaluate: vi.fn(async (callback: () => unknown) => {
      const callbackText = typeof callback === 'function' ? callback.toString() : '';
      if (callbackText.includes('nav a[href], header a[href], [role="navigation"] a[href]'))
        return navLinkMap[currentUrl] ?? [];
      return linkMap[currentUrl] ?? [];
    }),
  };

  const crawlTab: any = {
    page: crawlPage,
    navigate: vi.fn(async (url: string) => {
      currentUrl = redirectMap[url] ?? url;
    }),
    waitForTimeout: vi.fn(async () => undefined),
  };

  const temporaryTab: any = {
    page: {
      request: {
        get: vi.fn(async (sitemapUrl: string) => {
          const xmlText = options?.sitemapXmlByUrl?.[sitemapUrl];
          if (!xmlText) {
            return {
              ok: () => false,
              status: () => 404,
              statusText: () => 'Not Found',
              text: async () => '',
            };
          }
          return {
            ok: () => true,
            status: () => 200,
            statusText: () => 'OK',
            text: async () => xmlText,
          };
        }),
      },
    },
  };

  const originalTab: any = {
    page: {
      url: vi.fn(() => startUrl),
    },
    modalStates: vi.fn(() => []),
  };

  const tabs: any[] = [originalTab];
  let createdSitemapTab = false;
  const context = {
    currentTabOrDie: vi.fn(() => originalTab),
    tabs: vi.fn(() => tabs),
    newTab: vi.fn(async () => {
      if (options?.sitemapXmlByUrl && !createdSitemapTab) {
        createdSitemapTab = true;
        tabs.push(temporaryTab);
        return temporaryTab;
      }
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
  temporaryTab.context = context;

  const response = new Response(context as any, 'audit_site', {});

  return {
    context,
    response,
    crawlTab,
    temporaryTab,
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
    expect(context.selectTab).toHaveBeenCalledWith(0);
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

  it('limits crawl to the start URL when maxDepth is 0', async () => {
    const { context, response, crawlTab } = createHarness({
      'https://example.com/': ['https://example.com/a', 'https://example.com/b'],
      'https://example.com/a': [],
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'links',
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

    expect(crawlTab.navigate).toHaveBeenCalledTimes(1);
    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    expect(report.pages).toHaveLength(1);
    expect(report.pages[0].url).toBe('https://example.com/');
  });

  it('uses nav strategy to enqueue only navigation links', async () => {
    const { context, response } = createHarness({
      'https://example.com/': ['https://example.com/content-only'],
      'https://example.com/content-only': [],
      'https://example.com/nav-only': [],
    }, {
      navLinkMap: {
        'https://example.com/': ['https://example.com/nav-only'],
      },
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'nav',
      maxPages: 10,
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
    const crawledUrls = report.pages.map((page: any) => page.url);
    expect(crawledUrls).toContain('https://example.com/nav-only');
    expect(crawledUrls).not.toContain('https://example.com/content-only');
  });

  it('scans only provided URLs and does not crawl discovered links', async () => {
    const { context, response, crawlTab } = createHarness({
      'https://example.com/a': ['https://example.com/discovered'],
      'https://example.com/discovered': [],
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'provided',
      urls: ['https://example.com/a', 'https://example.com/b'],
      maxPages: 10,
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
    const crawledUrls = report.pages.map((page: any) => page.url);
    expect(crawledUrls).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(crawlTab.page.evaluate).not.toHaveBeenCalled();
  });

  it('supports sitemap strategy by parsing loc entries', async () => {
    const sitemapUrl = 'https://example.com/sitemap.xml';
    const { context, response, temporaryTab } = createHarness({
      'https://example.com/one': [],
      'https://example.com/two': [],
    }, {
      sitemapXmlByUrl: {
        [sitemapUrl]: '<urlset><url><loc>https://example.com/one</loc></url><url><loc>https://example.com/two</loc></url></urlset>',
      },
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'sitemap',
      sitemapUrl,
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

    expect(temporaryTab.page.request.get).toHaveBeenCalledWith(sitemapUrl, { timeout: 15000 });
    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    expect(report.pages.map((page: any) => page.url)).toEqual(['https://example.com/one', 'https://example.com/two']);
  });

  it('records errored pages while continuing to scan remaining URLs', async () => {
    const { context, response, crawlTab } = createHarness({
      'https://example.com/good': [],
      'https://example.com/bad': [],
    });
    const originalNavigate = crawlTab.navigate;
    crawlTab.navigate = vi.fn(async (url: string) => {
      await originalNavigate(url);
      if (url === 'https://example.com/bad')
        throw new Error('Navigation timeout');
    });

    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'provided',
      urls: ['https://example.com/good', 'https://example.com/bad'],
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
    expect(report.summary.totals.erroredPages).toBe(1);
    expect(report.summary.totals.scannedPages).toBe(1);
    expect(report.pages.some((page: any) => page.status === 'error')).toBe(true);
  });

  it('uses active tab URL as startUrl when startUrl is omitted', async () => {
    const { context, response, crawlTab } = createHarness({
      'https://example.com/custom-start': [],
    }, {
      startUrl: 'https://example.com/custom-start',
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'links',
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

    expect(crawlTab.navigate).toHaveBeenCalledWith('https://example.com/custom-start');
  });

  it('applies waitAfterNavigationMs before each scan', async () => {
    const { context, response, crawlTab } = createHarness({
      'https://example.com/': ['https://example.com/next'],
      'https://example.com/next': [],
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'links',
      maxPages: 10,
      maxDepth: 1,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: ['logout|signout'],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 3000,
    } as any, response);

    expect(crawlTab.waitForTimeout).toHaveBeenCalledTimes(2);
    expect(crawlTab.waitForTimeout).toHaveBeenNthCalledWith(1, 3000);
    expect(crawlTab.waitForTimeout).toHaveBeenNthCalledWith(2, 3000);
  });

  it('handles redirect-like cycles without infinite loops', async () => {
    const { context, response, crawlTab } = createHarness({
      'https://example.com/protected': ['https://example.com/login'],
      'https://example.com/login': ['https://example.com/login', 'https://example.com/protected'],
    }, {
      redirectMap: {
        'https://example.com/protected': 'https://example.com/login',
      },
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      startUrl: 'https://example.com/protected',
      strategy: 'links',
      maxPages: 10,
      maxDepth: 2,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: ['logout|signout'],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
    } as any, response);

    expect(crawlTab.navigate).toHaveBeenCalledTimes(2);
    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    expect(report.pages).toHaveLength(2);
  });

  it('handles SPA-style hash links without crashing', async () => {
    const { context, response } = createHarness({
      'https://example.com/app': [
        'https://example.com/app#/dashboard',
        'https://example.com/app#/settings',
        'https://example.com/app?view=home',
      ],
      'https://example.com/app?view=home': [],
    }, {
      startUrl: 'https://example.com/app',
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'links',
      maxPages: 10,
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
    expect(report.summary.totals.scannedPages).toBeGreaterThanOrEqual(1);
  });
});
