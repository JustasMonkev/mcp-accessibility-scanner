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
 * Minimal Prometheus text-format metrics registry for Node.js.
 * Supports Counter, Gauge, and Histogram — no external dependencies.
 * Produces output compatible with Prometheus /metrics scraping and
 * works correctly across multiple pods (each pod exposes its own metrics;
 * Prometheus aggregates them server-side).
 */

export type Labels = Record<string, string>;

function labelsToString(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0)
    return '';
  const parts = entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return `{${parts.join(',')}}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labelKey(labels: Labels): string {
  return JSON.stringify(Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))));
}

// ---------------------------------------------------------------------------
// Counter
// ---------------------------------------------------------------------------

export class Counter {
  private readonly _help: string;
  private readonly _name: string;
  private readonly _values = new Map<string, { labels: Labels; value: number; created: number }>();

  constructor(name: string, help: string) {
    this._name = name;
    this._help = help;
  }

  inc(labels: Labels = {}, amount = 1): void {
    const key = labelKey(labels);
    const existing = this._values.get(key);
    if (existing) {
      existing.value += amount;
    } else {
      this._values.set(key, { labels, value: amount, created: Date.now() / 1000 });
    }
  }

  /** Returns the current count for the given label-set, or 0 if never incremented. */
  get(labels: Labels = {}): number {
    return this._values.get(labelKey(labels))?.value ?? 0;
  }

  serialize(): string {
    if (this._values.size === 0)
      return '';
    const lines: string[] = [
      `# HELP ${this._name} ${this._help}`,
      `# TYPE ${this._name} counter`,
    ];
    for (const { labels, value, created } of this._values.values()) {
      lines.push(`${this._name}${labelsToString(labels)} ${value}`);
      lines.push(`${this._name}_created${labelsToString(labels)} ${created}`);
    }
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Gauge
// ---------------------------------------------------------------------------

export class Gauge {
  private readonly _help: string;
  private readonly _name: string;
  private readonly _values = new Map<string, { labels: Labels; value: number }>();

  constructor(name: string, help: string) {
    this._name = name;
    this._help = help;
  }

  set(labels: Labels = {}, value: number): void {
    this._values.set(labelKey(labels), { labels, value });
  }

  /** Returns the current value for the given label-set, or 0 if never set. */
  get(labels: Labels = {}): number {
    return this._values.get(labelKey(labels))?.value ?? 0;
  }

  inc(labels: Labels = {}, amount = 1): void {
    const key = labelKey(labels);
    const existing = this._values.get(key);
    if (existing)
      existing.value += amount;
    else
      this._values.set(key, { labels, value: amount });
  }

  dec(labels: Labels = {}, amount = 1): void {
    this.inc(labels, -amount);
  }

  serialize(): string {
    if (this._values.size === 0)
      return '';
    const lines: string[] = [
      `# HELP ${this._name} ${this._help}`,
      `# TYPE ${this._name} gauge`,
    ];
    for (const { labels, value } of this._values.values())
      lines.push(`${this._name}${labelsToString(labels)} ${value}`);
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Histogram {
  private readonly _help: string;
  private readonly _name: string;
  private readonly _buckets: number[];
  private readonly _data = new Map<string, {
    labels: Labels;
    counts: number[];  // one per bucket
    sum: number;
    count: number;
  }>();

  constructor(name: string, help: string, buckets: number[] = DEFAULT_BUCKETS) {
    this._name = name;
    this._help = help;
    this._buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: Labels = {}, value: number): void {
    const key = labelKey(labels);
    let entry = this._data.get(key);
    if (!entry) {
      entry = { labels, counts: new Array(this._buckets.length).fill(0), sum: 0, count: 0 };
      this._data.set(key, entry);
    }
    entry.sum += value;
    entry.count += 1;
    for (let i = 0; i < this._buckets.length; i++) {
      if (value <= this._buckets[i]!)
        entry.counts[i]! += 1;
    }
  }

  serialize(): string {
    if (this._data.size === 0)
      return '';
    const lines: string[] = [
      `# HELP ${this._name} ${this._help}`,
      `# TYPE ${this._name} histogram`,
    ];
    for (const { labels, counts, sum, count } of this._data.values()) {
      // counts[i] already stores cumulative values (observe() increments all
      // buckets where value <= bucket[i]), so output them directly.
      for (let i = 0; i < this._buckets.length; i++) {
        const bucketLabels = { ...labels, le: String(this._buckets[i]) };
        lines.push(`${this._name}_bucket${labelsToString(bucketLabels)} ${counts[i]!}`);
      }
      lines.push(`${this._name}_bucket${labelsToString({ ...labels, le: '+Inf' })} ${count}`);
      lines.push(`${this._name}_sum${labelsToString(labels)} ${sum}`);
      lines.push(`${this._name}_count${labelsToString(labels)} ${count}`);
    }
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class Registry {
  private readonly _collectors: Array<{ serialize(): string }> = [];

  register<T extends { serialize(): string }>(collector: T): T {
    this._collectors.push(collector);
    return collector;
  }

  /** Render all registered metrics in Prometheus text exposition format. */
  exportMetrics(): string {
    return this._collectors
        .map(c => c.serialize())
        .filter(Boolean)
        .join('\n') + '\n';
  }
}

export const defaultRegistry = new Registry();
