import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import scanPageMatrixTools from '../src/tools/scanPageMatrix.js';
import { Response } from '../src/response.js';
import * as axe from '../src/tools/axe.js';

function createViolation(id: string) {
  return {
    id,
    impact: 'moderate' as const,
    tags: ['wcag2aa'],
    help: `${id} help`,
    helpUrl: `https://example.com/rules/${id}`,
    description: `${id} description`,
    nodes: [
      {
        target: ['#target'],
        html: `<div>${id}</div>`,
        failureSummary: `${id} failure`,
      },
    ],
  };
}

function createAxeResult(url: string, violationIds: string[]) {
  return {
    url,
    violations: violationIds.map(id => createViolation(id)),
    incomplete: [],
    passes: [],
    inapplicable: [],
  } as any;
}

describe('scan_page_matrix tool', () => {
  const tool = scanPageMatrixTools.find(entry => entry.schema.name === 'scan_page_matrix')!;
  let writeFileSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);
  });

  it('runs variants in baseline-first order and computes baseline diffs', async () => {
    const evaluateMock = vi.fn()
        .mockResolvedValueOnce('')
        .mockResolvedValue(undefined);

    const mockPage = {
      url: vi.fn(() => 'https://example.com/page'),
      viewportSize: vi.fn(() => ({ width: 1024, height: 768 })),
      setViewportSize: vi.fn(async () => undefined),
      emulateMedia: vi.fn(async () => undefined),
      evaluate: evaluateMock,
      reload: vi.fn(async () => undefined),
    };

    const mockTab = {
      page: mockPage,
      waitForTimeout: vi.fn(async () => undefined),
      modalStates: vi.fn(() => []),
      context: {
        outputFile: vi.fn(async () => '/tmp/scan-matrix.json'),
      },
    };

    const mockContext = {
      currentTabOrDie: vi.fn(() => mockTab),
      config: {},
    };

    const response = new Response(mockContext as any, 'scan_page_matrix', {});

    const results = [
      createAxeResult('https://example.com/page', ['color-contrast']),
      createAxeResult('https://example.com/page', ['color-contrast', 'label']),
      createAxeResult('https://example.com/page', ['color-contrast']),
      createAxeResult('https://example.com/page', ['aria-roles']),
      createAxeResult('https://example.com/page', ['color-contrast']),
      createAxeResult('https://example.com/page', ['color-contrast']),
    ];

    let callIndex = 0;
    vi.spyOn(axe, 'runAxeScan').mockImplementation(async () => {
      const result = results[callIndex];
      callIndex++;
      return result;
    });

    await tool.handle(mockContext as any, {
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterApplyMs: 0,
      reloadBetweenVariants: false,
    } as any, response);

    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    expect(report.variants[0].name).toBe('baseline');
    expect(report.variants).toHaveLength(6);
    expect(report.variants[1].diffFromBaseline.newViolationIds).toContain('label');
    expect(report.variants[3].diffFromBaseline.resolvedViolationIds).toContain('color-contrast');
  });

  it('restores viewport, media emulation, and zoom in finally', async () => {
    const evaluateMock = vi.fn()
        .mockResolvedValueOnce('150%')
        .mockResolvedValue(undefined);

    const mockPage = {
      url: vi.fn(() => 'https://example.com/page'),
      viewportSize: vi.fn(() => ({ width: 1280, height: 720 })),
      setViewportSize: vi.fn(async () => undefined),
      emulateMedia: vi.fn(async () => undefined),
      evaluate: evaluateMock,
      reload: vi.fn(async () => undefined),
    };

    const mockTab = {
      page: mockPage,
      waitForTimeout: vi.fn(async () => undefined),
      modalStates: vi.fn(() => []),
      context: {
        outputFile: vi.fn(async () => '/tmp/scan-matrix.json'),
      },
    };

    const mockContext = {
      currentTabOrDie: vi.fn(() => mockTab),
      config: {},
    };

    const response = new Response(mockContext as any, 'scan_page_matrix', {});

    vi.spyOn(axe, 'runAxeScan').mockResolvedValue(createAxeResult('https://example.com/page', ['color-contrast']));

    await tool.handle(mockContext as any, {
      variants: [{ name: 'baseline' }, { name: 'mobile', viewport: { width: 375, height: 812 } }],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterApplyMs: 0,
      reloadBetweenVariants: false,
    } as any, response);

    const lastViewportCall = mockPage.setViewportSize.mock.calls.at(-1);
    const lastMediaCall = mockPage.emulateMedia.mock.calls.at(-1);
    const lastEvaluateCall = mockPage.evaluate.mock.calls.at(-1);

    expect(lastViewportCall?.[0]).toEqual({ width: 1280, height: 720 });
    expect(lastMediaCall?.[0]).toEqual({
      colorScheme: null,
      forcedColors: null,
      contrast: null,
      reducedMotion: null,
    });
    expect(lastEvaluateCall?.[1]).toBe('150%');
  });

  it('runs only custom variants and treats first variant as baseline', async () => {
    const evaluateMock = vi.fn()
        .mockResolvedValueOnce('')
        .mockResolvedValue(undefined);

    const mockPage = {
      url: vi.fn(() => 'https://example.com/page'),
      viewportSize: vi.fn(() => ({ width: 1024, height: 768 })),
      setViewportSize: vi.fn(async () => undefined),
      emulateMedia: vi.fn(async () => undefined),
      evaluate: evaluateMock,
      reload: vi.fn(async () => undefined),
    };

    const mockTab = {
      page: mockPage,
      waitForTimeout: vi.fn(async () => undefined),
      modalStates: vi.fn(() => []),
      context: {
        outputFile: vi.fn(async () => '/tmp/scan-custom.json'),
      },
    };

    const mockContext = {
      currentTabOrDie: vi.fn(() => mockTab),
      config: {},
    };

    const response = new Response(mockContext as any, 'scan_page_matrix', {});
    vi.spyOn(axe, 'runAxeScan')
        .mockResolvedValueOnce(createAxeResult('https://example.com/page', ['aria-roles']))
        .mockResolvedValueOnce(createAxeResult('https://example.com/page', ['aria-roles', 'label']));

    await tool.handle(mockContext as any, {
      variants: [
        { name: 'narrow', viewport: { width: 320, height: 568 } },
        { name: 'wide', viewport: { width: 1920, height: 1080 } },
      ],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterApplyMs: 0,
      reloadBetweenVariants: false,
    } as any, response);

    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    expect(report.variants).toHaveLength(2);
    expect(report.variants[0].name).toBe('narrow');
    expect(report.variants[1].name).toBe('wide');
    expect(report.variants[1].diffFromBaseline.newViolationIds).toContain('label');
  });

  it('records forced-colors/contrast media and zoomPercent metadata in report', async () => {
    const evaluateMock = vi.fn()
        .mockResolvedValueOnce('')
        .mockResolvedValue(undefined);

    const mockPage = {
      url: vi.fn(() => 'https://example.com/page'),
      viewportSize: vi.fn(() => ({ width: 1024, height: 768 })),
      setViewportSize: vi.fn(async () => undefined),
      emulateMedia: vi.fn(async () => undefined),
      evaluate: evaluateMock,
      reload: vi.fn(async () => undefined),
    };

    const mockTab = {
      page: mockPage,
      waitForTimeout: vi.fn(async () => undefined),
      modalStates: vi.fn(() => []),
      context: {
        outputFile: vi.fn(async () => '/tmp/scan-metadata.json'),
      },
    };

    const mockContext = {
      currentTabOrDie: vi.fn(() => mockTab),
      config: {},
    };

    const response = new Response(mockContext as any, 'scan_page_matrix', {});
    vi.spyOn(axe, 'runAxeScan')
        .mockResolvedValueOnce(createAxeResult('https://example.com/page', ['color-contrast']))
        .mockResolvedValueOnce(createAxeResult('https://example.com/page', ['color-contrast']));

    await tool.handle(mockContext as any, {
      variants: [
        { name: 'forced-colors', media: { forcedColors: 'active', contrast: 'more' } },
        { name: 'zoom-400', zoomPercent: 400 },
      ],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterApplyMs: 0,
      reloadBetweenVariants: false,
    } as any, response);

    const report = JSON.parse(writeFileSpy.mock.calls[0][1] as string);
    expect(report.variants[0].applied.media.forcedColors).toBe('active');
    expect(report.variants[0].applied.media.contrast).toBe('more');
    expect(report.variants[1].applied.zoomPercent).toBe(400);
  });

  it('reloads page between variants when reloadBetweenVariants=true', async () => {
    const evaluateMock = vi.fn()
        .mockResolvedValueOnce('')
        .mockResolvedValue(undefined);

    const mockPage = {
      url: vi.fn(() => 'https://example.com/page'),
      viewportSize: vi.fn(() => ({ width: 1024, height: 768 })),
      setViewportSize: vi.fn(async () => undefined),
      emulateMedia: vi.fn(async () => undefined),
      evaluate: evaluateMock,
      reload: vi.fn(async () => undefined),
    };

    const mockTab = {
      page: mockPage,
      waitForTimeout: vi.fn(async () => undefined),
      modalStates: vi.fn(() => []),
      context: {
        outputFile: vi.fn(async () => '/tmp/scan-reload.json'),
      },
    };

    const mockContext = {
      currentTabOrDie: vi.fn(() => mockTab),
      config: {},
    };

    const response = new Response(mockContext as any, 'scan_page_matrix', {});
    vi.spyOn(axe, 'runAxeScan')
        .mockResolvedValueOnce(createAxeResult('https://example.com/page', ['color-contrast']))
        .mockResolvedValueOnce(createAxeResult('https://example.com/page', ['color-contrast']));

    await tool.handle(mockContext as any, {
      variants: [{ name: 'baseline' }, { name: 'mobile', viewport: { width: 390, height: 844 } }],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterApplyMs: 0,
      reloadBetweenVariants: true,
    } as any, response);

    expect(mockPage.reload).toHaveBeenCalledTimes(2);
  });

  it('restores page state even when axe scan fails mid-run', async () => {
    const evaluateMock = vi.fn()
        .mockResolvedValueOnce('125%')
        .mockResolvedValue(undefined);

    const mockPage = {
      url: vi.fn(() => 'https://example.com/page'),
      viewportSize: vi.fn(() => ({ width: 1440, height: 900 })),
      setViewportSize: vi.fn(async () => undefined),
      emulateMedia: vi.fn(async () => undefined),
      evaluate: evaluateMock,
      reload: vi.fn(async () => undefined),
    };

    const mockTab = {
      page: mockPage,
      waitForTimeout: vi.fn(async () => undefined),
      modalStates: vi.fn(() => []),
      context: {
        outputFile: vi.fn(async () => '/tmp/scan-error.json'),
      },
    };

    const mockContext = {
      currentTabOrDie: vi.fn(() => mockTab),
      config: {},
    };

    const response = new Response(mockContext as any, 'scan_page_matrix', {});
    vi.spyOn(axe, 'runAxeScan')
        .mockResolvedValueOnce(createAxeResult('https://example.com/page', ['color-contrast']))
        .mockRejectedValueOnce(new Error('axe crashed'));

    await expect(tool.handle(mockContext as any, {
      variants: [{ name: 'baseline' }, { name: 'mobile', viewport: { width: 390, height: 844 } }],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterApplyMs: 0,
      reloadBetweenVariants: false,
    } as any, response)).rejects.toThrow('axe crashed');

    const lastViewportCall = mockPage.setViewportSize.mock.calls.at(-1);
    const lastMediaCall = mockPage.emulateMedia.mock.calls.at(-1);
    const lastEvaluateCall = mockPage.evaluate.mock.calls.at(-1);
    expect(lastViewportCall?.[0]).toEqual({ width: 1440, height: 900 });
    expect(lastMediaCall?.[0]).toEqual({
      colorScheme: null,
      forcedColors: null,
      contrast: null,
      reducedMotion: null,
    });
    expect(lastEvaluateCall?.[1]).toBe('125%');
  });

  it('writes report using custom reportFile name', async () => {
    const evaluateMock = vi.fn()
        .mockResolvedValueOnce('')
        .mockResolvedValue(undefined);

    const mockPage = {
      url: vi.fn(() => 'https://example.com/page'),
      viewportSize: vi.fn(() => ({ width: 1024, height: 768 })),
      setViewportSize: vi.fn(async () => undefined),
      emulateMedia: vi.fn(async () => undefined),
      evaluate: evaluateMock,
      reload: vi.fn(async () => undefined),
    };

    const mockTab = {
      page: mockPage,
      waitForTimeout: vi.fn(async () => undefined),
      modalStates: vi.fn(() => []),
      context: {
        outputFile: vi.fn(async (name: string) => `/tmp/${name}`),
      },
    };

    const mockContext = {
      currentTabOrDie: vi.fn(() => mockTab),
      config: {},
    };

    const response = new Response(mockContext as any, 'scan_page_matrix', {});
    vi.spyOn(axe, 'runAxeScan').mockResolvedValue(createAxeResult('https://example.com/page', ['color-contrast']));

    await tool.handle(mockContext as any, {
      variants: [{ name: 'baseline' }],
      violationsTag: ['wcag2aa'],
      maxNodesPerViolation: 10,
      waitAfterApplyMs: 0,
      reloadBetweenVariants: false,
      reportFile: 'my-matrix.json',
    } as any, response);

    expect(writeFileSpy).toHaveBeenCalledWith('/tmp/my-matrix.json', expect.any(String), 'utf-8');
    expect(response.result()).toContain('JSON report: /tmp/my-matrix.json');
  });
});
