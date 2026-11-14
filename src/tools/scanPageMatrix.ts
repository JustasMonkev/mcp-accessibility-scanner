import { z } from 'zod';
import type * as playwright from 'playwright';
import { defineTabTool } from './tool.js';
import { reserveReportPath, writeJsonReport } from './report.js';
import type { JsonReportResource } from './report.js';
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

import type { Tab } from '../tab.js';

type VariantResult = {
  name: string;
  applied: {
    viewport: { width: number; height: number } | null;
    media: {
      colorScheme: 'light' | 'dark' | null;
      forcedColors: 'active' | 'none' | null;
      contrast: 'more' | 'no-preference' | null;
      reducedMotion: 'reduce' | 'no-preference' | null;
    };
    zoomPercent: number | null;
  };
  summary: ReturnType<typeof summarizeAxeViolations>;
  violations: AxeViolation[];
  incomplete: AxeViolation[];
  unscannedFrames: string[];
  nodeCountByRuleId: Record<string, number>;
  comparisonIncompleteRuleIds: string[];
  diffFromBaseline: {
    newViolationIds: string[];
    resolvedViolationIds: string[];
    changedCounts: Record<string, { baseline: number; variant: number }>;
  } | null;
};

const variantSchema = z.object({
  name: z.string().min(1).describe('Variant name.'),
  viewport: z.object({
    width: z.number().int().min(1),
    height: z.number().int().min(1),
  }).optional(),
  media: z.object({
    colorScheme: z.enum(['light', 'dark']).optional(),
    forcedColors: z.enum(['active', 'none']).optional(),
    contrast: z.enum(['more', 'no-preference']).optional(),
    reducedMotion: z.enum(['reduce', 'no-preference']).optional(),
  }).optional(),
  zoomPercent: z.number().int().min(50).max(400).optional(),
});

const defaultVariants: z.output<typeof variantSchema>[] = [
  {
    name: 'baseline',
  },
  {
    name: 'mobile',
    viewport: { width: 375, height: 812 },
  },
  {
    name: 'desktop',
    viewport: { width: 1280, height: 720 },
  },
  {
    name: 'forced-colors',
    media: { forcedColors: 'active', contrast: 'more' },
  },
  {
    name: 'reduced-motion',
    media: { reducedMotion: 'reduce' },
  },
  {
    name: 'zoom-200',
    zoomPercent: 200,
  },
];

const scanPageMatrixSchema = z.object({
  variants: z.array(variantSchema).min(1).optional().describe('Variant list to run. Defaults to baseline/mobile/desktop/forced-colors/reduced-motion/zoom-200.'),
  includeIncomplete: z.boolean().default(true).describe('Also report Axe "incomplete" results per variant — checks Axe could not decide automatically.'),
  waitAfterApplyMs: z.number().int().min(0).max(5000).default(250).describe('Wait after applying each variant before scanning.'),
  reloadBetweenVariants: z.boolean().default(false).describe('Reload page between variants.'),
  ...axeScanSchemaShape,
  ...axeScopeSchemaShape,
  ...axeRuleSchemaShape,
});

type MediaState = VariantResult['applied']['media'];

async function readPageState(page: playwright.Page): Promise<{ zoom: string, media: MediaState }> {
  return await page.evaluate(() => {
    const firstMatching = <T extends string>(feature: string, values: T[]): T | null =>
      values.find(value => matchMedia(`(${feature}: ${value})`).matches) ?? null;
    return {
      zoom: document.documentElement.style.zoom || '',
      media: {
        colorScheme: firstMatching('prefers-color-scheme', ['dark', 'light']),
        forcedColors: firstMatching('forced-colors', ['active']) ?? 'none',
        reducedMotion: firstMatching('prefers-reduced-motion', ['reduce']) ?? 'no-preference',
        contrast: firstMatching('prefers-contrast', ['more', 'no-preference']),
      },
    };
  });
}

function normalizeMedia(variantMedia: z.output<typeof variantSchema>['media'] | undefined, original: MediaState): MediaState {
  return {
    colorScheme: variantMedia?.colorScheme ?? original.colorScheme,
    forcedColors: variantMedia?.forcedColors ?? original.forcedColors,
    contrast: variantMedia?.contrast ?? original.contrast,
    reducedMotion: variantMedia?.reducedMotion ?? original.reducedMotion,
  };
}

function computeDiffFromBaseline(
  baselineCounts: Record<string, number>,
  variantCounts: Record<string, number>
): VariantResult['diffFromBaseline'] {
  const baselineIds = Object.keys(baselineCounts);
  const variantIds = Object.keys(variantCounts);
  const newViolationIds = variantIds.filter(id => !baselineCounts[id]).sort();
  const resolvedViolationIds = baselineIds.filter(id => !variantCounts[id]).sort();
  const changedCounts: Record<string, { baseline: number; variant: number }> = {};
  const allIds = new Set([...baselineIds, ...variantIds]);
  for (const id of allIds) {
    const baseline = baselineCounts[id] ?? 0;
    const variant = variantCounts[id] ?? 0;
    if (baseline !== variant)
      changedCounts[id] = { baseline, variant };
  }
  return { newViolationIds, resolvedViolationIds, changedCounts };
}

type Variant = z.output<typeof variantSchema>;
type ScanPageMatrixParams = z.output<typeof scanPageMatrixSchema>;
type PageState = { viewport: { width: number, height: number }, zoom: string, media: MediaState };

async function capturePageState(page: playwright.Page): Promise<PageState> {
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const { zoom, media } = await readPageState(page);
  return { viewport, zoom, media };
}

async function setZoom(page: playwright.Page, zoom: string): Promise<void> {
  await page.evaluate(value => {
    document.documentElement.style.zoom = value;
  }, zoom);
}

async function restorePageState(page: playwright.Page, original: PageState): Promise<void> {
  await page.setViewportSize(original.viewport);
  await page.emulateMedia(original.media);
  await setZoom(page, original.zoom);
}

async function scanVariant(tab: Tab, variant: Variant, original: PageState, params: ScanPageMatrixParams): Promise<{ result: VariantResult, incompleteRuleIds: string[] }> {
  await tab.page.setViewportSize(variant.viewport ?? original.viewport);
  const media = normalizeMedia(variant.media, original.media);
  await tab.page.emulateMedia(media);
  if (params.reloadBetweenVariants)
    await tab.page.reload({ waitUntil: 'domcontentloaded' });
  await setZoom(tab.page, variant.zoomPercent !== undefined ? `${variant.zoomPercent}%` : original.zoom);
  await tab.waitForTimeout(params.waitAfterApplyMs);

  const axeResult = await runAxeScan(tab.page, axeScanOptions(params));
  const violations = prepareAxeResults(axeResult.violations, params.maxNodesPerViolation);
  const summary = summarizeAxeViolations(violations.deduped);
  return {
    incompleteRuleIds: axeResult.incomplete.map(result => result.id),
    result: {
      name: variant.name,
      applied: {
        viewport: variant.viewport ?? null,
        media,
        zoomPercent: variant.zoomPercent ?? null,
      },
      summary,
      unscannedFrames: axeResult.unscannedFrames,
      violations: violations.trimmed,
      incomplete: params.includeIncomplete
        ? prepareAxeResults(axeResult.incomplete, params.maxNodesPerViolation).trimmed
        : [],
      nodeCountByRuleId: summary.byRuleId,
      comparisonIncompleteRuleIds: [],
      diffFromBaseline: null,
    },
  };
}

function compareWithBaseline(variantResults: VariantResult[], incompleteRuleIdsByVariant: string[][]): void {
  const baseline = variantResults[0];
  const baselineCounts = baseline?.nodeCountByRuleId ?? {};
  for (const [index, result] of variantResults.entries()) {
    const violatedRuleIds = new Set([...Object.keys(baselineCounts), ...Object.keys(result.nodeCountByRuleId)]);
    result.comparisonIncompleteRuleIds = [...new Set([
      ...incompleteRuleIdsByVariant[0],
      ...incompleteRuleIdsByVariant[index],
    ])].filter(id => violatedRuleIds.has(id)).sort();
    const comparable = !result.unscannedFrames.length && !baseline?.unscannedFrames.length && !result.comparisonIncompleteRuleIds.length;
    result.diffFromBaseline = comparable
      ? computeDiffFromBaseline(baselineCounts, result.nodeCountByRuleId)
      : null;
  }
}

function renderMatrixTable(variantResults: VariantResult[], includeIncomplete: boolean, reportPath: string): string {
  const baselineMissedFrames = !!variantResults[0]?.unscannedFrames.length;
  const variantsWithUnscannedFrames = variantResults.filter(result => result.unscannedFrames.length);
  return [
    ...unscannedFrameLines(
        variantsWithUnscannedFrames.map(result => `${result.name}: ${result.unscannedFrames.join(', ')}`),
        {
          unit: 'variant(s)',
          trailingLines: [
            'Baseline deltas are reported as "n/a" wherever the two scans did not cover the same documents.',
            '',
          ],
        }
    ),
    'Variant | Violations | Nodes | Incomplete | Top new vs baseline',
    '--- | --- | --- | --- | ---',
    ...variantResults.map(result => {
      const notComparableReasons: string[] = [];
      if (result.unscannedFrames.length || baselineMissedFrames)
        notComparableReasons.push('coverage differs');
      if (result.comparisonIncompleteRuleIds.length)
        notComparableReasons.push(`incomplete checks: ${result.comparisonIncompleteRuleIds.join(', ')}`);
      const topNew = result.diffFromBaseline
        ? result.diffFromBaseline.newViolationIds.slice(0, 5).join(', ') || '-'
        : `n/a (${notComparableReasons.join('; ')})`;
      const incomplete = includeIncomplete ? String(result.incomplete.length) : '-';
      return `${result.name} | ${result.summary.totalRules} | ${result.summary.totalNodes} | ${incomplete} | ${topNew}`;
    }),
    '',
    `JSON report: ${reportPath}`,
  ].join('\n');
}

function buildMatrixReport(url: string, variantResults: VariantResult[], params: ScanPageMatrixParams) {
  return {
    version: 'v2',
    metadata: {
      url,
      baselineVariant: variantResults[0]?.name ?? 'baseline',
      options: {
        violationsTag: params.violationsTag,
        includeIncomplete: params.includeIncomplete,
        includeSelectors: params.includeSelectors ?? null,
        excludeSelectors: params.excludeSelectors ?? null,
        withRules: params.withRules ?? null,
        disableRules: params.disableRules ?? null,
        maxNodesPerViolation: params.maxNodesPerViolation,
        waitAfterApplyMs: params.waitAfterApplyMs,
        reloadBetweenVariants: params.reloadBetweenVariants,
      },
      generatedAt: new Date().toISOString(),
    },
    variants: variantResults,
  };
}

function matrixStructuredContent(report: ReturnType<typeof buildMatrixReport>, reportResource: JsonReportResource, includeIncomplete: boolean) {
  return {
    kind: 'scan_page_matrix',
    version: 'v2',
    report: reportResource,
    page: {
      url: report.metadata.url,
    },
    baselineVariant: report.metadata.baselineVariant,
    variants: report.variants.map(result => ({
      name: result.name,
      totalViolations: result.summary.totalRules,
      totalNodes: result.summary.totalNodes,
      totalIncomplete: includeIncomplete ? result.incomplete.length : null,
      unscannedFrames: result.unscannedFrames,
      comparisonIncompleteRuleIds: result.comparisonIncompleteRuleIds,
      newViolationIds: result.diffFromBaseline?.newViolationIds ?? null,
      resolvedViolationIds: result.diffFromBaseline?.resolvedViolationIds ?? null,
      changedRuleIds: result.diffFromBaseline ? Object.keys(result.diffFromBaseline.changedCounts) : null,
      reportUri: reportResource.uri,
    })),
  };
}

const scanPageMatrix = defineTabTool({
  capability: 'core',
  schema: {
    name: 'scan_page_matrix',
    title: 'Scan accessibility variants',
    description: 'Run accessibility scans across viewport/media/zoom variants and compare with baseline.',
    inputSchema: scanPageMatrixSchema,
    type: 'destructive',
  },

  handle: async (tab, params, response) => {
    assertRuleOptionsValid({ rules: params.withRules, disableRules: params.disableRules });

    const reportPath = await reserveReportPath(tab.context, response, params.reportFile, 'scan-matrix');
    const variants = params.variants ?? defaultVariants;
    const original = await capturePageState(tab.page);

    const variantResults: VariantResult[] = [];
    const incompleteRuleIdsByVariant: string[][] = [];
    try {
      for (const variant of variants) {
        const { result, incompleteRuleIds } = await scanVariant(tab, variant, original, params);
        variantResults.push(result);
        incompleteRuleIdsByVariant.push(incompleteRuleIds);
        await response.reportProgress({
          progress: variantResults.length,
          total: variants.length,
          message: `Scanned variant ${variantResults.length}/${variants.length}: ${variant.name}`,
        });
      }
      compareWithBaseline(variantResults, incompleteRuleIdsByVariant);
    } finally {
      await restorePageState(tab.page, original);
    }

    const report = buildMatrixReport(tab.page.url(), variantResults, params);
    const reportResource = await writeJsonReport(response, reportPath, report, {
      name: 'scan-page-matrix-report',
      title: 'Scan page matrix JSON report',
      description: 'JSON report containing per-variant Axe results and baseline deltas.',
    });
    response.setStructuredContent(matrixStructuredContent(report, reportResource, params.includeIncomplete));

    response.addCode('// Applied viewport/media/zoom variants and compared Axe deltas against baseline.');
    response.addResult(renderMatrixTable(variantResults, params.includeIncomplete, reportResource.path));
  },
});

export default [
  scanPageMatrix,
];
