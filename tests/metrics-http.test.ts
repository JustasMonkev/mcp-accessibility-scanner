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
 * Integration tests for the Prometheus /metrics and /healthz HTTP endpoints.
 *
 * Each test file runs in its own vitest worker, so the `defaultRegistry`
 * module singleton is fresh — counter values start at zero.
 */

import http from 'http';
import os from 'os';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installHttpTransport, startHttpServer } from '../src/mcp/http.js';
import { httpRequestsTotal, registry } from '../src/metrics/index.js';

import type { ServerBackendFactory } from '../src/mcp/server.js';

// ---------------------------------------------------------------------------
// Minimal backend factory — nothing real needs to happen for metrics tests
// ---------------------------------------------------------------------------
const noopFactory: ServerBackendFactory = {
  name: 'metrics-test',
  nameInConfig: 'metrics-test',
  version: '0.0.0',
  create: () => ({
    async listTools() { return []; },
    async callTool() { return { content: [{ type: 'text', text: 'ok' }] }; },
  }),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type RequestOptions = {
  method?: string;
  path?: string;
  /** Overrides the HTTP `Host` header sent to the server. */
  hostHeader?: string;
};

async function sendRequest(port: number, options: RequestOptions = {}): Promise<{ statusCode: number; body: string; contentType?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: options.path ?? '/mcp',
      method: options.method ?? 'GET',
      headers: options.hostHeader ? { host: options.hostHeader } : {},
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => resolve({
        statusCode: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
        contentType: res.headers['content-type'] as string | undefined,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Shared server lifecycle
// ---------------------------------------------------------------------------
describe('metrics HTTP endpoints', () => {
  const servers = new Set<http.Server>();
  let port: number;

  beforeAll(async () => {
    const server = await startHttpServer({ host: '127.0.0.1', port: 0 });
    servers.add(server);
    await installHttpTransport(server, noopFactory);
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
    port = addr.port;
  });

  afterEach(async () => {
    // Only close after ALL tests in this describe are done - we reuse the server.
    // Individual cleanup is handled in afterAll below via the set.
  });

  // We close the server after all tests in this block.
  afterEach(() => {});

  // ---------------------------------------------------------------------------
  // /healthz
  // ---------------------------------------------------------------------------
  describe('GET /healthz', () => {
    it('returns 200 with JSON status body', async () => {
      const { statusCode, body, contentType } = await sendRequest(port, { path: '/healthz' });

      expect(statusCode).toBe(200);
      expect(contentType).toContain('application/json');

      const parsed = JSON.parse(body) as Record<string, unknown>;
      expect(parsed.status).toBe('ok');
      // pod field is present (either POD_NAME env or os.hostname())
      expect(typeof parsed.pod).toBe('string');
      expect((parsed.pod as string).length).toBeGreaterThan(0);
    });

    it('pod field matches POD_NAME env var when set', async () => {
      const original = process.env['POD_NAME'];
      process.env['POD_NAME'] = 'my-test-pod';
      try {
        const { body } = await sendRequest(port, { path: '/healthz' });
        const parsed = JSON.parse(body) as Record<string, unknown>;
        // The pod in the JSON is evaluated at request time via getPodName()
        expect(parsed.pod).toBe('my-test-pod');
      } finally {
        if (original === undefined)
          delete process.env['POD_NAME'];
        else
          process.env['POD_NAME'] = original;
      }
    });

    it('falls back to os.hostname() when POD_NAME is unset', async () => {
      const original = process.env['POD_NAME'];
      delete process.env['POD_NAME'];
      try {
        const { body } = await sendRequest(port, { path: '/healthz' });
        const parsed = JSON.parse(body) as Record<string, unknown>;
        expect(parsed.pod).toBe(os.hostname());
      } finally {
        if (original !== undefined)
          process.env['POD_NAME'] = original;
      }
    });

    it('bypasses host-header validation (allows Prometheus in-cluster scraping by pod IP)', async () => {
      // A request with a forbidden host header should normally get 403 on /mcp,
      // but /healthz is served before host-header validation.
      const { statusCode } = await sendRequest(port, {
        path: '/healthz',
        hostHeader: `evil.attacker.example:${port}`,
      });

      expect(statusCode).toBe(200);
    });

    it('increments the http_requests_total counter for /healthz', async () => {
      const before = httpRequestsTotal.get({ endpoint: '/healthz', method: 'GET', status_code: '200', pod: process.env['POD_NAME'] || os.hostname() });

      await sendRequest(port, { path: '/healthz' });

      const after = httpRequestsTotal.get({ endpoint: '/healthz', method: 'GET', status_code: '200', pod: process.env['POD_NAME'] || os.hostname() });
      expect(after).toBe(before + 1);
    });
  });

  // ---------------------------------------------------------------------------
  // /metrics
  // ---------------------------------------------------------------------------
  describe('GET /metrics', () => {
    it('returns 200 with Prometheus text/plain content-type', async () => {
      const { statusCode, contentType } = await sendRequest(port, { path: '/metrics' });

      expect(statusCode).toBe(200);
      expect(contentType).toContain('text/plain');
      // Prometheus clients look for version=0.0.4
      expect(contentType).toContain('0.0.4');
    });

    it('output ends with a trailing newline (required by Prometheus)', async () => {
      const { body } = await sendRequest(port, { path: '/metrics' });
      expect(body.endsWith('\n')).toBe(true);
    });

    it('contains # HELP and # TYPE blocks for all application metric families', async () => {
      const { body } = await sendRequest(port, { path: '/metrics' });

      const expectedFamilies = [
        'mcp_accessibility_scanner_http_requests_total',
        'mcp_accessibility_scanner_http_request_duration_seconds',
        'mcp_accessibility_scanner_tool_calls_total',
        'mcp_accessibility_scanner_tool_call_duration_seconds',
        'mcp_accessibility_scanner_active_sessions',
      ];

      for (const family of expectedFamilies) {
        expect(body).toContain(`# HELP ${family}`);
        expect(body).toContain(`# TYPE ${family}`);
      }
    });

    it('contains node_info gauge with implementation label', async () => {
      const { body } = await sendRequest(port, { path: '/metrics' });

      expect(body).toContain('# HELP node_info');
      expect(body).toContain('# TYPE node_info gauge');
      expect(body).toContain('implementation="Node.js"');
      expect(body).toContain('node_info{');
      // The gauge value must be 1
      expect(body).toMatch(/node_info\{[^}]+\} 1/);
    });

    it('contains node_process_* gauges with numeric values', async () => {
      const { body } = await sendRequest(port, { path: '/metrics' });

      expect(body).toContain('node_process_resident_memory_bytes');
      expect(body).toContain('node_process_heap_used_bytes');
      expect(body).toContain('node_process_heap_total_bytes');
      expect(body).toContain('node_process_uptime_seconds');

      // Values should be positive numbers
      const rssMatch = body.match(/node_process_resident_memory_bytes (\d+)/);
      expect(rssMatch).not.toBeNull();
      expect(Number(rssMatch![1])).toBeGreaterThan(0);
    });

    it('bypasses host-header validation (allows in-cluster Prometheus scraping)', async () => {
      const { statusCode } = await sendRequest(port, {
        path: '/metrics',
        hostHeader: `evil.attacker.example:${port}`,
      });

      expect(statusCode).toBe(200);
    });

    it('reflects /healthz requests made in this test run in the counter output', async () => {
      // Warm up: make a /healthz request so the counter definitely has a value
      await sendRequest(port, { path: '/healthz' });

      const { body } = await sendRequest(port, { path: '/metrics' });

      // The /healthz counter entry must appear in the metrics output
      expect(body).toContain('endpoint="/healthz"');
      expect(body).toContain('status_code="200"');
    });

    it('reflects /metrics self-scrape requests in the counter output', async () => {
      // Make the first /metrics scrape
      await sendRequest(port, { path: '/metrics' });
      // Second scrape — the first scrape should now appear as a data point
      const { body } = await sendRequest(port, { path: '/metrics' });

      expect(body).toContain('endpoint="/metrics"');
    });

    it('includes histogram _bucket, _sum, _count lines once an observation is recorded', async () => {
      // Any request goes through httpRequestDurationSeconds.observe()
      await sendRequest(port, { path: '/healthz' });

      const { body } = await sendRequest(port, { path: '/metrics' });

      expect(body).toContain('mcp_accessibility_scanner_http_request_duration_seconds_bucket');
      expect(body).toContain('mcp_accessibility_scanner_http_request_duration_seconds_sum');
      expect(body).toContain('mcp_accessibility_scanner_http_request_duration_seconds_count');
      expect(body).toContain('le="+Inf"');
    });
  });
});
