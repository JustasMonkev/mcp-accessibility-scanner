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

/**
 * Integration tests for MCP tool-call metric instrumentation.
 *
 * Verifies that toolCallsTotal and toolCallDurationSeconds are updated
 * correctly for successful, erroneous, and throwing tools.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { PingRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { wrapInProcess } from '../src/mcp/server.js';
import { toolCallsTotal, toolCallDurationSeconds, getPodName } from '../src/metrics/index.js';

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a single labelled sample value from a Prometheus output string. */
function parseSample(output: string, metricName: string, labels: Record<string, string>): number | undefined {
  const labelStr = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',');
  // Match e.g.  mcp_accessibility_scanner_tool_calls_total{tool_name="my_tool",status="success",pod="..."} 2
  //            (order-insensitive — we look for each label key=value pair in the line)
  for (const line of output.split('\n')) {
    if (!line.startsWith(metricName + '{')) continue;
    const matched = Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`));
    if (matched) {
      const valueStr = line.split(' ').pop();
      return valueStr !== undefined ? Number(valueStr) : undefined;
    }
  }
  return undefined;
}

function parseFirstBucketCount(output: string, bucketMetricName: string, labels: Record<string, string>): number | undefined {
  for (const line of output.split('\n')) {
    if (!line.startsWith(bucketMetricName + '{')) continue;
    const matched = Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`));
    if (matched && line.includes('le="+Inf"')) {
      return Number(line.split(' ').pop());
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tests — each needs a fresh Client+transport pair
// ---------------------------------------------------------------------------
describe('metrics tool-call instrumentation', () => {
  const pod = getPodName();
  let client: Client;
  let transport: Transport;

  // Helper: spin up a new wrapInProcess transport with a given backend
  async function connectClient(backend: {
    listTools(): Promise<any[]>;
    callTool(name: string, args: any): Promise<any>;
  }) {
    transport = await wrapInProcess(backend as any);
    client = new Client({ name: 'test-client', version: '0.0.0' });
    client.setRequestHandler(PingRequestSchema, () => ({}));
    await client.connect(transport);
  }

  afterEach(async () => {
    try { await client?.close?.(); } catch { /* ignore */ }
  });

  // ---------------------------------------------------------------------------
  // toolCallsTotal
  // ---------------------------------------------------------------------------
  describe('toolCallsTotal counter', () => {
    it('increments with status="success" for a successful tool call', async () => {
      await connectClient({
        listTools: async () => [],
        callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      });

      const before = toolCallsTotal.get({ tool_name: 'success_tool', status: 'success', pod });

      await client.callTool({ name: 'success_tool', arguments: {} });

      const after = toolCallsTotal.get({ tool_name: 'success_tool', status: 'success', pod });
      expect(after).toBe(before + 1);
    });

    it('increments by 1 per call (multiple calls accumulate)', async () => {
      await connectClient({
        listTools: async () => [],
        callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      });

      const before = toolCallsTotal.get({ tool_name: 'multi_tool', status: 'success', pod });

      await client.callTool({ name: 'multi_tool', arguments: {} });
      await client.callTool({ name: 'multi_tool', arguments: {} });
      await client.callTool({ name: 'multi_tool', arguments: {} });

      const after = toolCallsTotal.get({ tool_name: 'multi_tool', status: 'success', pod });
      expect(after).toBe(before + 3);
    });

    it('increments with status="error" when backend returns isError:true', async () => {
      await connectClient({
        listTools: async () => [],
        callTool: async () => ({
          content: [{ type: 'text', text: 'something went wrong' }],
          isError: true,
        }),
      });

      const before = toolCallsTotal.get({ tool_name: 'error_tool', status: 'error', pod });

      await client.callTool({ name: 'error_tool', arguments: {} });

      const after = toolCallsTotal.get({ tool_name: 'error_tool', status: 'error', pod });
      expect(after).toBe(before + 1);
    });

    it('does NOT increment status="success" when backend returns isError:true', async () => {
      await connectClient({
        listTools: async () => [],
        callTool: async () => ({
          content: [{ type: 'text', text: 'err' }],
          isError: true,
        }),
      });

      const successBefore = toolCallsTotal.get({ tool_name: 'only_error_tool', status: 'success', pod });

      await client.callTool({ name: 'only_error_tool', arguments: {} });

      const successAfter = toolCallsTotal.get({ tool_name: 'only_error_tool', status: 'success', pod });
      expect(successAfter).toBe(successBefore); // unchanged
    });

    it('increments with status="error" when backend throws', async () => {
      await connectClient({
        listTools: async () => [],
        callTool: async () => { throw new Error('unexpected crash'); },
      });

      const before = toolCallsTotal.get({ tool_name: 'throw_tool', status: 'error', pod });

      // callTool catches the throw and returns isError content — client won't throw
      const result = await client.callTool({ name: 'throw_tool', arguments: {} });

      expect(result.isError).toBe(true);
      const after = toolCallsTotal.get({ tool_name: 'throw_tool', status: 'error', pod });
      expect(after).toBe(before + 1);
    });

    it('tracks different tool names independently', async () => {
      let callCount = 0;
      await connectClient({
        listTools: async () => [],
        callTool: async (name: string) => {
          callCount++;
          return { content: [{ type: 'text', text: name }] };
        },
      });

      const beforeA = toolCallsTotal.get({ tool_name: 'tool_alpha', status: 'success', pod });
      const beforeB = toolCallsTotal.get({ tool_name: 'tool_beta', status: 'success', pod });

      await client.callTool({ name: 'tool_alpha', arguments: {} });
      await client.callTool({ name: 'tool_alpha', arguments: {} });
      await client.callTool({ name: 'tool_beta', arguments: {} });

      expect(toolCallsTotal.get({ tool_name: 'tool_alpha', status: 'success', pod })).toBe(beforeA + 2);
      expect(toolCallsTotal.get({ tool_name: 'tool_beta', status: 'success', pod })).toBe(beforeB + 1);
    });

    it('serialized output contains pod label', async () => {
      await connectClient({
        listTools: async () => [],
        callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      });

      await client.callTool({ name: 'pod_label_tool', arguments: {} });

      const out = toolCallsTotal.serialize();
      expect(out).toContain(`pod="${pod}"`);
    });

    it('serialized output has correct # HELP and # TYPE headers', async () => {
      await connectClient({
        listTools: async () => [],
        callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      });
      await client.callTool({ name: 'header_check_tool', arguments: {} });

      const out = toolCallsTotal.serialize();
      expect(out).toContain('# HELP mcp_accessibility_scanner_tool_calls_total');
      expect(out).toContain('# TYPE mcp_accessibility_scanner_tool_calls_total counter');
    });
  });

  // ---------------------------------------------------------------------------
  // toolCallDurationSeconds
  // ---------------------------------------------------------------------------
  describe('toolCallDurationSeconds histogram', () => {
    it('records an observation for every tool call', async () => {
      await connectClient({
        listTools: async () => [],
        callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      });

      await client.callTool({ name: 'duration_tool', arguments: {} });

      const out = toolCallDurationSeconds.serialize();
      // After at least one observation, serialize() must be non-empty
      expect(out).not.toBe('');
      expect(out).toContain('# TYPE mcp_accessibility_scanner_tool_call_duration_seconds histogram');
    });

    it('duration observation is non-negative', async () => {
      await connectClient({
        listTools: async () => [],
        callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      });

      await client.callTool({ name: 'nonneg_duration_tool', arguments: {} });

      const out = toolCallDurationSeconds.serialize();
      // _sum should be ≥ 0
      const sumMatch = out.match(/mcp_accessibility_scanner_tool_call_duration_seconds_sum\{[^}]*\} ([\d.e+-]+)/);
      if (sumMatch) {
        expect(Number(sumMatch[1])).toBeGreaterThanOrEqual(0);
      }
    });

    it('slow tool has duration reflected in histogram sum', async () => {
      await connectClient({
        listTools: async () => [],
        callTool: async () => {
          await new Promise(r => setTimeout(r, 20)); // 20 ms delay
          return { content: [{ type: 'text', text: 'slow' }] };
        },
      });

      await client.callTool({ name: 'slow_tool', arguments: {} });

      const out = toolCallDurationSeconds.serialize();
      const sumMatch = out.match(/mcp_accessibility_scanner_tool_call_duration_seconds_sum\{tool_name="slow_tool"[^}]*\} ([\d.e+-]+)/);
      expect(sumMatch).not.toBeNull();
      // Should be at least 0.01 seconds (10 ms) — generous tolerance for CI
      expect(Number(sumMatch![1])).toBeGreaterThan(0.005);
    });

    it('+Inf bucket count matches the number of observations', async () => {
      await connectClient({
        listTools: async () => [],
        callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      });

      await client.callTool({ name: 'inf_bucket_tool', arguments: {} });
      await client.callTool({ name: 'inf_bucket_tool', arguments: {} });

      const out = toolCallDurationSeconds.serialize();
      const count = parseFirstBucketCount(out, 'mcp_accessibility_scanner_tool_call_duration_seconds_bucket', { tool_name: 'inf_bucket_tool', pod });
      expect(count).toBe(2);
    });

    it('records duration even when tool throws', async () => {
      await connectClient({
        listTools: async () => [],
        callTool: async () => { throw new Error('boom'); },
      });

      await client.callTool({ name: 'throw_duration_tool', arguments: {} });

      const out = toolCallDurationSeconds.serialize();
      // serialize() must be non-empty — the throw path also observes duration
      expect(out).toContain('mcp_accessibility_scanner_tool_call_duration_seconds');
    });
  });

  // ---------------------------------------------------------------------------
  // getPodName helper
  // ---------------------------------------------------------------------------
  describe('getPodName()', () => {
    it('returns POD_NAME env var when set', () => {
      const original = process.env['POD_NAME'];
      process.env['POD_NAME'] = 'my-pod-123';
      try {
        expect(getPodName()).toBe('my-pod-123');
      } finally {
        if (original === undefined) delete process.env['POD_NAME'];
        else process.env['POD_NAME'] = original;
      }
    });

    it('falls back to os.hostname() when POD_NAME is unset', async () => {
      const os = await import('os');
      const original = process.env['POD_NAME'];
      delete process.env['POD_NAME'];
      try {
        expect(getPodName()).toBe(os.hostname());
      } finally {
        if (original !== undefined) process.env['POD_NAME'] = original;
      }
    });

    it('returns a non-empty string', () => {
      expect(getPodName().length).toBeGreaterThan(0);
    });
  });
});
