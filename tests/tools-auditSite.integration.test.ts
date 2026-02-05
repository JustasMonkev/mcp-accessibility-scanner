import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import auditSiteTools from '../src/tools/auditSite.js';
import { Response } from '../src/response.js';
import * as axe from '../src/tools/axe.js';

function createViolation(id: string, html: string) {
  return {
    id,
    impact: 'serious' as const,
    tags: ['wcag2aa'],
    help: `${id} help`,
    helpUrl: `https://example.com/rules/${id}`,
    description: `${id} description`,
    nodes: [
      {
        target: ['#main'],
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

describe('audit_site integration', () => {
  const tool = auditSiteTools.find(entry => entry.schema.name === 'audit_site')!;
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tempDir)
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('writes a real JSON report with scanned pages and summary', async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'audit-site-it-'));
    const reportPath = path.join(tempDir, 'audit-site-report.json');

    const linkMap: Record<string, string[]> = {
      'https://example.com/': ['https://example.com/about'],
      'https://example.com/about': [],
    };

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
        url: vi.fn(() => 'https://example.com/'),
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
      outputFile: vi.fn(async () => reportPath),
      config: {},
    };

    originalTab.context = context;
    crawlTab.context = context;

    const response = new Response(context as any, 'audit_site', {});

    vi.spyOn(axe, 'runAxeScan').mockImplementation(async (page: any) => {
      if (page.url() === 'https://example.com/')
        return createAxeResult(page.url(), [createViolation('color-contrast', '<button>Home</button>')]);
      return createAxeResult(page.url(), [createViolation('color-contrast', '<button>About</button>')]);
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
      reportFile: 'audit-site-report.json',
    } as any, response);

    const report = JSON.parse(await fs.promises.readFile(reportPath, 'utf-8'));
    expect(report.metadata.strategy).toBe('links');
    expect(report.pages).toHaveLength(2);
    expect(report.summary.totals.scannedPages).toBe(2);
    expect(report.summary.violations[0].id).toBe('color-contrast');
    expect(report.summary.violations[0].pagesAffected.length).toBe(2);
    expect(response.result()).toContain(reportPath);
  });
});
