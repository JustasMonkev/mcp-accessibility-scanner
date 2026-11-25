/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { defineTool } from './tool.js';
import type { Response } from '../response.js';
import type { Context } from '../context.js';
import type { AxeNode, AxeViolation } from './axe.js';

const outcomes = ['violation', 'incomplete'] as const;
type Findings = { outcome: typeof outcomes[number], ruleId: string, nodes: AxeNode[] };

const latestScan = new WeakMap<Context, { scanId: string, findings: Findings[] }>();
const maxEvidenceBytes = 1024 * 1024;

// Count UTF-8 JSON bytes for the index and each node separately: don't serialize
// an entire oversized scan just to discover that it doesn't fit.
function fitsBudget(findings: Findings[], indexBytes: number): boolean {
  let bytes = indexBytes;
  for (const rule of findings) {
    for (const node of rule.nodes) {
      bytes += Buffer.byteLength(JSON.stringify(node));
      if (bytes > maxEvidenceBytes)
        return false;
    }
  }
  return bytes <= maxEvidenceBytes;
}

export function stageScanFindings(response: Response, violations: AxeViolation[], incomplete: AxeViolation[]) {
  const findings: Findings[] = [
    ...violations.map(({ id, nodes }) => ({ outcome: 'violation' as const, ruleId: id, nodes })),
    ...incomplete.map(({ id, nodes }) => ({ outcome: 'incomplete' as const, ruleId: id, nodes })),
  ];
  const rules = findings.map(({ outcome, ruleId, nodes }) => ({ outcome, ruleId, count: nodes.length }));
  if (!fitsBudget(findings, Buffer.byteLength(JSON.stringify(rules)))) {
    const reason = 'Evidence exceeds the 1 MiB retention budget; no nodes from this scan were retained.';
    response.setStructuredContent({ scanId: null, rules, reason });
    response.addResult(`Findings not retained: ${reason}`);
    return;
  }

  const scanId = `scan_${randomUUID()}`;
  response.stageResult(`Retained scan: ${scanId} (get_scan_findings)`, { scanId, rules }, () => {
    latestScan.set(response.context, { scanId, findings });
  });
}

export const getScanFindings = defineTool({
  capability: 'core',
  browserless: true,
  schema: {
    name: 'get_scan_findings',
    title: 'Read retained accessibility findings',
    description: 'Read original Axe node evidence from the latest retained scan_page in the same browser session, without accessing the page. Follow nextOffset until null.',
    inputSchema: z.object({
      scanId: z.string().min(1).describe('Opaque ID from scan_page with retainFindings: true.'),
      ruleId: z.string().trim().min(1).describe('Axe rule ID from the retained scan.'),
      outcome: z.enum(outcomes),
      offset: z.number().int().min(0).optional().describe('Zero-based starting node index (default 0).'),
      limit: z.number().int().min(1).max(50).optional().describe('Maximum number of nodes returned (1–50, default 10).'),
    }),
    type: 'readOnly',
  },
  handle: async (context, { scanId, ruleId, outcome, offset = 0, limit = 10 }, response) => {
    const scan = latestScan.get(context);
    if (!scan || scan.scanId !== scanId)
      throw new Error('Scan unavailable: the ID is unknown, expired, or belongs to a different browser session.');
    const rule = scan.findings.find(rule => rule.ruleId === ruleId && rule.outcome === outcome);
    if (!rule)
      throw new Error('No retained findings for this rule and outcome.');
    const total = rule.nodes.length;
    if (offset > total)
      throw new Error(`Offset exceeds the ${total} retained nodes for this rule and outcome.`);
    const nodes = rule.nodes.slice(offset, offset + limit);
    const end = offset + nodes.length;
    const page = { scanId, ruleId, outcome, offset, total, nextOffset: end < total ? end : null, nodes };
    response.setStructuredContent(page);
    response.addResult(JSON.stringify(page, null, 2));
  },
});
