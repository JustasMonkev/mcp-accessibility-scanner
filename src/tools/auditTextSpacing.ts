/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTabTool } from './tool.js';
import { fileResource, reserveReportPath, writeJsonReport } from './report.js';
import { withConcurrency } from './axe.js';
import {
  applyTextSpacing,
  measureTextSpacing,
  removeTextSpacing,
  textSpacingLayerPrefix,
  textSpacingOverrides,
} from './textSpacingMeasurement.js';
import { truncateDataUrls } from '../utils/dataUrl.js';
import { safeIsoTimestampForFileName } from '../utils/fileUtils.js';
import { rejectAfterTimeout, settleWithin } from '../utils/timeout.js';

import type { Frame } from 'playwright';
import type {
  TextSpacingBlocked,
  TextSpacingClip,
  TextSpacingClipper,
  TextSpacingFrameMeasurement,
  TextSpacingOverlap,
} from './textSpacingMeasurement.js';

/** @public */
export type TextSpacingCheck = 'text-clipped' | 'text-overlap';

/** @public */
export type TextSpacingFinding = {
  check: TextSpacingCheck;
  wcag: '1.4.12';
  frameUrl: string | null;
  selector: string;
  text: string;
  problem: string;
  fix: string;
} & ({ check: 'text-clipped'; clip: Omit<TextSpacingClip, 'selector' | 'text'> } | { check: 'text-overlap'; overlap: Omit<TextSpacingOverlap, 'selector' | 'text'> });

type FrameOutcome = { frame: Frame; frameUrl: string | null; measurement: TextSpacingFrameMeasurement | null; error: string | null };

const mainFrameTimeoutMs = 15_000;
const childFrameTimeoutMs = 5_000;
const cleanupTimeoutMs = 2_000;
const maxOverlapLines = 200;
const maxBlockedSamples = 20;

function frameLabel(frame: Frame): string | null {
  if (frame.parentFrame() === null)
    return null;
  return truncateDataUrls(frame.url()) || 'about:blank';
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0];
}

function clipperDescription(clipper: TextSpacingClipper): string {
  const parts = [`overflow: ${clipper.overflowX === clipper.overflowY ? clipper.overflowX : `${clipper.overflowX} ${clipper.overflowY}`}`];
  if (clipper.height !== 'auto')
    parts.push(`height: ${clipper.height}`);
  if (clipper.maxHeight !== 'none')
    parts.push(`max-height: ${clipper.maxHeight}`);
  if (clipper.whiteSpace === 'nowrap' || clipper.whiteSpace === 'pre')
    parts.push(`white-space: ${clipper.whiteSpace}`);
  if (clipper.textOverflow !== 'clip')
    parts.push(`text-overflow: ${clipper.textOverflow}`);
  if (clipper.lineClamp !== 'none')
    parts.push(`-webkit-line-clamp: ${clipper.lineClamp}`);
  return parts.join(', ');
}

function clipFix(clipper: TextSpacingClipper | null): string {
  if (!clipper)
    return 'Let the text\'s container grow with its content instead of clipping it.';
  const steps: string[] = [];
  if (clipper.lineClamp !== 'none')
    steps.push('drop the -webkit-line-clamp limit (or offer the full text another way)');
  if (clipper.whiteSpace === 'nowrap' || clipper.whiteSpace === 'pre' || clipper.textOverflow !== 'clip')
    steps.push('allow the text to wrap instead of truncating it on one line');
  if (clipper.height !== 'auto' || clipper.maxHeight !== 'none')
    steps.push('replace the fixed height/max-height with min-height so the box grows with its text');
  steps.push('or stop hiding the overflow (overflow: visible, or auto if a scrollbar is acceptable)');
  return `On ${clipper.selector}: ${steps.join('; ')}.`;
}

/** @public */
export function buildTextSpacingFindings(outcomes: { frameUrl: string | null; measurement: TextSpacingFrameMeasurement | null }[]): TextSpacingFinding[] {
  const findings: TextSpacingFinding[] = [];
  for (const { frameUrl, measurement } of outcomes) {
    if (!measurement)
      continue;
    for (const { selector, text, ...clip } of measurement.clipped) {
      const where = clip.clippedBy ? `, cut off by ${clip.clippedBy.selector === selector ? 'its own box' : clip.clippedBy.selector} (${clipperDescription(clip.clippedBy)})` : '';
      findings.push({
        check: 'text-clipped',
        wcag: '1.4.12',
        frameUrl,
        selector,
        text,
        problem: `"${text}" (${selector}) is ${clip.hiddenPercentAfter}% hidden with text spacing applied (${clip.hiddenPercentBefore}% before)${where}.`,
        fix: clipFix(clip.clippedBy),
        clip,
      });
    }
    for (const { selector, text, ...overlap } of measurement.overlaps) {
      findings.push({
        check: 'text-overlap',
        wcag: '1.4.12',
        frameUrl,
        selector,
        text,
        problem: `"${text}" (${selector}) overlaps "${overlap.otherText}" (${overlap.otherSelector}) with text spacing applied; they did not overlap before.`,
        fix: 'Let the text push surrounding content instead of overlapping it: avoid fixed heights and absolute positioning around text that can grow, and reserve space with min-height, padding or flex/grid gaps.',
        overlap,
      });
    }
  }
  return findings;
}

async function cleanupFrame(frame: Frame): Promise<boolean> {
  let ok = false;
  await settleWithin(frame.evaluate(removeTextSpacing, textSpacingLayerPrefix).then(() => { ok = true; }), cleanupTimeoutMs);
  return ok;
}

async function measureFrame(frame: Frame, maxElements: number, layerName: string): Promise<FrameOutcome> {
  const frameUrl = frameLabel(frame);
  const timeoutMs = frame.parentFrame() === null ? mainFrameTimeoutMs : childFrameTimeoutMs;
  try {
    const measurement = await rejectAfterTimeout(
        frame.evaluate(measureTextSpacing, { layerName, maxElements, maxOverlapLines, overrides: textSpacingOverrides }),
        timeoutMs,
        `timed out after ${timeoutMs}ms`,
    );
    return { frame, frameUrl, measurement, error: null };
  } catch (error) {
    return { frame, frameUrl, measurement: null, error: errorMessage(error) };
  }
}

const auditTextSpacingSchema = z.object({
  maxElements: z.number().int().min(1).max(5000).default(1000).describe('Maximum visible text elements measured per frame; extra elements are reported as truncated.'),
  maxFindingsPerCheck: z.number().int().min(1).max(200).default(20).describe('Maximum findings listed per check; the full count is still reported.'),
  screenshot: z.boolean().default(false).describe('Also save a full-page screenshot of the page with the text spacing overrides applied.'),
  reportFile: z.string().optional().describe('Output JSON report file name.'),
});

const auditTextSpacing = defineTabTool({
  capability: 'core',
  schema: {
    name: 'audit_text_spacing',
    title: 'Audit text spacing (WCAG 1.4.12)',
    description: 'Apply the WCAG 1.4.12 text spacing overrides (line-height 1.5, letter-spacing 0.12em, word-spacing 0.16em, paragraph spacing 2em) and report text that becomes clipped or overlapping. The page is restored afterwards.',
    inputSchema: auditTextSpacingSchema,
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const reportPath = await reserveReportPath(tab.context, response, params.reportFile, 'audit-text-spacing');
    const layerName = `${textSpacingLayerPrefix}${randomUUID().replaceAll('-', '')}`;
    const frames = tab.page.frames();

    let completed = 0;
    const outcomes = await withConcurrency(frames, async frame => {
      const outcome = await measureFrame(frame, params.maxElements, layerName);
      completed++;
      await response.reportProgress({ progress: completed, total: frames.length, message: `Measured text spacing in ${completed}/${frames.length} frame(s)` });
      return outcome;
    });

    // A frame whose evaluation failed or timed out may still carry the overrides; strip them.
    const cleanupFailures: string[] = [];
    for (const outcome of outcomes.filter(entry => entry.error !== null)) {
      if (!outcome.frame.isDetached() && !await cleanupFrame(outcome.frame))
        cleanupFailures.push(outcome.frameUrl ?? 'main frame');
    }

    const main = outcomes.find(outcome => outcome.frame === tab.page.mainFrame());
    if (!main?.measurement)
      throw new Error(`Text spacing could not be measured in the main frame (${main?.error ?? 'frame not found'}); nothing was evaluated.${cleanupFailures.length ? ' The page may still carry the spacing overrides: reload it.' : ''}`);

    const measured = outcomes.reduce((sum, outcome) => sum + (outcome.measurement?.measured ?? 0), 0);
    if (measured === 0 && outcomes.some(outcome => outcome.measurement?.stale))
      throw new Error('Every text element was removed from the page while it was being measured (the page re-rendered), so nothing was evaluated. Wait for the page to settle and run audit_text_spacing again.');
    if (measured === 0)
      throw new Error('No visible text was found to measure, so nothing was evaluated. Navigate to a page with rendered text (or wait for it to load) and run audit_text_spacing again.');

    const findings = buildTextSpacingFindings(outcomes);
    const countByCheck: Record<TextSpacingCheck, number> = { 'text-clipped': 0, 'text-overlap': 0 };
    for (const finding of findings)
      countByCheck[finding.check]++;
    const truncatedChecks = (Object.keys(countByCheck) as TextSpacingCheck[]).filter(check => countByCheck[check] > params.maxFindingsPerCheck);
    const listedFindings = (Object.keys(countByCheck) as TextSpacingCheck[])
        .flatMap(check => findings.filter(finding => finding.check === check).slice(0, params.maxFindingsPerCheck));

    const blocked: (TextSpacingBlocked & { frameUrl: string | null })[] = outcomes.flatMap(outcome => (outcome.measurement?.blocked ?? []).map(entry => ({ ...entry, frameUrl: outcome.frameUrl })));
    const unmeasuredFrames = outcomes.filter(outcome => outcome.error !== null).map(outcome => ({ frameUrl: outcome.frameUrl ?? 'main frame', error: outcome.error! }));
    const totals = {
      candidates: outcomes.reduce((sum, outcome) => sum + (outcome.measurement?.candidates ?? 0), 0),
      measured,
      truncated: outcomes.reduce((sum, outcome) => sum + (outcome.measurement?.truncated ?? 0), 0),
      stale: outcomes.reduce((sum, outcome) => sum + (outcome.measurement?.stale ?? 0), 0),
      overlapLinesTruncated: outcomes.reduce((sum, outcome) => sum + (outcome.measurement?.overlapLinesTruncated ?? 0), 0),
    };

    let screenshotPath: string | null = null;
    let screenshotError: string | null = null;
    if (params.screenshot) {
      const styled = outcomes.filter(outcome => outcome.measurement !== null).map(outcome => outcome.frame);
      try {
        // Bounded like measurement, so a frame that stops answering cannot hold the cleanup below.
        const applied = await Promise.all(styled.map(frame => rejectAfterTimeout(
            frame.evaluate(applyTextSpacing, { layerName, overrides: textSpacingOverrides }),
            frame.parentFrame() === null ? mainFrameTimeoutMs : childFrameTimeoutMs,
            'timed out',
        ).then(() => true, () => false)));
        const unstyled = styled.filter((_, index) => !applied[index]).map(frame => frameLabel(frame) ?? 'main frame');
        if (unstyled.length) {
          // Never hand out an unstyled page as "overrides applied".
          screenshotError = `the overrides could not be re-applied to ${unstyled.join(', ')}`;
        } else {
          const path = await tab.context.outputFile(`audit-text-spacing-${safeIsoTimestampForFileName()}.png`);
          // A failed capture must not throw away the completed measurements: report it and keep going.
          await tab.page.screenshot({ path, fullPage: true }).then(
              () => { screenshotPath = path; },
              error => { screenshotError = `the screenshot could not be captured (${errorMessage(error)})`; },
          );
        }
      } finally {
        for (const frame of styled) {
          if (!frame.isDetached() && !await cleanupFrame(frame))
            cleanupFailures.push(frameLabel(frame) ?? 'main frame');
        }
      }
    }

    const totalFindings = findings.length;
    const report = {
      version: 'v1',
      metadata: {
        url: tab.page.url(),
        options: params,
        overrides: textSpacingOverrides,
        generatedAt: new Date().toISOString(),
      },
      elements: totals,
      frames: { total: frames.length, unmeasured: unmeasuredFrames },
      overridesNotApplied: { count: blocked.length, elements: blocked },
      cleanupFailures,
      screenshotError,
      countByCheck,
      totalFindings,
      truncatedChecks,
      findings: listedFindings,
    };

    const reportResource = await writeJsonReport(response, reportPath, report, {
      name: 'audit-text-spacing-report',
      title: 'Audit text spacing JSON report',
      description: 'JSON report for text clipped or overlapping under the WCAG 1.4.12 text spacing overrides.',
    });
    const screenshotResource = screenshotPath ? fileResource(response, screenshotPath, {
      name: 'audit-text-spacing-screenshot',
      title: 'Page with text spacing overrides applied',
      description: 'Full-page screenshot taken while the WCAG 1.4.12 text spacing overrides were applied.',
      mimeType: 'image/png',
    }) : null;

    response.setStructuredContent({
      kind: 'audit_text_spacing',
      report: reportResource,
      screenshot: screenshotResource,
      page: { url: tab.page.url() },
      summary: {
        elementsCandidates: totals.candidates,
        elementsMeasured: totals.measured,
        elementsTruncated: totals.truncated,
        elementsStale: totals.stale,
        elementsOverlapLinesTruncated: totals.overlapLinesTruncated,
        framesUnmeasured: unmeasuredFrames.length,
        overridesNotApplied: blocked.length,
        totalFindings,
        countByCheck,
        truncatedChecks,
      },
      findings: listedFindings,
      reportUri: reportResource.uri,
    });

    response.addCode('// Applied the WCAG 1.4.12 text spacing overrides, compared text geometry before and after, then removed them.');
    response.addResult([
      `Text spacing overrides (WCAG 1.4.12): line-height ${textSpacingOverrides.lineHeight}, letter-spacing ${textSpacingOverrides.letterSpacingEm}em, word-spacing ${textSpacingOverrides.wordSpacingEm}em, paragraph spacing ${textSpacingOverrides.paragraphSpacingEm}em`,
      `Text elements measured: ${totals.measured}${totals.truncated ? ` (truncated: ${totals.truncated} more visible text elements were not measured; raise maxElements)` : ''}`,
      ...(totals.overlapLinesTruncated ? [`WARNING: ${totals.overlapLinesTruncated} element(s) have more than ${maxOverlapLines} text lines; overlap was checked on their first ${maxOverlapLines} lines only (clipping was checked on every line).`] : []),
      ...(totals.stale ? [`WARNING: ${totals.stale} element(s) were removed from the page while it was being measured and were not evaluated; re-run once the page is stable.`] : []),
      ...(unmeasuredFrames.length ? [`WARNING: ${unmeasuredFrames.length} frame(s) could not be measured and contribute no findings:`, ...unmeasuredFrames.map(entry => `- ${entry.frameUrl}: ${entry.error}`)] : []),
      ...(blocked.length ? [`WARNING: the overrides did not take effect on ${blocked.length} element(s) (the page's own styles, e.g. inline !important, won the cascade over this tool's author-level stylesheet), so the audit did not cover the full text spacing there. A user stylesheet's !important rules outrank author !important, so this is a coverage gap, not proof that users cannot adjust spacing:`, ...blocked.slice(0, maxBlockedSamples).map(entry => `- ${entry.selector}${entry.frameUrl ? ` [frame ${entry.frameUrl}]` : ''}: ${entry.properties.join(', ')}${entry.inlineImportant.length ? ` (inline !important: ${entry.inlineImportant.join(', ')})` : ''}`), ...(blocked.length > maxBlockedSamples ? [`- ... ${blocked.length - maxBlockedSamples} more in the JSON report`] : [])] : []),
      ...(screenshotError ? [`WARNING: no screenshot was saved: ${screenshotError}.`] : []),
      ...(cleanupFailures.length ? [`WARNING: the spacing overrides could not be removed from ${cleanupFailures.join(', ')}; reload the page before further testing.`] : []),
      `Findings: ${totalFindings}`,
      'Check | Findings',
      '--- | ---',
      ...Object.entries(countByCheck).map(([check, count]) => `${check} | ${count}`),
      ...(truncatedChecks.length ? ['', `Showing at most ${params.maxFindingsPerCheck} findings per check; truncated: ${truncatedChecks.join(', ')}`] : []),
      '',
      ...(listedFindings.length
        ? listedFindings.map(finding => `- [${finding.check}] WCAG ${finding.wcag} — ${finding.problem}\n  Fix: ${finding.fix}\n  Selector: ${finding.selector}${finding.frameUrl ? `\n  Frame: ${finding.frameUrl}` : ''}`)
        : ['- No text was clipped or overlapping under the text spacing overrides. This is a heuristic result, not a WCAG 1.4.12 pass: check the screenshot or the page for lost meaning or function.']),
      '',
      `JSON report: ${reportResource.path}`,
      ...(screenshotResource ? [`Screenshot (overrides applied): ${screenshotResource.path}`] : []),
    ].join('\n'));
  },
});

export default [
  auditTextSpacing,
];
