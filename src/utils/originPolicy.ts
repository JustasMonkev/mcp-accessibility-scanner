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

const defaultPorts: Record<string, string> = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' };

function matchesPattern(url: string, origin: string): boolean {
  return coreBundle.iso.urlMatches(undefined, url, `*://${origin}/**`);
}

// One terminal dot is the DNS root label, so `example.com.` names
// `example.com`; Chromium keeps it in request URLs. More dots are empty labels:
// the allowlist leaves those spellings as written, while the blocklist strips
// every terminal dot so a malformed spelling cannot slip past it.
function trimTerminalDots(host: string, side: Side): string {
  return side === 'allow' ? host.replace(/(?<!\.)\.$/, '') : host.replace(/\.+$/, '');
}

// Entries get the same treatment as request hosts, so `evil.com.` and
// `evil.com.:8080` name the same hosts as `evil.com` and `evil.com:8080`.
// A host made only of wildcards and dots (`*.`) is left as written.
function normalizedEntry(origin: string, side: Side): string {
  const port = /:\d+$/.exec(origin)?.[0] ?? '';
  const trimmed = trimTerminalDots(origin.slice(0, origin.length - port.length), side);
  return /[^*.]/.test(trimmed) ? trimmed + port : origin;
}

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return;
  }
}

// URL serialization drops a scheme's default port, so `https://example.com:443/`
// arrives as `https://example.com/`. Spell the effective port out so an entry
// such as `example.com:443` matches it. A blocklist candidate without any port
// lets a portless entry block its host on every port.
function candidates(url: string, side: Side): string[] {
  const parsed = parse(url);
  if (!parsed?.hostname)
    return [url];
  const base = `${parsed.protocol}//${trimTerminalDots(parsed.hostname, side) || parsed.hostname}`;
  const effectivePort = parsed.port || defaultPorts[parsed.protocol];
  const result = [url];
  if (effectivePort)
    result.push(`${base}:${effectivePort}/`);
  if (side === 'block' || !parsed.port)
    result.push(`${base}/`);
  return result;
}

function matches(url: string, origins: string[], side: Side): boolean {
  const urls = candidates(url, side);
  return origins.some(origin => {
    const normalized = normalizedEntry(origin, side);
    return urls.some(candidate => matchesPattern(candidate, origin) || (normalized !== origin && matchesPattern(candidate, normalized)));
  });
}

/**
 * Entries match a request's effective port, so `example.com:443` covers
 * `https://example.com/`. Allowlist entries without a port allow only the
 * scheme's default port. A blocklist entry without a port blocks its host on
 * every port, so a nondefault port or a trailing-dot host cannot slip past it.
 */
export function isUrlAllowedByOriginPolicy(policy: OriginPolicy | undefined, url: string): boolean {
  if (policy?.blockedOrigins?.length && matches(url, policy.blockedOrigins, 'block'))
    return false;
  return !policy?.allowedOrigins?.length || matches(url, policy.allowedOrigins, 'allow');
}
