import fs from 'fs';
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
  type TrimmedAxeViolation
} from './axe.js';

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
  violations: TrimmedAxeViolation[];
  nodeCountByRuleId: Record<string, number>;
  diffFromBaseline: {
    newViolationIds: string[];
    resolvedViolationIds: string[];
    changedCounts: Record<string, { baseline: number; variant: number }>;
  };
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
  violationsTag: z.array(z.enum(axeTagValues)).min(1).default([...axeTagValues]).describe('Axe tags to include in scans.'),
  maxNodesPerViolation: z.number().int().min(1).max(50).default(10).describe('Maximum nodes kept per violation in the report.'),
  waitAfterApplyMs: z.number().int().min(0).max(5000).default(250).describe('Wait after applying each variant before scanning.'),
  reloadBetweenVariants: z.boolean().default(false).describe('Reload page between variants.'),
  reportFile: z.string().optional().describe('Output JSON report file name.'),
});

function normalizeMedia(variantMedia: z.output<typeof variantSchema>['media'] | undefined) {
  return {
    colorScheme: variantMedia?.colorScheme ?? null,
    forcedColors: variantMedia?.forcedColors ?? null,
    contrast: variantMedia?.contrast ?? null,
    reducedMotion: variantMedia?.reducedMotion ?? null,
  };
}

function safeIsoTimestampForFileName() {
  return sanitizeForFilePath(new Date().toISOString());
}

function countNodesByRule(violations: TrimmedAxeViolation[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const violation of violations)
    counts[violation.id] = (counts[violation.id] ?? 0) + violation.nodes.length;
  return counts;
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
    const variants = params.variants ?? defaultVariants;
    const originalViewport = tab.page.viewportSize() ?? await tab.page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    const originalZoom = await tab.page.evaluate(() => document.documentElement.style.zoom || '');

    const variantResults: VariantResult[] = [];
    try {
      for (const variant of variants) {
        await tab.page.setViewportSize(originalViewport);
        await tab.page.emulateMedia({
          colorScheme: null,
          forcedColors: null,
          contrast: null,
          reducedMotion: null,
        });
        await tab.page.evaluate(zoom => {
          document.documentElement.style.zoom = zoom;
        }, originalZoom);

        if (variant.viewport)
          await tab.page.setViewportSize(variant.viewport);

        if (variant.media) {
          await tab.page.emulateMedia({
            colorScheme: variant.media.colorScheme ?? null,
            forcedColors: variant.media.forcedColors ?? null,
            contrast: variant.media.contrast ?? null,
            reducedMotion: variant.media.reducedMotion ?? null,
          });
        }

        if (variant.zoomPercent !== undefined) {
          await tab.page.evaluate(zoomPercent => {
            document.documentElement.style.zoom = `${zoomPercent}%`;
          }, variant.zoomPercent);
        }

        if (params.reloadBetweenVariants)
          await tab.page.reload({ waitUntil: 'domcontentloaded' });

        await tab.waitForTimeout(params.waitAfterApplyMs);

        const axeResult = await runAxeScan(tab.page, params.violationsTag as AxeTag[]);
        const dedupedViolations = axeResult.violations.map(violation => ({
          ...violation,
          nodes: dedupeAxeNodes(violation.nodes),
        }));
        const trimmedViolations = trimAxeResults({ violations: dedupedViolations }, { maxNodesPerViolation: params.maxNodesPerViolation });
        const nodeCountByRuleId = countNodesByRule(trimmedViolations);

        variantResults.push({
          name: variant.name,
          applied: {
            viewport: variant.viewport ?? null,
            media: normalizeMedia(variant.media),
            zoomPercent: variant.zoomPercent ?? null,
          },
          summary: summarizeAxeViolations(trimmedViolations),
          violations: trimmedViolations,
          nodeCountByRuleId,
          diffFromBaseline: {
            newViolationIds: [],
            resolvedViolationIds: [],
            changedCounts: {},
          },
        });
      }

      const baselineCounts = variantResults[0]?.nodeCountByRuleId ?? {};
      for (const result of variantResults)
        result.diffFromBaseline = computeDiffFromBaseline(baselineCounts, result.nodeCountByRuleId);
    } finally {
      await tab.page.setViewportSize(originalViewport);
      await tab.page.emulateMedia({
        colorScheme: null,
        forcedColors: null,
        contrast: null,
        reducedMotion: null,
      });
      await tab.page.evaluate(zoom => {
        document.documentElement.style.zoom = zoom;
      }, originalZoom);
    }

    const report = {
      version: 'v1',
      metadata: {
        url: tab.page.url(),
        baselineVariant: variantResults[0]?.name ?? 'baseline',
        options: {
          violationsTag: params.violationsTag,
          maxNodesPerViolation: params.maxNodesPerViolation,
          waitAfterApplyMs: params.waitAfterApplyMs,
          reloadBetweenVariants: params.reloadBetweenVariants,
        },
        generatedAt: new Date().toISOString(),
      },
      variants: variantResults,
    };

    const reportFileName = sanitizeForFilePath(params.reportFile ?? `scan-matrix-${safeIsoTimestampForFileName()}.json`);
    const reportPath = await tab.context.outputFile(reportFileName);
    await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');

    const lines = [
      'Variant | Violations | Nodes | Top new vs baseline',
      '--- | --- | --- | ---',
      ...variantResults.map(result => {
        const topNew = result.diffFromBaseline.newViolationIds.slice(0, 5).join(', ') || '-';
        return `${result.name} | ${result.summary.totalRules} | ${result.summary.totalNodes} | ${topNew}`;
      }),
      '',
      `JSON report: ${reportPath}`,
    ];
    response.addCode('// Applied viewport/media/zoom variants and compared Axe deltas against baseline.');
    response.addResult(lines.join('\n'));
  },
});

export default [
  scanPageMatrix,
];
