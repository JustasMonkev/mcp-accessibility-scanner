import fs from 'node:fs';
import { z } from 'zod';
import type * as playwright from 'playwright';
import { defineTabTool } from './tool.js';
import { sanitizeForFilePath } from '../utils/fileUtils.js';
import {
  assertRuleOptionsValid,
  axeRuleSchemaShape,
  axeScopeSchemaShape,
  axeTagValues,
  defaultAxeTags,
  prepareAxeResults,
  runAxeScan,
  summarizeAxeViolations,
  type AxeTag,
  type AxeViolation,
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
  violations: AxeViolation[];
  incomplete: AxeViolation[];
  // Frames Axe never reached for this variant, so a variant that looks clean is
  // distinguishable from one that was only partly scanned.
  unscannedFrames: string[];
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
  violationsTag: z.array(z.enum(axeTagValues)).min(1).default([...defaultAxeTags]).describe('Axe tags to include in scans.'),
  includeIncomplete: z.boolean().default(true).describe('Also collect Axe "incomplete" results per variant — checks Axe could not decide automatically.'),
  maxNodesPerViolation: z.number().int().min(1).max(50).default(10).describe('Maximum nodes kept per violation in the report.'),
  waitAfterApplyMs: z.number().int().min(0).max(5000).default(250).describe('Wait after applying each variant before scanning.'),
  reloadBetweenVariants: z.boolean().default(false).describe('Reload page between variants.'),
  reportFile: z.string().optional().describe('Output JSON report file name.'),
  ...axeScopeSchemaShape,
  ...axeRuleSchemaShape,
});

type MediaState = VariantResult['applied']['media'];

// Playwright has no getter for a page's media emulation, and passing null to
// emulateMedia resets a feature to the browser default rather than to whatever
// the context was created with: a context made with `colorScheme: 'dark'` reads
// light again after a null. So the effective state is measured from the page
// before the first variant and used both as the per-variant fallback and to put
// the page back afterwards - the same way the viewport and zoom already are.
async function readPageState(page: playwright.Page): Promise<{ zoom: string, media: MediaState }> {
  return await page.evaluate(() => ({
    zoom: document.documentElement.style.zoom || '',
    media: {
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' as const : 'light' as const,
      forcedColors: matchMedia('(forced-colors: active)').matches ? 'active' as const : 'none' as const,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' as const : 'no-preference' as const,
      // `less` and `custom` are values emulateMedia cannot express. Leaving the
      // feature un-emulated reproduces them exactly, naming a value cannot.
      contrast: matchMedia('(prefers-contrast: more)').matches
        ? 'more' as const
        : matchMedia('(prefers-contrast: no-preference)').matches ? 'no-preference' as const : null,
    },
  }));
}

// An unset property means "whatever this page had before the scan started", not
// "the browser default" - undoing the previous variant must not also undo the
// media emulation the session was configured with.
function normalizeMedia(variantMedia: z.output<typeof variantSchema>['media'] | undefined, original: MediaState): MediaState {
  return {
    colorScheme: variantMedia?.colorScheme ?? original.colorScheme,
    forcedColors: variantMedia?.forcedColors ?? original.forcedColors,
    contrast: variantMedia?.contrast ?? original.contrast,
    reducedMotion: variantMedia?.reducedMotion ?? original.reducedMotion,
  };
}

function safeIsoTimestampForFileName() {
  return sanitizeForFilePath(new Date().toISOString());
}

function countNodesByRule(violations: { id: string; nodes: unknown[] }[]): Record<string, number> {
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
    // Rule ids apply to the whole run, so a bad one must fail before the first
    // variant is applied. The finally block restores viewport/media/zoom, but
    // reloadBetweenVariants has already thrown away form and application state
    // by the time the per-scan check would reject the argument.
    assertRuleOptionsValid({ rules: params.withRules, disableRules: params.disableRules });

    const variants = params.variants ?? defaultVariants;
    const originalViewport = tab.page.viewportSize() ?? await tab.page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    const { zoom: originalZoom, media: originalMedia } = await readPageState(tab.page);

    const variantResults: VariantResult[] = [];
    try {
      for (const variant of variants) {
        // Apply each property once per variant: the variant value when set,
        // otherwise the original page state (undoing the previous variant).
        // Strictly in this order, not in parallel: a page that reacts to a
        // viewport or media change by writing document.documentElement.style.zoom
        // would overwrite a zoom applied alongside it, and the variant would be
        // scanned - and reported - at a zoom it never actually had.
        await tab.page.setViewportSize(variant.viewport ?? originalViewport);
        await tab.page.emulateMedia(normalizeMedia(variant.media, originalMedia));

        // Before the zoom, not after it. Viewport and media emulation survive a
        // reload, but the zoom is an inline style on documentElement and the new
        // document does not have it - applying it first would scan the variant
        // unzoomed while `applied.zoomPercent` still claimed the requested zoom.
        if (params.reloadBetweenVariants)
          await tab.page.reload({ waitUntil: 'domcontentloaded' });

        await tab.page.evaluate(zoom => {
          document.documentElement.style.zoom = zoom;
        }, variant.zoomPercent !== undefined ? `${variant.zoomPercent}%` : originalZoom);

        await tab.waitForTimeout(params.waitAfterApplyMs);

        const axeResult = await runAxeScan(tab.page, {
          tags: params.violationsTag as AxeTag[],
          rules: params.withRules,
          disableRules: params.disableRules,
          include: params.includeSelectors,
          exclude: params.excludeSelectors,
        });
        const violations = prepareAxeResults(axeResult.violations, params.maxNodesPerViolation);
        const nodeCountByRuleId = countNodesByRule(violations.deduped);

        variantResults.push({
          name: variant.name,
          applied: {
            viewport: variant.viewport ?? null,
            media: normalizeMedia(variant.media, originalMedia),
            zoomPercent: variant.zoomPercent ?? null,
          },
          summary: summarizeAxeViolations(violations.trimmed),
          unscannedFrames: axeResult.unscannedFrames,
          violations: violations.trimmed,
          incomplete: params.includeIncomplete
            ? prepareAxeResults(axeResult.incomplete, params.maxNodesPerViolation).trimmed
            : [],
          nodeCountByRuleId,
          diffFromBaseline: {
            newViolationIds: [],
            resolvedViolationIds: [],
            changedCounts: {},
          },
        });

        await response.reportProgress({
          progress: variantResults.length,
          total: variants.length,
          message: `Scanned variant ${variantResults.length}/${variants.length}: ${variant.name}`,
        });
      }

      const baselineCounts = variantResults[0]?.nodeCountByRuleId ?? {};
      for (const result of variantResults)
        result.diffFromBaseline = computeDiffFromBaseline(baselineCounts, result.nodeCountByRuleId);
    } finally {
      // Same ordering as the apply path, and for the same reason.
      await tab.page.setViewportSize(originalViewport);
      await tab.page.emulateMedia(originalMedia);
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

    const reportFileName = sanitizeForFilePath(params.reportFile ?? `scan-matrix-${safeIsoTimestampForFileName()}.json`);
    const reportPath = await tab.context.outputFile(reportFileName);
    await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    const reportResourceLink = response.addFileResourceLink(reportPath, {
      name: 'scan-page-matrix-report',
      title: 'Scan page matrix JSON report',
      description: 'JSON report containing per-variant Axe results and baseline deltas.',
      mimeType: 'application/json',
    });
    response.setStructuredContent({
      kind: 'scan_page_matrix',
      report: {
        path: reportPath,
        uri: reportResourceLink.uri,
        name: reportResourceLink.name,
        title: reportResourceLink.title ?? null,
        mimeType: reportResourceLink.mimeType ?? null,
      },
      page: {
        url: tab.page.url(),
      },
      baselineVariant: report.metadata.baselineVariant,
      variants: variantResults.map(result => ({
        name: result.name,
        totalViolations: result.summary.totalRules,
        totalNodes: result.summary.totalNodes,
        // null, not 0, when collection is off: structuredContent does not carry
        // includeIncomplete, so a 0 here is indistinguishable from a variant
        // with no needs-review findings. Matches the "-" in the markdown table.
        totalIncomplete: params.includeIncomplete ? result.incomplete.length : null,
        // Without this a client reading only structured output cannot tell a
        // partly-scanned variant from a clean one.
        unscannedFrames: result.unscannedFrames,
        newViolationIds: result.diffFromBaseline.newViolationIds,
        resolvedViolationIds: result.diffFromBaseline.resolvedViolationIds,
        changedRuleIds: Object.keys(result.diffFromBaseline.changedCounts),
        reportUri: reportResourceLink.uri,
      })),
    });

    const variantsWithUnscannedFrames = variantResults.filter(result => result.unscannedFrames.length);
    const lines = [
      ...(variantsWithUnscannedFrames.length ? [
        `WARNING: Axe could not be installed in frames on ${variantsWithUnscannedFrames.length} variant(s); their contents were not scanned and contribute no findings below.`,
        ...variantsWithUnscannedFrames.map(result => `- ${result.name}: ${result.unscannedFrames.join(', ')}`),
        '',
      ] : []),
      'Variant | Violations | Nodes | Incomplete | Top new vs baseline',
      '--- | --- | --- | --- | ---',
      ...variantResults.map(result => {
        const topNew = result.diffFromBaseline.newViolationIds.slice(0, 5).join(', ') || '-';
        // "-" rather than 0: with collection off, 0 is indistinguishable from
        // "no needs-review findings". audit_site omits its section for the same
        // reason.
        const incomplete = params.includeIncomplete ? String(result.incomplete.length) : '-';
        return `${result.name} | ${result.summary.totalRules} | ${result.summary.totalNodes} | ${incomplete} | ${topNew}`;
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
