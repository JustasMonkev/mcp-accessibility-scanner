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

import coreBundle from 'playwright-core/lib/coreBundle';

type OriginPolicy = { allowedOrigins?: string[], blockedOrigins?: string[] };
type Side = 'allow' | 'block';
type Entry = { host: string, port?: string };

const defaultPorts: Record<string, string> = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' };

function matchesUrlGlob(url: string, origin: string): boolean {
  return coreBundle.iso.urlMatches(undefined, url, `*://${origin}/**`);
}

// The candidate carries no port, so a wildcard in the host pattern (Playwright
// compiles `*` to `[^/]*`) can only match hostname characters, never a port.
function matchesHost(hostname: string, pattern: string): boolean {
  return matchesUrlGlob(`http://${hostname}/`, pattern);
}

// One terminal dot is the DNS root label, so `example.com.` names
// `example.com`; Chromium keeps it in request URLs. More dots are empty labels:
// the allowlist leaves those spellings as written, while the blocklist strips
// every terminal dot so a malformed spelling cannot slip past it.
function trimTerminalDots(host: string, side: Side): string {
  return side === 'allow' ? host.replace(/(?<!\.)\.$/, '') : host.replace(/\.+$/, '');
}

function requestHosts(hostname: string, side: Side): string[] {
  const trimmed = trimTerminalDots(hostname, side);
  return trimmed && trimmed !== hostname ? [hostname, trimmed] : [hostname];
}

// Entries get the same dot treatment as request hosts, so `evil.com.` names the
// same host as `evil.com`. The literal spelling is always tried too, and a host
// made only of wildcards and dots (`*.`) is never trimmed into a bare `*`.
function entryHosts(host: string, side: Side): string[] {
  const trimmed = trimTerminalDots(host, side);
  return /[^*.]/.test(trimmed) && trimmed !== host ? [host, trimmed] : [host];
}

// `host` or `host:port`, with the port compared by numeric value so `:0443`
// means 443. An entry whose host part still contains a colon outside IPv6
// brackets (such as `example.com:*`) is not of that form and keeps whole-URL
// glob matching.
function parseEntry(origin: string): Entry | undefined {
  const port = /:(\d+)$/.exec(origin);
  const host = port ? origin.slice(0, port.index) : origin;
  if (host.replace(/\[[^\]]*\]/g, '').includes(':'))
    return;
  return { host, port: port ? String(Number(port[1])) : undefined };
}

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return;
  }
}

function matches(url: string, origins: string[], side: Side): boolean {
  const parsed = parse(url);
  if (!parsed?.hostname)
    return origins.some(origin => matchesUrlGlob(url, origin));
  const hosts = requestHosts(parsed.hostname, side);
  // URL serialization drops a scheme's default port, so `https://example.com:443/`
  // arrives with an empty `port`; compare against the effective port instead.
  const effectivePort = parsed.port || defaultPorts[parsed.protocol];
  return origins.some(origin => {
    const entry = parseEntry(origin);
    if (!entry)
      return matchesUrlGlob(url, origin);
    // A portless allowlist entry allows only the default port; a portless
    // blocklist entry blocks every port.
    const portMatches = entry.port !== undefined ? entry.port === effectivePort : side === 'block' || !parsed.port;
    return portMatches && entryHosts(entry.host, side).some(pattern => hosts.some(host => matchesHost(host, pattern)));
  });
}

/**
 * Host patterns match only the request hostname, and an entry's port is
 * compared with the request's effective port, so `example.com:443` covers
 * `https://example.com/`. Allowlist entries without a port allow only the
 * scheme's default port. A blocklist entry without a port blocks its host on
 * every port, so a nondefault port or a trailing-dot host cannot slip past it.
 */
export function isUrlAllowedByOriginPolicy(policy: OriginPolicy | undefined, url: string): boolean {
  if (policy?.blockedOrigins?.length && matches(url, policy.blockedOrigins, 'block'))
    return false;
  return !policy?.allowedOrigins?.length || matches(url, policy.allowedOrigins, 'allow');
}
