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

function matchesOrigin(url: string, origin: string): boolean {
  return coreBundle.iso.urlMatches(undefined, url, `*://${origin}/**`);
}

// `example.com.` is the fully qualified spelling of `example.com`, and Chromium
// keeps the trailing dot in request URLs, so match the host without it as well.
function withoutTrailingDot(url: URL): URL | undefined {
  const hostname = url.hostname.replace(/\.+$/, '');
  if (!hostname || hostname === url.hostname)
    return;
  const stripped = new URL(url.href);
  stripped.hostname = hostname;
  return stripped;
}

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return;
  }
}

/**
 * Allowlist entries keep their exact-port semantics (`example.com` allows only
 * the default port). A blocklist entry without a port blocks its host on every
 * port, so a nondefault port or a trailing-dot host cannot slip past it.
 */
export function isUrlAllowedByOriginPolicy(policy: OriginPolicy | undefined, url: string): boolean {
  const parsed = parse(url);
  const canonical = parsed && withoutTrailingDot(parsed);
  const allowCandidates = canonical ? [url, canonical.href] : [url];
  const blockCandidates = [...allowCandidates];
  const portless = canonical ?? (parsed ? new URL(parsed.href) : undefined);
  if (portless?.port) {
    portless.port = '';
    blockCandidates.push(portless.href);
  }
  if (policy?.blockedOrigins?.some(origin => blockCandidates.some(candidate => matchesOrigin(candidate, origin))))
    return false;
  return !policy?.allowedOrigins?.length || policy.allowedOrigins.some(origin => allowCandidates.some(candidate => matchesOrigin(candidate, origin)));
}
