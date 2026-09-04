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

function createAxeResult(url: string, violations: any[], incomplete: any[] = []) {
  return {
    url,
    violations,
    incomplete,
    passes: [],
    inapplicable: [],
    unscannedFrames: [],
  } as any;
}

function createHarness(
  linkMap: Record<string, string[]>,
  options?: {
    startUrl?: string;
    navLinkMap?: Record<string, string[]>;
    redirectMap?: Record<string, string>;
    sitemapXmlByUrl?: Record<string, string>;
    requestContext?: any;
    cookiesForUrl?: (url: string) => { name: string, domain?: string, path?: string, expires?: number }[];
    navigationFailsFor?: (url: string) => boolean;
    navigationAbortsFor?: (url: string) => boolean;
  }
) {
  const startUrl = options?.startUrl ?? 'https://example.com/';
  let currentUrl = 'about:blank';
  const navLinkMap = options?.navLinkMap ?? {};
  const redirectMap = options?.redirectMap ?? {};

  let abortedNavigationClearedCookies = false;
  // Mirrors context.cookies(urls): only cookies whose path covers one of the
  // asked-for URLs are returned, so path-scoped session cookies stay invisible
  // until a URL below their path is part of the query. Path matching is
  // boundary-aware like the browser's: /app covers /app and /app/x, not
  // /application.
  const cookiesMock = vi.fn(async (urls?: string[]) =>
    (abortedNavigationClearedCookies ? [] : options?.cookiesForUrl?.(currentUrl) ?? [])
        .map(cookie => ({ domain: 'example.com', path: '/', expires: -1, ...cookie }))
        .filter(cookie => !urls || urls.some(url => {
          const pathname = new URL(url).pathname;
          return pathname === cookie.path
            || pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`);
        })));

  const crawlPage = {
    context: vi.fn(() => ({ cookies: cookiesMock })),
    url: vi.fn(() => currentUrl),
    title: vi.fn(async () => `Title for ${currentUrl}`),
    // Mirrors readPage(): one evaluate per crawled page returning the title and,
    // when a link selector is passed, the links that selector would collect.
    evaluate: vi.fn(async (_callback: unknown, selector?: string) => {
      const links = !selector
        ? []
        : /navigation/.test(selector)
          ? navLinkMap[currentUrl] ?? []
          : linkMap[currentUrl] ?? [];
      return { title: `Title for ${currentUrl}`, links };
    }),
  };

  const crawlTab: any = {
    page: crawlPage,
    navigate: vi.fn(async (url: string) => {
      // A navigation that aborts leaves the tab on the previous page even though the
      // response — and its cookie changes — already landed.
      if (options?.navigationAbortsFor?.(url)) {
        abortedNavigationClearedCookies = true;
        throw new Error(`net::ERR_ABORTED navigating to ${url}`);
      }
      currentUrl = redirectMap[url] ?? url;
      // The response landed and the page committed, but the load never finished,
      // which is how a hanging logout endpoint behaves.
      if (options?.navigationFailsFor?.(currentUrl))
        throw new Error(`Timeout 60000ms exceeded navigating to ${url}`);
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

  const response = new Response(context as any, 'audit_site', {}, options?.requestContext);

  return {
    context,
    response,
    crawlTab,
    temporaryTab,
    cookiesMock,
  };
}

describe('audit_site tool', () => {
  const tool = auditSiteTools.find(entry => entry.schema.name === 'audit_site')!;
  let writeFileSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);
  });

  it('reserves an explicit report before opening the crawl tab', async () => {
    const { context, response } = createHarness({ 'https://example.com/': [] });
    context.outputFile.mockRejectedValue(new Error('Output file already exists'));

    await expect(tool.handle(response.context, tool.schema.inputSchema.parse({ reportFile: 'taken.json' }), response))
        .rejects.toThrow('Output file already exists');

    expect(context.newTab).not.toHaveBeenCalled();
  });

  it('warns about pages whose frames the scan could not reach', async () => {
    // A page scanned with a frame missing reports fewer violations, so a reader
    // counting them has to know which pages those numbers are incomplete for.
    const { context, response } = createHarness({
      'https://example.com/': ['https://example.com/embedded'],
      'https://example.com/embedded': [],
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => ({
      ...createAxeResult(page.url(), []),
      unscannedFrames: page.url() === 'https://example.com/embedded' ? ['https://widget.example/embed'] : [],
    }));

    await tool.handle(context as any, {
      strategy: 'links',
      maxPages: 5,
      maxDepth: 1,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: [],
      ignoreQueryParams: [],
      violationsTag: ['wcag2aa'],
      includeIncomplete: false,
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
    } as any, response);

    expect(response.result()).toContain('WARNING: Axe could not be installed in frames on 1 page(s)');
    expect(response.result()).toContain('- https://example.com/embedded: https://widget.example/embed');

    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    const embedded = report.pages.find((page: any) => page.url === 'https://example.com/embedded');
    expect(embedded.unscannedFrames).toEqual(['https://widget.example/embed']);
    // A client reading only structured output must be able to tell the same.
    expect(response.structuredContent()!.pagesWithUnscannedFrames).toEqual([
      { url: 'https://example.com/embedded', unscannedFrames: ['https://widget.example/embed'] },
    ]);
  });

  it('says nothing about frames when every page was scanned in full', async () => {
    const { context, response } = createHarness({ 'https://example.com/': [] });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => createAxeResult(page.url(), []));

    await tool.handle(context as any, {
      strategy: 'links',
      maxPages: 1,
      maxDepth: 0,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: [],
      ignoreQueryParams: [],
      violationsTag: ['wcag2aa'],
      includeIncomplete: false,
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
    } as any, response);

    expect(response.result()).not.toContain('could not be installed');
    expect(response.structuredContent()!.pagesWithUnscannedFrames).toEqual([]);
  });

  it('passes tags, rule filters and scope selectors through to the axe scan', async () => {
    const { context, response } = createHarness({ 'https://example.com/': [] });
    const runAxeScanSpy = vi.spyOn(axe, 'runAxeScan')
        .mockImplementation(async (page: any) => createAxeResult(page.url(), []));

    await tool.handle(context as any, {
      strategy: 'links',
      maxPages: 1,
      maxDepth: 0,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: [],
      ignoreQueryParams: [],
      violationsTag: ['wcag2aa'],
      includeIncomplete: false,
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
      includeSelectors: ['#main'],
      excludeSelectors: ['#chat-widget'],
      withRules: ['image-alt'],
      disableRules: ['color-contrast'],
    } as any, response);

    expect(runAxeScanSpy.mock.calls[0][1]).toEqual({
      tags: ['wcag2aa'],
      rules: ['image-alt'],
      disableRules: ['color-contrast'],
      include: ['#main'],
      exclude: ['#chat-widget'],
    });

    // The report has to say which rule filter produced it, or a stored audit
    // cannot be told apart from a full scan.
    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    expect(report.metadata.options.withRules).toEqual(['image-alt']);
    expect(report.metadata.options.disableRules).toEqual(['color-contrast']);
  });

  it('reports incomplete results per page and aggregated, and drops them when disabled', async () => {
    const runScan = async (page: any) => createAxeResult(
        page.url(),
        [createViolation('image-alt', '<img>')],
        [createViolation('color-contrast', '<h1>Hi</h1>', ['h1'])]
    );

    const included = createHarness({ 'https://example.com/': [] });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(runScan);
    const baseParams = {
      strategy: 'links',
      maxPages: 1,
      maxDepth: 0,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: [],
      ignoreQueryParams: [],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
    };

    await tool.handle(included.context as any, { ...baseParams, includeIncomplete: true } as any, included.response);
    const withIncomplete = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    expect(withIncomplete.pages[0].incomplete.map((item: any) => item.id)).toEqual(['color-contrast']);
    expect(withIncomplete.summary.incomplete.map((item: any) => item.id)).toEqual(['color-contrast']);
    // Incomplete results must never leak into the violations list.
    expect(withIncomplete.summary.violations.map((item: any) => item.id)).toEqual(['image-alt']);

    writeFileSpy.mockClear();
    const excluded = createHarness({ 'https://example.com/': [] });
    await tool.handle(excluded.context as any, { ...baseParams, includeIncomplete: false } as any, excluded.response);
    const withoutIncomplete = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    expect(withoutIncomplete.pages[0].incomplete).toEqual([]);
    expect(withoutIncomplete.summary.incomplete).toEqual([]);
  });

  it('keeps crawling through a page whose scan failed', async () => {
    // A scoped scan throws when includeSelectors is absent from one page. If
    // discovery hung off the scan succeeding, every descendant reachable only
    // through that page would vanish from the audit without a trace.
    const { context, response } = createHarness({
      'https://example.com/': ['https://example.com/gate'],
      'https://example.com/gate': ['https://example.com/behind-the-gate'],
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      if (page.url() === 'https://example.com/gate')
        throw new Error('No elements matched includeSelectors: #main');
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'links',
      maxPages: 5,
      maxDepth: 2,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: [],
      ignoreQueryParams: [],
      violationsTag: ['wcag2aa'],
      includeIncomplete: false,
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
      includeSelectors: ['#main'],
    } as any, response);

    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    const byUrl = new Map<string, any>(report.pages.map((page: any) => [page.url, page]));
    expect(byUrl.get('https://example.com/gate').status).toBe('error');
    expect(byUrl.get('https://example.com/behind-the-gate')?.status).toBe('scanned');
    expect(byUrl.get('https://example.com/behind-the-gate')?.discoveredFrom).toBe('https://example.com/gate');
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

  it('emits progress notifications during crawl execution', async () => {
    const sendNotification = vi.fn(async () => undefined);
    const { context, response } = createHarness({
      'https://example.com/': ['https://example.com/one'],
      'https://example.com/one': [],
    }, {
      requestContext: {
        _meta: { progressToken: 'progress-site' },
        sendNotification,
        signal: new AbortController().signal,
        requestId: 1,
      },
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

    expect(sendNotification).toHaveBeenCalledTimes(3);
    expect(sendNotification).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: 'notifications/progress',
      params: expect.objectContaining({
        progressToken: 'progress-site',
        progress: 0,
        total: 2,
      }),
    }));
    expect(sendNotification).toHaveBeenLastCalledWith(expect.objectContaining({
      method: 'notifications/progress',
      params: expect.objectContaining({
        progressToken: 'progress-site',
        progress: 2,
        total: 2,
      }),
    }));
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

  it('rejects unknown rule ids before crawling anything, instead of erroring every page', async () => {
    const { context, response, crawlTab } = createHarness({ 'https://example.com/': [] });
    const runAxeScanSpy = vi.spyOn(axe, 'runAxeScan');

    await expect(tool.handle(context as any, {
      strategy: 'provided',
      urls: ['https://example.com/', 'https://example.com/pricing', 'https://example.com/contact'],
      maxPages: 5,
      maxDepth: 2,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: [],
      ignoreQueryParams: [],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
      withRules: ['image-altt'],
    } as any, response)).rejects.toThrow('Unknown Axe rule id(s) in withRules: image-altt');

    // The point of the up-front check: no tab opened, no page visited, no
    // report claiming a completed audit.
    expect(context.newTab).not.toHaveBeenCalled();
    expect(crawlTab.navigate).not.toHaveBeenCalled();
    expect(runAxeScanSpy).not.toHaveBeenCalled();
    expect(writeFileSpy).not.toHaveBeenCalled();
  });

  it('rejects a disableRules set that empties withRules before crawling anything', async () => {
    const { context, response, crawlTab } = createHarness({ 'https://example.com/': [] });

    await expect(tool.handle(context as any, {
      strategy: 'provided',
      urls: ['https://example.com/'],
      maxPages: 5,
      maxDepth: 2,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: [],
      ignoreQueryParams: [],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
      withRules: ['image-alt'],
      disableRules: ['image-alt'],
    } as any, response)).rejects.toThrow('disableRules disabled every rule in withRules (image-alt)');

    expect(context.newTab).not.toHaveBeenCalled();
    expect(crawlTab.navigate).not.toHaveBeenCalled();
  });

  it('still validates scope selectors per page, not up front', async () => {
    // A component may legitimately be missing from some crawled pages, so an
    // unmatched selector is a page-level error — unlike a bad rule id.
    const { context, response, crawlTab } = createHarness({ 'https://example.com/': [] });
    vi.spyOn(axe, 'runAxeScan').mockRejectedValue(new Error('No elements matched includeSelectors: #missing'));

    await tool.handle(context as any, {
      strategy: 'provided',
      urls: ['https://example.com/'],
      maxPages: 5,
      maxDepth: 2,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: [],
      ignoreQueryParams: [],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
      includeSelectors: ['#missing'],
    } as any, response);

    expect(crawlTab.navigate).toHaveBeenCalledTimes(1);
    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    expect(report.pages[0].status).toBe('error');
    expect(report.pages[0].error).toContain('No elements matched includeSelectors');
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
    // The page is still read for its title - `every` alone would also pass if
    // that read disappeared - and what must not happen is link discovery, which
    // is what a non-empty selector argument would mean.
    expect(crawlTab.page.evaluate.mock.calls.length).toBeGreaterThan(0);
    expect(crawlTab.page.evaluate.mock.calls.every((call: unknown[]) => !call[1])).toBe(true);
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

  it('reports the page where the authenticated session was lost', async () => {
    const { context, response } = createHarness({}, {
      cookiesForUrl: url => url.endsWith('/account/close') || url.endsWith('/profile') ? [] : [{ name: 'sid' }],
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'provided',
      urls: ['https://example.com/dashboard', 'https://example.com/account/close', 'https://example.com/profile'],
      maxPages: 5,
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
    expect(report.sessionLosses).toEqual([{ url: 'https://example.com/account/close', cookies: ['sid'] }]);
    expect(response.result()).toContain('WARNING: cookie(s) sid present when the crawl started disappeared while loading https://example.com/account/close.');
  });

  it('scopes the cookie baseline to the crawled URLs', async () => {
    const { context, response, cookiesMock } = createHarness({}, {
      cookiesForUrl: () => [{ name: 'sid' }],
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'provided',
      urls: ['https://example.com/dashboard', 'https://example.com/profile'],
      maxPages: 5,
      maxDepth: 0,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: ['logout|signout'],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
    } as any, response);

    expect(cookiesMock).toHaveBeenCalledWith(['https://example.com/dashboard', 'https://example.com/profile']);
  });

  it('reports a deleted auth cookie masked by a same-named cookie on another domain', async () => {
    const { context, response } = createHarness({}, {
      cookiesForUrl: url => url.endsWith('/account/close')
        ? [{ name: 'sid', domain: 'cdn.example.com' }]
        : [{ name: 'sid', domain: 'example.com' }],
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'provided',
      urls: ['https://example.com/dashboard', 'https://example.com/account/close'],
      maxPages: 5,
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
    expect(report.sessionLosses).toEqual([{ url: 'https://example.com/account/close', cookies: ['sid'] }]);
  });

  it('reports the URL reached after a redirect as the page that lost the session', async () => {
    const { context, response } = createHarness({}, {
      redirectMap: { 'https://example.com/account/close': 'https://example.com/signed-out' },
      cookiesForUrl: url => url.endsWith('/signed-out') ? [] : [{ name: 'sid' }],
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'provided',
      urls: ['https://example.com/dashboard', 'https://example.com/account/close'],
      maxPages: 5,
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
    expect(report.sessionLosses).toEqual([{ url: 'https://example.com/signed-out', cookies: ['sid'] }]);
    expect(response.result()).toContain('while loading https://example.com/signed-out.');
  });

  it('reports the page that lost the session even when its navigation failed', async () => {
    const { context, response } = createHarness({}, {
      navigationFailsFor: url => url.endsWith('/slow-logout'),
      cookiesForUrl: url => url.endsWith('/slow-logout') || url.endsWith('/profile') ? [] : [{ name: 'sid' }],
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'provided',
      urls: ['https://example.com/dashboard', 'https://example.com/slow-logout', 'https://example.com/profile'],
      maxPages: 5,
      maxDepth: 0,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: [],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
    } as any, response);

    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    expect(report.sessionLosses).toEqual([{ url: 'https://example.com/slow-logout', cookies: ['sid'] }]);
  });

  // An aborted navigation never leaves the previous page, so the URL asked for is the
  // only thing identifying the response that cleared the cookie.
  it('blames the requested URL when the navigation that lost the session never committed', async () => {
    const { context, response } = createHarness({}, {
      navigationAbortsFor: url => url.endsWith('/failing-logout'),
      cookiesForUrl: () => [{ name: 'sid' }],
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'provided',
      urls: ['https://example.com/dashboard', 'https://example.com/failing-logout', 'https://example.com/profile'],
      maxPages: 5,
      maxDepth: 0,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: [],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
    } as any, response);

    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    expect(report.sessionLosses).toEqual([{ url: 'https://example.com/failing-logout', cookies: ['sid'] }]);
  });

  it('does not report session loss for a cookie the browser dropped at its own expiry', async () => {
    const expired = Math.floor(Date.now() / 1000) - 60;
    const { context, response } = createHarness({}, {
      cookiesForUrl: url => url.endsWith('/profile')
        ? [{ name: 'sid' }]
        : [{ name: 'sid' }, { name: '__cf_bm', expires: expired }],
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'provided',
      urls: ['https://example.com/dashboard', 'https://example.com/profile'],
      maxPages: 5,
      maxDepth: 0,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: [],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
    } as any, response);

    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    expect(report.sessionLosses).toEqual([]);
  });

  it('still reports a cookie deleted before its expiry passed', async () => {
    const notYetExpired = Math.floor(Date.now() / 1000) + 3600;
    const { context, response } = createHarness({}, {
      cookiesForUrl: url => url.endsWith('/profile') ? [] : [{ name: 'sid', expires: notYetExpired }],
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'provided',
      urls: ['https://example.com/dashboard', 'https://example.com/profile'],
      maxPages: 5,
      maxDepth: 0,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: [],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
    } as any, response);

    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    expect(report.sessionLosses).toEqual([{ url: 'https://example.com/profile', cookies: ['sid'] }]);
  });

  it('does not report session loss when cookies survive the crawl', async () => {
    const { context, response } = createHarness({}, {
      cookiesForUrl: () => [{ name: 'sid' }],
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'provided',
      urls: ['https://example.com/dashboard', 'https://example.com/profile'],
      maxPages: 5,
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
    expect(report.sessionLosses).toEqual([]);
  });

  it('keeps monitoring after a cookie loss, so an unrelated one cannot mask the session cookie', async () => {
    // `metrics` disappears first on /features; if monitoring stopped there, the
    // real session cookie vanishing later on /account/close would go unreported.
    const { context, response } = createHarness({}, {
      cookiesForUrl: url => {
        if (url.endsWith('/features') || url.endsWith('/pricing'))
          return [{ name: 'sid' }];
        if (url.endsWith('/account/close') || url.endsWith('/profile'))
          return [];
        return [{ name: 'sid' }, { name: 'metrics' }];
      },
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'provided',
      urls: [
        'https://example.com/dashboard',
        'https://example.com/features',
        'https://example.com/pricing',
        'https://example.com/account/close',
        'https://example.com/profile',
      ],
      maxPages: 5,
      maxDepth: 0,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: [],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
    } as any, response);

    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    // Each cookie is reported once, at the URL where it vanished.
    expect(report.sessionLosses).toEqual([
      { url: 'https://example.com/features', cookies: ['metrics'] },
      { url: 'https://example.com/account/close', cookies: ['sid'] },
    ]);
    expect(response.result()).toContain('cookie(s) metrics present when the crawl started disappeared while loading https://example.com/features.');
    expect(response.result()).toContain('cookie(s) sid present when the crawl started disappeared while loading https://example.com/account/close.');
  });

  it('tracks cookies scoped to URLs discovered mid-crawl, not just the start URL', async () => {
    // app_sid is scoped to /app, so the baseline read against the start URL
    // cannot see it; it must join tracking when /app is discovered and its loss
    // on /app/logout must still be reported.
    const { context, response } = createHarness({
      'https://example.com/': ['https://example.com/app'],
      'https://example.com/app': ['https://example.com/app/logout'],
      'https://example.com/app/logout': [],
    }, {
      cookiesForUrl: url => url.endsWith('/app/logout')
        ? []
        : [{ name: 'app_sid', path: '/app' }],
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'links',
      startUrl: 'https://example.com/',
      maxPages: 5,
      maxDepth: 3,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: [],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
    } as any, response);

    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    expect(report.sessionLosses).toEqual([{ url: 'https://example.com/app/logout', cookies: ['app_sid'] }]);
  });

  it('preserves a discovered trailing slash when scoping cookies', async () => {
    const { context, response } = createHarness({
      'https://example.com/': ['https://example.com/app/'],
      'https://example.com/app/': ['https://example.com/app/logout'],
      'https://example.com/app/logout': [],
    }, {
      redirectMap: { 'https://example.com/app': 'https://example.com/app/' },
      cookiesForUrl: url => url.endsWith('/app/logout')
        ? []
        : [{ name: 'app_sid', path: '/app/' }],
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => createAxeResult(page.url(), []));

    await tool.handle(context as any, {
      strategy: 'links',
      startUrl: 'https://example.com/',
      maxPages: 5,
      maxDepth: 3,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: [],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
    } as any, response);

    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    expect(report.sessionLosses).toEqual([{ url: 'https://example.com/app/logout', cookies: ['app_sid'] }]);
  });

  it('does not report a cookie minted mid-crawl as a lost crawl-start cookie', async () => {
    // `minted` first appears while visiting /, after the crawl-start jar
    // snapshot. The discovered URLs must not adopt it into the baseline, or its
    // disappearance on /gone would be misreported as losing a cookie the
    // caller signed in with.
    const { context, response } = createHarness({
      'https://example.com/': ['https://example.com/app'],
      'https://example.com/app': ['https://example.com/gone'],
      'https://example.com/gone': [],
    }, {
      cookiesForUrl: url => url === 'about:blank' || url.endsWith('/gone') ? [] : [{ name: 'minted' }],
    });
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      return createAxeResult(page.url(), []);
    });

    await tool.handle(context as any, {
      strategy: 'links',
      startUrl: 'https://example.com/',
      maxPages: 5,
      maxDepth: 3,
      sameOriginOnly: true,
      includeSubdomains: false,
      excludePathPatterns: [],
      ignoreQueryParams: ['utm_source'],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterNavigationMs: 0,
    } as any, response);

    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    expect(report.sessionLosses).toEqual([]);
  });
});
