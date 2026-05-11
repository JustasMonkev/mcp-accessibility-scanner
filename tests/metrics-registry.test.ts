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

import { describe, it, expect } from 'vitest';
import { Counter, Gauge, Histogram, Registry } from '../src/metrics/registry.js';

describe('metrics/registry', () => {
  describe('Counter', () => {
    it('get() returns current value for a label-set', () => {
      const counter = new Counter('get_test_total', 'Get test');
      expect(counter.get({ pod: 'a' })).toBe(0);
      counter.inc({ pod: 'a' }, 3);
      expect(counter.get({ pod: 'a' })).toBe(3);
      counter.inc({ pod: 'a' });
      expect(counter.get({ pod: 'a' })).toBe(4);
      // different label set is independent
      expect(counter.get({ pod: 'b' })).toBe(0);
    });

    it('increments and serializes in Prometheus text format', () => {
      const counter = new Counter('test_total', 'A test counter');
      counter.inc({ pod: 'pod-1', method: 'GET' });
      counter.inc({ pod: 'pod-1', method: 'GET' }, 4);

      const out = counter.serialize();
      expect(out).toContain('# HELP test_total A test counter');
      expect(out).toContain('# TYPE test_total counter');
      expect(out).toContain('test_total{pod="pod-1",method="GET"} 5');
      expect(out).toContain('test_total_created{pod="pod-1",method="GET"}');
    });

    it('tracks multiple label sets independently', () => {
      const counter = new Counter('req_total', 'Requests');
      counter.inc({ status: '200' });
      counter.inc({ status: '404' }, 3);

      const out = counter.serialize();
      expect(out).toContain('req_total{status="200"} 1');
      expect(out).toContain('req_total{status="404"} 3');
    });

    it('returns empty string when no values recorded', () => {
      const counter = new Counter('empty_total', 'Empty');
      expect(counter.serialize()).toBe('');
    });

    it('escapes label values containing quotes and backslashes', () => {
      const counter = new Counter('escape_total', 'Escape test');
      counter.inc({ path: '/foo"bar' });
      const out = counter.serialize();
      expect(out).toContain('\\"bar');
    });
  });

  describe('Gauge', () => {
    it('get() returns current value for a label-set', () => {
      const gauge = new Gauge('get_g', 'Get gauge');
      expect(gauge.get({ pod: 'a' })).toBe(0);
      gauge.set({ pod: 'a' }, 10);
      expect(gauge.get({ pod: 'a' })).toBe(10);
      gauge.dec({ pod: 'a' }, 3);
      expect(gauge.get({ pod: 'a' })).toBe(7);
    });

    it('sets and serializes gauge values', () => {
      const gauge = new Gauge('active_sessions', 'Active sessions');
      gauge.set({ pod: 'pod-1' }, 5);

      const out = gauge.serialize();
      expect(out).toContain('# HELP active_sessions Active sessions');
      expect(out).toContain('# TYPE active_sessions gauge');
      expect(out).toContain('active_sessions{pod="pod-1"} 5');
    });

    it('inc and dec modify value correctly', () => {
      const gauge = new Gauge('g', 'gauge');
      gauge.inc({ pod: 'a' });
      gauge.inc({ pod: 'a' });
      gauge.dec({ pod: 'a' });

      const out = gauge.serialize();
      expect(out).toContain('g{pod="a"} 1');
    });

    it('returns empty string when no values recorded', () => {
      const gauge = new Gauge('empty_gauge', 'Empty');
      expect(gauge.serialize()).toBe('');
    });
  });

  describe('Histogram', () => {
    it('observes and serializes buckets, sum, count', () => {
      const hist = new Histogram('latency_seconds', 'Latency', [0.1, 0.5, 1]);
      hist.observe({ pod: 'pod-1' }, 0.05);
      hist.observe({ pod: 'pod-1' }, 0.3);
      hist.observe({ pod: 'pod-1' }, 0.9);

      const out = hist.serialize();
      expect(out).toContain('# HELP latency_seconds Latency');
      expect(out).toContain('# TYPE latency_seconds histogram');
      // 0.05 < 0.1 bucket: 1 obs falls into le="0.1"
      expect(out).toContain('latency_seconds_bucket{pod="pod-1",le="0.1"} 1');
      // 0.05, 0.3 fall into le="0.5": 2
      expect(out).toContain('latency_seconds_bucket{pod="pod-1",le="0.5"} 2');
      // all 3 fall into le="1": 3
      expect(out).toContain('latency_seconds_bucket{pod="pod-1",le="1"} 3');
      // +Inf bucket equals total count
      expect(out).toContain('latency_seconds_bucket{pod="pod-1",le="+Inf"} 3');
      // sum = 0.05 + 0.3 + 0.9 = 1.25
      expect(out).toContain('latency_seconds_sum{pod="pod-1"} 1.25');
      expect(out).toContain('latency_seconds_count{pod="pod-1"} 3');
    });

    it('returns empty string when no observations', () => {
      const hist = new Histogram('empty_hist', 'Empty', [0.1, 1]);
      expect(hist.serialize()).toBe('');
    });
  });

  describe('Registry', () => {
    it('aggregates multiple collectors', () => {
      const reg = new Registry();
      const c1 = reg.register(new Counter('c1_total', 'C1'));
      const g1 = reg.register(new Gauge('g1', 'G1'));
      c1.inc({});
      g1.set({}, 42);

      const out = reg.exportMetrics();
      expect(out).toContain('c1_total');
      expect(out).toContain('g1');
      expect(out).toContain('42');
      expect(out.endsWith('\n')).toBe(true);
    });

    it('skips empty collectors', () => {
      const reg = new Registry();
      reg.register(new Counter('empty_c', 'Empty counter'));
      reg.register(new Gauge('used_g', 'Used gauge'));
      const g = reg.register(new Gauge('used_g2', 'Used gauge 2'));
      g.set({}, 7);

      const out = reg.exportMetrics();
      expect(out).not.toContain('empty_c');
      expect(out).toContain('used_g2');
    });
  });
});
