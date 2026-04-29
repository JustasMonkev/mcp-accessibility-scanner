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

import os from 'os';
import process from 'process';

import { Counter, Gauge, Histogram, Registry, defaultRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Pod identity — reads POD_NAME env var (set by Kubernetes downward API) so
// that Prometheus can distinguish per-pod metrics when scraping multiple pods.
// Falls back to the OS hostname for non-Kubernetes environments.
// ---------------------------------------------------------------------------
export function getPodName(): string {
  return process.env['POD_NAME'] || os.hostname();
}

// ---------------------------------------------------------------------------
// Node.js process / platform metrics  (mirrors Python's python_info + gc)
// ---------------------------------------------------------------------------

class NodeInfoCollector {
  serialize(): string {
    const { node, v8, platform, arch } = process.versions;
    const lines = [
      '# HELP node_info Node.js platform information',
      '# TYPE node_info gauge',
      `node_info{implementation="Node.js",node="${node ?? ''}",v8="${v8 ?? ''}",platform="${platform}",arch="${arch}"} 1`,
    ];
    return lines.join('\n');
  }
}

class NodeProcessCollector {
  serialize(): string {
    const memMB = process.memoryUsage();
    const lines: string[] = [
      '# HELP node_process_resident_memory_bytes Resident memory size in bytes',
      '# TYPE node_process_resident_memory_bytes gauge',
      `node_process_resident_memory_bytes ${memMB.rss}`,
      '# HELP node_process_heap_used_bytes V8 heap used in bytes',
      '# TYPE node_process_heap_used_bytes gauge',
      `node_process_heap_used_bytes ${memMB.heapUsed}`,
      '# HELP node_process_heap_total_bytes V8 heap total in bytes',
      '# TYPE node_process_heap_total_bytes gauge',
      `node_process_heap_total_bytes ${memMB.heapTotal}`,
      '# HELP node_process_uptime_seconds Process uptime in seconds',
      '# TYPE node_process_uptime_seconds gauge',
      `node_process_uptime_seconds ${process.uptime()}`,
    ];
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Application metrics
// ---------------------------------------------------------------------------

/** HTTP request counter: endpoint × method × status_code × user_agent × pod */
export const httpRequestsTotal = defaultRegistry.register(
    new Counter(
        'mcp_accessibility_scanner_http_requests_total',
        'HTTP requests per pod',
    ),
);

/** HTTP request duration histogram: endpoint × method × pod */
export const httpRequestDurationSeconds = defaultRegistry.register(
    new Histogram(
        'mcp_accessibility_scanner_http_request_duration_seconds',
        'HTTP request duration in seconds',
        [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    ),
);

/** MCP tool call counter: tool_name × status × pod */
export const toolCallsTotal = defaultRegistry.register(
    new Counter(
        'mcp_accessibility_scanner_tool_calls_total',
        'MCP tool calls per pod',
    ),
);

/** MCP tool call duration histogram: tool_name × pod */
export const toolCallDurationSeconds = defaultRegistry.register(
    new Histogram(
        'mcp_accessibility_scanner_tool_call_duration_seconds',
        'MCP tool call duration in seconds',
        [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    ),
);

/** Active HTTP sessions (MCP stream sessions): pod */
export const activeSessionsGauge = defaultRegistry.register(
    new Gauge(
        'mcp_accessibility_scanner_active_sessions',
        'Number of active MCP streaming sessions per pod',
    ),
);

/**
 * Per-user activity counter (mirrors mcp_atlassian_user_activity_total):
 * activity_type × username × user_agent × pod
 */
export const userActivityTotal = defaultRegistry.register(
    new Counter(
        'mcp_accessibility_scanner_user_activity_total',
        'User activity events across all pods',
    ),
);

// Register process collectors
defaultRegistry.register(new NodeInfoCollector());
defaultRegistry.register(new NodeProcessCollector());

export { defaultRegistry as registry };
export type { Registry };
