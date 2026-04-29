/**
 * Standalone metrics test using Node.js built-in test runner.
 * Run with: node --experimental-transform-types --test tests/metrics-standalone.test.ts
 *
 * No external npm packages required — works even without node_modules.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';

// ── Import metrics source directly (TypeScript loaded via --experimental-transform-types) ──
import { Counter, Gauge, Histogram, Registry } from '../src/metrics/registry.ts';
import { getPodName } from '../src/metrics/index.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function assertContains(haystack: string, needle: string, msg?: string) {
  assert.ok(haystack.includes(needle), msg ?? `Expected output to contain: ${JSON.stringify(needle)}\nGot:\n${haystack}`);
}

function assertNotContains(haystack: string, needle: string, msg?: string) {
  assert.ok(!haystack.includes(needle), msg ?? `Expected output NOT to contain: ${JSON.stringify(needle)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Counter tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Counter', () => {
  it('starts empty — serialize returns empty string', () => {
    const c = new Counter('empty_total', 'Empty counter');
    assert.strictEqual(c.serialize(), '');
  });

  it('get() returns 0 before any increments', () => {
    const c = new Counter('get_zero', 'Get zero');
    assert.strictEqual(c.get({ pod: 'a' }), 0);
  });

  it('get() returns current value after increments', () => {
    const c = new Counter('get_val', 'Get val');
    c.inc({ pod: 'a' }, 3);
    assert.strictEqual(c.get({ pod: 'a' }), 3);
    c.inc({ pod: 'a' });
    assert.strictEqual(c.get({ pod: 'a' }), 4);
  });

  it('default amount is 1', () => {
    const c = new Counter('default_inc', 'Default inc');
    c.inc({ env: 'test' });
    assert.strictEqual(c.get({ env: 'test' }), 1);
  });

  it('multiple label sets are independent', () => {
    const c = new Counter('multi_labels', 'Multi label');
    c.inc({ status: '200' });
    c.inc({ status: '404' }, 3);
    assert.strictEqual(c.get({ status: '200' }), 1);
    assert.strictEqual(c.get({ status: '404' }), 3);
    assert.strictEqual(c.get({ status: '500' }), 0);
  });

  it('serialize produces correct Prometheus text format', () => {
    const c = new Counter('req_total', 'HTTP requests');
    c.inc({ method: 'GET', status: '200' });
    c.inc({ method: 'GET', status: '200' }, 4);

    const out = c.serialize();
    assertContains(out, '# HELP req_total HTTP requests');
    assertContains(out, '# TYPE req_total counter');
    assertContains(out, 'req_total{');
    assertContains(out, 'status="200"');
    assertContains(out, '} 5');
    // _created timestamp entry
    assertContains(out, 'req_total_created{');
  });

  it('label values with quotes are escaped', () => {
    const c = new Counter('escape_c', 'Escape');
    c.inc({ path: '/foo"bar' });
    assertContains(c.serialize(), '\\"bar');
  });

  it('label values with backslashes are escaped', () => {
    const c = new Counter('bs_c', 'Backslash');
    c.inc({ path: 'C:\\Windows' });
    assertContains(c.serialize(), 'C:\\\\Windows');
  });

  it('label values with newlines are escaped', () => {
    const c = new Counter('nl_c', 'Newline');
    c.inc({ val: 'a\nb' });
    assertContains(c.serialize(), 'a\\nb');
  });

  it('label key order is normalised (consistent key for same labels in different order)', () => {
    const c = new Counter('order_c', 'Order');
    c.inc({ b: '2', a: '1' });
    c.inc({ a: '1', b: '2' }); // same labels, different insertion order
    assert.strictEqual(c.get({ a: '1', b: '2' }), 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gauge tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Gauge', () => {
  it('starts empty', () => {
    const g = new Gauge('empty_g', 'Empty');
    assert.strictEqual(g.serialize(), '');
  });

  it('get() returns 0 before any set', () => {
    const g = new Gauge('get_g0', 'Zero');
    assert.strictEqual(g.get(), 0);
  });

  it('set() stores the exact value', () => {
    const g = new Gauge('set_g', 'Set');
    g.set({ pod: 'p1' }, 42);
    assert.strictEqual(g.get({ pod: 'p1' }), 42);
  });

  it('inc() and dec() adjust the value correctly', () => {
    const g = new Gauge('adj_g', 'Adjust');
    g.inc({ pod: 'a' });
    g.inc({ pod: 'a' });
    g.dec({ pod: 'a' });
    assert.strictEqual(g.get({ pod: 'a' }), 1);
  });

  it('inc() with no prior set starts from 0', () => {
    const g = new Gauge('fresh_g', 'Fresh');
    g.inc({}, 5);
    assert.strictEqual(g.get(), 5);
  });

  it('serialize produces correct Prometheus text', () => {
    const g = new Gauge('sessions', 'Sessions');
    g.set({ pod: 'pod-1' }, 7);

    const out = g.serialize();
    assertContains(out, '# HELP sessions Sessions');
    assertContains(out, '# TYPE sessions gauge');
    assertContains(out, 'sessions{pod="pod-1"} 7');
  });

  it('different label sets are independent', () => {
    const g = new Gauge('ind_g', 'Ind');
    g.set({ pod: 'a' }, 10);
    g.set({ pod: 'b' }, 20);
    assert.strictEqual(g.get({ pod: 'a' }), 10);
    assert.strictEqual(g.get({ pod: 'b' }), 20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Histogram tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Histogram', () => {
  it('starts empty', () => {
    const h = new Histogram('empty_hist', 'Empty', [0.1, 1]);
    assert.strictEqual(h.serialize(), '');
  });

  it('buckets are sorted regardless of input order', () => {
    const h = new Histogram('sort_hist', 'Sort', [1, 0.1, 0.5]);
    h.observe({}, 0.05);
    const out = h.serialize();
    const leValues: number[] = [];
    for (const line of out.split('\n')) {
      const m = line.match(/le="([\d.]+)"/);
      if (m && m[1] !== '+Inf') leValues.push(Number(m[1]));
    }
    assert.deepStrictEqual(leValues, [0.1, 0.5, 1]);
  });

  it('observe() places value in correct cumulative buckets', () => {
    const h = new Histogram('lat', 'Latency', [0.1, 0.5, 1]);
    h.observe({ pod: 'p' }, 0.05);   // falls into ≤0.1, ≤0.5, ≤1, +Inf
    h.observe({ pod: 'p' }, 0.3);    // falls into ≤0.5, ≤1, +Inf (NOT ≤0.1)
    h.observe({ pod: 'p' }, 0.9);    // falls into ≤1, +Inf only

    const out = h.serialize();
    assertContains(out, 'lat_bucket{pod="p",le="0.1"} 1');
    assertContains(out, 'lat_bucket{pod="p",le="0.5"} 2');
    assertContains(out, 'lat_bucket{pod="p",le="1"} 3');
    assertContains(out, 'lat_bucket{pod="p",le="+Inf"} 3');
  });

  it('_sum is correct', () => {
    const h = new Histogram('sum_h', 'Sum', [1]);
    h.observe({}, 0.1);
    h.observe({}, 0.2);
    h.observe({}, 0.3);
    // sum = 0.6  (floating point — use toBeCloseTo equivalent)
    const out = h.serialize();
    const m = out.match(/sum_h_sum(?:\{\})? ([\d.e+-]+)/);
    assert.ok(m, 'sum line not found');
    assert.ok(Math.abs(Number(m![1]) - 0.6) < 0.0001, `Expected ~0.6, got ${m![1]}`);
  });

  it('_count equals total observations', () => {
    const h = new Histogram('cnt_h', 'Count', [1]);
    h.observe({}, 0.1);
    h.observe({}, 0.2);
    assertContains(h.serialize(), 'cnt_h_count');
    assertContains(h.serialize(), ' 2');
  });

  it('produces valid # HELP and # TYPE headers', () => {
    const h = new Histogram('hdr_h', 'Header test', [1]);
    h.observe({}, 0.5);
    assertContains(h.serialize(), '# HELP hdr_h Header test');
    assertContains(h.serialize(), '# TYPE hdr_h histogram');
  });

  it('value at exact bucket boundary is included in that bucket', () => {
    const h = new Histogram('boundary', 'Boundary', [0.5]);
    h.observe({}, 0.5); // le="0.5" SHOULD count this value (≤0.5)
    const out = h.serialize();
    assertContains(out, 'boundary_bucket{le="0.5"} 1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Registry tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Registry', () => {
  it('exportMetrics() returns empty string when no collectors registered', () => {
    const reg = new Registry();
    assert.strictEqual(reg.exportMetrics(), '\n'); // trailing newline always present
  });

  it('aggregates output from multiple collectors', () => {
    const reg = new Registry();
    const c = reg.register(new Counter('agg_c', 'C'));
    const g = reg.register(new Gauge('agg_g', 'G'));
    c.inc({}, 1);
    g.set({}, 99);

    const out = reg.exportMetrics();
    assertContains(out, 'agg_c');
    assertContains(out, 'agg_g');
    assertContains(out, '99');
  });

  it('skips collectors that have no data yet', () => {
    const reg = new Registry();
    reg.register(new Counter('empty_x', 'No data'));
    const g = reg.register(new Gauge('has_data', 'Has data'));
    g.set({}, 5);

    const out = reg.exportMetrics();
    assertNotContains(out, 'empty_x');
    assertContains(out, 'has_data');
  });

  it('output always ends with newline', () => {
    const reg = new Registry();
    const c = reg.register(new Counter('nl_test_total', 'NL test'));
    c.inc({});
    assert.ok(reg.exportMetrics().endsWith('\n'));
  });

  it('register() returns the collector for chaining', () => {
    const reg = new Registry();
    const c = new Counter('chain_c', 'Chain');
    const returned = reg.register(c);
    assert.strictEqual(returned, c);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPodName() tests
// ─────────────────────────────────────────────────────────────────────────────

describe('getPodName()', () => {
  it('returns POD_NAME env var when set', () => {
    const original = process.env['POD_NAME'];
    process.env['POD_NAME'] = 'my-pod-999';
    try {
      assert.strictEqual(getPodName(), 'my-pod-999');
    } finally {
      if (original === undefined) delete process.env['POD_NAME'];
      else process.env['POD_NAME'] = original;
    }
  });

  it('falls back to os.hostname() when POD_NAME is unset', () => {
    const original = process.env['POD_NAME'];
    delete process.env['POD_NAME'];
    try {
      assert.strictEqual(getPodName(), os.hostname());
    } finally {
      if (original !== undefined) process.env['POD_NAME'] = original;
    }
  });

  it('always returns a non-empty string', () => {
    assert.ok(getPodName().length > 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP /metrics and /healthz endpoint tests
// ─────────────────────────────────────────────────────────────────────────────

// Helper: make a plain HTTP request, returns status + body + content-type
async function httpGet(port: number, path: string, hostHeader?: string): Promise<{ status: number; body: string; contentType?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: hostHeader ? { host: hostHeader } : {},
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
        contentType: res.headers['content-type'] as string | undefined,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('HTTP /healthz and /metrics endpoints', async () => {
  // Dynamically import http.ts — requires the MCP SDK to be importable.
  // If node_modules is missing we skip gracefully.
  let port: number = 0;
  let server: http.Server | null = null;
  let skipReason: string | undefined;

  try {
    const { startHttpServer, installHttpTransport } = await import('../src/mcp/http.ts');
    const noopFactory = {
      name: 'test', nameInConfig: 'test', version: '0.0.0',
      create: () => ({
        listTools: async () => [],
        callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      }),
    };
    server = await startHttpServer({ host: '127.0.0.1', port: 0 });
    await installHttpTransport(server as any, noopFactory as any);
    const addr = server.address() as { port: number };
    port = addr.port;
  } catch (e: any) {
    skipReason = `Could not start HTTP server (missing deps?): ${e.message}`;
  }

  // Clean up server after tests
  process.on('exit', () => server?.close());

  it('GET /healthz returns 200 with application/json', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const { status, contentType } = await httpGet(port, '/healthz');
    assert.strictEqual(status, 200);
    assert.ok(contentType?.includes('application/json'), `Expected application/json, got ${contentType}`);
  });

  it('GET /healthz returns JSON body with status=ok and pod field', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const { body } = await httpGet(port, '/healthz');
    const parsed = JSON.parse(body) as { status: string; pod: string };
    assert.strictEqual(parsed.status, 'ok');
    assert.ok(typeof parsed.pod === 'string' && parsed.pod.length > 0);
  });

  it('GET /healthz with bad Host header still returns 200 (bypasses host validation)', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const { status } = await httpGet(port, '/healthz', `evil.attacker.example:${port}`);
    assert.strictEqual(status, 200);
  });

  it('GET /metrics returns 200 with Prometheus text/plain content-type', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const { status, contentType } = await httpGet(port, '/metrics');
    assert.strictEqual(status, 200);
    assert.ok(contentType?.includes('text/plain'), `Expected text/plain, got ${contentType}`);
    assert.ok(contentType?.includes('0.0.4'), `Expected version=0.0.4 in content-type, got ${contentType}`);
  });

  it('GET /metrics output ends with a newline', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const { body } = await httpGet(port, '/metrics');
    assert.ok(body.endsWith('\n'));
  });

  it('GET /metrics contains all registered application metric families', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const { body } = await httpGet(port, '/metrics');

    const families = [
      'mcp_accessibility_scanner_http_requests_total',
      'mcp_accessibility_scanner_http_request_duration_seconds',
      'mcp_accessibility_scanner_tool_calls_total',
      'mcp_accessibility_scanner_tool_call_duration_seconds',
      'mcp_accessibility_scanner_active_sessions',
    ];
    for (const name of families) {
      assertContains(body, `# HELP ${name}`, `Missing metric family: ${name}`);
    }
  });

  it('GET /metrics contains node_info with implementation=Node.js', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const { body } = await httpGet(port, '/metrics');
    assertContains(body, 'node_info{');
    assertContains(body, 'implementation="Node.js"');
  });

  it('GET /metrics contains node process memory metrics', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const { body } = await httpGet(port, '/metrics');
    assertContains(body, 'node_process_resident_memory_bytes');
    assertContains(body, 'node_process_heap_used_bytes');
    assertContains(body, 'node_process_uptime_seconds');
  });

  it('GET /metrics with bad Host header still returns 200', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const { status } = await httpGet(port, '/metrics', `evil.attacker.example:${port}`);
    assert.strictEqual(status, 200);
  });

  it('/healthz request is counted in /metrics output', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    await httpGet(port, '/healthz');
    const { body } = await httpGet(port, '/metrics');
    assertContains(body, 'endpoint="/healthz"');
    assertContains(body, 'status_code="200"');
  });

  it('histogram _bucket, _sum, _count lines appear after a request', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    await httpGet(port, '/healthz');
    const { body } = await httpGet(port, '/metrics');
    assertContains(body, 'mcp_accessibility_scanner_http_request_duration_seconds_bucket');
    assertContains(body, 'mcp_accessibility_scanner_http_request_duration_seconds_sum');
    assertContains(body, 'mcp_accessibility_scanner_http_request_duration_seconds_count');
    assertContains(body, 'le="+Inf"');
  });
});
