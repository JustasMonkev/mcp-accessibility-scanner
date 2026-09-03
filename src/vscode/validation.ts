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

// Shared `browser_connect` validation for the VS Code bridge, used by the
// host (before spawning the child), the child entrypoint (before `import()`),
// and the factory (before `connect()`), so the three never drift.

const allowedBrowserConnectLibs = new Set(['playwright', 'playwright-core']);

function isRemoteBrowserConnectAllowed(): boolean {
  const value = process.env.PLAYWRIGHT_MCP_VSCODE_ALLOW_REMOTE?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1')
    return true;
  // The URL parser canonicalizes an IPv4-mapped IPv6 loopback such as
  // [::ffff:127.0.0.1] to the hex form ::ffff:7f00:1 (two 16-bit groups),
  // so accept that spelling too instead of failing closed on a legitimate
  // loopback.
  const v4Mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (v4Mapped)
    return ((Number.parseInt(v4Mapped[1], 16) << 16) | Number.parseInt(v4Mapped[2], 16)) === 0x7f000001;
  return false;
}

export function validateBrowserConnectLib(lib: unknown): string | undefined {
  if (typeof lib !== 'string' || !lib)
    return 'Invalid `lib`: expected one of "playwright", "playwright-core".';
  if (lib.includes('\0'))
    return 'Invalid `lib`: null bytes are not allowed.';
  if (lib.includes('/') || lib.includes('\\'))
    return 'Invalid `lib`: path separators are not allowed, expected one of "playwright", "playwright-core".';
  // The colon check also rejects every URL scheme (`data:`, `file:`, `https:`,
  // `node:`, ...) — none may reach the child's `import()`.
  if (lib.includes(':'))
    return 'Invalid `lib`: URL schemes are not allowed, expected one of "playwright", "playwright-core".';
  if (lib.startsWith('.'))
    return 'Invalid `lib`: relative paths are not allowed, expected one of "playwright", "playwright-core".';
  if (!allowedBrowserConnectLibs.has(lib))
    return 'Invalid `lib`: expected one of "playwright", "playwright-core".';
  return undefined;
}

export function validateBrowserConnectConnectionString(connectionString: unknown): string | undefined {
  if (typeof connectionString !== 'string' || !connectionString)
    return 'Invalid `connectionString`: expected a ws: or wss: URL.';
  if (connectionString.includes('\0'))
    return 'Invalid `connectionString`: null bytes are not allowed.';
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return 'Invalid `connectionString`: expected a ws: or wss: URL.';
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:')
    return `Invalid \`connectionString\`: only ws: and wss: URLs are allowed (got "${url.protocol}").`;
  if (url.username || url.password)
    return 'Invalid `connectionString`: credentials (userinfo) are not allowed.';
  if (!url.hostname)
    return 'Invalid `connectionString`: missing hostname.';
  if (!isRemoteBrowserConnectAllowed() && !isLoopbackHostname(url.hostname))
    return 'Invalid `connectionString`: only loopback hosts (localhost, 127.0.0.1, ::1) are allowed. Set PLAYWRIGHT_MCP_VSCODE_ALLOW_REMOTE=1 to allow remote hosts.';
  return undefined;
}
