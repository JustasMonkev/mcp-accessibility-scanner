import { rejectOnAbort } from '../utils/timeout.js';
import { z } from 'zod';
import type * as playwright from 'playwright';
import { defineTabTool } from './tool.js';
import type { ModalState } from './tool.js';
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
import type { Response } from '../response.js';
import { logUnhandledError } from '../utils/log.js';

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
type PageState = { viewport: { width: number, height: number } | null, zoom: string, media: MediaState };

async function capturePageState(page: playwright.Page): Promise<PageState> {
  const viewport = page.viewportSize();
  const { zoom, media } = await readPageState(page);
  return { viewport, zoom, media };
}

async function setZoom(page: playwright.Page, zoom: string): Promise<void> {
  await page.evaluate(value => {
    document.documentElement.style.zoom = value;
  }, zoom);
}

// A canceled restore stops at its next step, so a page left to other clients
// is not reset once a dialog that paused it closes.
async function restorePageState(page: playwright.Page, original: PageState, canceled: AbortSignal): Promise<void> {
  canceled.throwIfAborted();
  if (original.viewport)
    await page.setViewportSize(original.viewport);
  canceled.throwIfAborted();
  await page.emulateMedia(original.media);
  canceled.throwIfAborted();
  await setZoom(page, original.zoom);
}

// Where a dialog interrupted the scan. Before any variant was applied there
// is nothing to restore.
type DialogPhase = { variant: string } | 'capture' | 'finishing' | 'restore';
const dialogPhaseWhere = {
  finishing: 'after the last variant was scanned',
  restore: 'while the original state was being restored',
};

// The modal-state guidance names the tool that answers the dialog, or says
// this server blocks it; context.tools leaves out blocked tools.
function dialogInterruption(tab: Tab, phase: DialogPhase): Error {
  if (phase === 'capture') {
    return new Error([
      'The page opened a dialog while the matrix scan was reading its original viewport, media and zoom, so the scan stopped before applying any variant; the page was not changed.',
      ...tab.modalStatesMarkdown(),
    ].join('\n'));
  }
  const where = typeof phase === 'object' ? `during variant "${phase.variant}"` : dialogPhaseWhere[phase];
  const teardown = tab.context.tools.some(tool => tool.schema.name === 'browser_close') ? ' Closing the browser with browser_close cancels the restore instead.' : '';
  return new Error([
    `The page opened a dialog ${where} that the matrix scan does not answer, so the scan stopped. The paused page cannot be restored until the dialog closes; the server will attempt to restore the original viewport, media and zoom once it does, so verify them before continuing.${teardown}`,
    ...tab.modalStatesMarkdown(),
  ].join('\n'));
}

// A dialog pauses the page, so every page command issued after it waits.
function watchForDialog(tab: Tab) {
  const controller = new AbortController();
  const { promise: opened, resolve: open } = Promise.withResolvers<void>();
  let dialog: ModalState | undefined;
  const onModalState = (state: ModalState) => {
    if (state.type !== 'dialog' || dialog)
      return;
    dialog = state;
    controller.abort(new Error('A dialog interrupted the matrix scan.'));
    open();
  };
  tab.on('modalState', onModalState);
  const present = tab.modalStates().find(state => state.type === 'dialog');
  if (present)
    onModalState(present);
  return {
    signal: controller.signal,
    guard: async <T>(work: Promise<T>, phase: DialogPhase): Promise<T> => {
      // Work can also fail because the dialog aborted it; report the dialog either way.
      const outcome = await Promise.race([work.then(value => ({ value })), opened]).catch((error: unknown) => {
        if (!dialog)
          throw error;
      });
      if (dialog)
        throw dialogInterruption(tab, phase);
      return (outcome as { value: T }).value;
    },
    dispose: () => tab.off('modalState', onModalState),
  };
}

type MatrixRun = {
  tab: Tab;
  variants: Variant[];
  original: PageState;
  params: ScanPageMatrixParams;
  response: Response;
  dialog: ReturnType<typeof watchForDialog>;
  signal?: AbortSignal;
  // Aborted when the browser context closes while the page is still claimed.
  canceled: AbortSignal;
};

async function scanVariants({ tab, variants, original, params, response, dialog, signal, canceled }: MatrixRun, trackRestore: (restore: Promise<void>) => void): Promise<VariantResult[]> {
  const scanSignal = signal ? AbortSignal.any([signal, dialog.signal]) : dialog.signal;
  let inFlight: Promise<unknown> = Promise.resolve();
  const variantResults: VariantResult[] = [];
  const incompleteRuleIdsByVariant: string[][] = [];
  let restoredInCall = false;
  try {
    for (const variant of variants) {
      const scanning = scanVariant(tab, variant, original, params, scanSignal);
      inFlight = scanning;
      const { result, incompleteRuleIds } = await dialog.guard(scanning, { variant: variant.name });
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
    // An interrupted variant unwinds at its next step once the dialog closes;
    // restoring only after that keeps it from reapplying variant state. While
    // a dialog stays open the restore finishes in the background, still
    // holding the page claim, so the call can report the dialog now. Closing
    // the browser context cancels it.
    const restore = inFlight.catch(() => {}).then(() => restorePageState(tab.page, original, canceled));
    trackRestore(restore);
    if (!dialog.signal.aborted) {
      await dialog.guard(restore, 'restore');
      restoredInCall = true;
    }
  }
  // A dialog opened after the last guarded step, for instance while the last
  // progress notification was sent, left the restore waiting on it.
  if (!restoredInCall)
    throw dialogInterruption(tab, 'finishing');
  return variantResults;
}

async function scanVariant(tab: Tab, variant: Variant, original: PageState, params: ScanPageMatrixParams, signal?: AbortSignal): Promise<{ result: VariantResult, incompleteRuleIds: string[] }> {
  signal?.throwIfAborted();
  const viewport = variant.viewport ?? original.viewport;
  if (viewport)
    await tab.page.setViewportSize(viewport);
  signal?.throwIfAborted();
  const media = normalizeMedia(variant.media, original.media);
  await tab.page.emulateMedia(media);
  signal?.throwIfAborted();
  if (params.reloadBetweenVariants)
    await tab.page.reload({ waitUntil: 'domcontentloaded' });
  signal?.throwIfAborted();
  await setZoom(tab.page, variant.zoomPercent !== undefined ? `${variant.zoomPercent}%` : original.zoom);
  await rejectOnAbort(() => tab.waitForTimeout(params.waitAfterApplyMs), signal);

  signal?.throwIfAborted();
  const axeResult = await runAxeScan(tab.page, axeScanOptions(params));
  signal?.throwIfAborted();
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
  // Each call captures and restores viewport, media and zoom; an overlapping
  // call in the same context would scan the other's variant or restore its
  // temporary state as the final one.
  exclusive: true,

  handle: async (tab, params, response, signal) => {
    signal?.throwIfAborted();
    assertRuleOptionsValid({ rules: params.withRules, disableRules: params.disableRules });

    const reportPath = await reserveReportPath(tab.context, response, params.reportFile, 'scan-matrix');
    const variants = params.variants ?? defaultVariants;
    // Claimed before capturing, so an overlapping scan cannot record another
    // scan's variant as the original state, and other clients sharing the
    // page cannot change it under this scan.
    const claim = tab.context.claimPage('scan_page_matrix', tab.page);
    // Watched before the first page read: a dialog opened by that read pauses
    // it, and nothing would report it.
    const dialog = watchForDialog(tab);
    let restored: Promise<void> = Promise.resolve();
    let variantResults: VariantResult[];
    try {
      const original = await dialog.guard(capturePageState(tab.page), 'capture');
      if (!original.viewport && variants.some(variant => variant.viewport))
        throw new Error('Viewport variants require a configured viewport (for example --viewport-size=1280,720). Native viewport sizing cannot be restored; use variants without viewport changes on this tab.');
      signal?.throwIfAborted();
      variantResults = await scanVariants({ tab, variants, original, params, response, dialog, signal, canceled: claim.canceled }, restore => {
        restored = restore;
      });
    } finally {
      dialog.dispose();
      // After a dialog the restore can outlive this call; until it settles,
      // other tools could change the page and have their changes overwritten.
      tab.context.holdExclusiveUntil('scan_page_matrix', restored);
      void restored.catch(error => {
        if (!claim.canceled.aborted)
          logUnhandledError(error);
      }).finally(claim.release);
    }

    signal?.throwIfAborted();
    const report = buildMatrixReport(tab.page.url(), variantResults, params);
    response.deleteFileOnError(reportPath);
    const reportResource = await writeJsonReport(response, reportPath, report, {
      name: 'scan-page-matrix-report',
      title: 'Scan page matrix JSON report',
      description: 'JSON report containing per-variant Axe results and baseline deltas.',
    });
    signal?.throwIfAborted();
    response.setStructuredContent(matrixStructuredContent(report, reportResource, params.includeIncomplete));

    response.addCode('// Applied viewport/media/zoom variants and compared Axe deltas against baseline.');
    response.addResult(renderMatrixTable(variantResults, params.includeIncomplete, reportResource.path));
  },
});

export default [
  scanPageMatrix,
];
