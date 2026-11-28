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

import { describe, expect, it } from 'vitest';
import { isUrlAllowedByOriginPolicy } from '../src/utils/originPolicy.js';

describe('isUrlAllowedByOriginPolicy', () => {
  it.each([
    'http://evil.com/',
    'https://evil.com/path?q=1',
    'http://evil.com:8080/',
    'https://evil.com:8443/x',
    'http://evil.com./',
    'http://evil.com../',
    'http://evil.com.:8080/',
    'ws://evil.com:9000/socket',
    'wss://evil.com./socket',
  ])('a portless blocklist entry blocks %s', url => {
    expect(isUrlAllowedByOriginPolicy({ blockedOrigins: ['evil.com'] }, url)).toBe(false);
  });

  it.each([
    ['http://evil.com:8080/', false],
    ['http://evil.com.:8080/', false],
    ['http://evil.com/', true],
    ['http://evil.com:9090/', true],
  ] as const)('a blocklist entry with a port blocks only that port: %s -> allowed=%s', (url, allowed) => {
    expect(isUrlAllowedByOriginPolicy({ blockedOrigins: ['evil.com:8080'] }, url)).toBe(allowed);
  });

  it.each([
    ['http://sub.evil.com./', ['*.evil.com']],
    ['http://sub.evil.com:3000/', ['*.evil.com']],
  ] as const)('wildcard blocklist entries cover trailing-dot and nondefault-port hosts: %s', (url, blockedOrigins) => {
    expect(isUrlAllowedByOriginPolicy({ blockedOrigins: [...blockedOrigins] }, url)).toBe(false);
  });

  it.each([
    'http://evil.com./',
    'http://evil.com/',
    'http://evil.com.:8080/',
    'http://evil.com:8080/',
  ])('a trailing-dot blocklist entry blocks its host on every port: %s', url => {
    expect(isUrlAllowedByOriginPolicy({ blockedOrigins: ['evil.com.'] }, url)).toBe(false);
  });

  it('a trailing-dot blocklist entry with a port blocks only that port', () => {
    const policy = { blockedOrigins: ['evil.com.:8080'] };
    expect(isUrlAllowedByOriginPolicy(policy, 'http://evil.com:8080/')).toBe(false);
    expect(isUrlAllowedByOriginPolicy(policy, 'http://evil.com.:8080/')).toBe(false);
    expect(isUrlAllowedByOriginPolicy(policy, 'http://evil.com:9090/')).toBe(true);
    expect(isUrlAllowedByOriginPolicy({ blockedOrigins: ['evil.com:8080'] }, 'http://evil.com:9090/')).toBe(true);
  });

  it('lets a trailing-dot blocklist entry win over a port-scoped allowlist entry', () => {
    const policy = { allowedOrigins: ['evil.com:8080'], blockedOrigins: ['evil.com.'] };
    expect(isUrlAllowedByOriginPolicy(policy, 'http://evil.com.:8080/')).toBe(false);
    expect(isUrlAllowedByOriginPolicy(policy, 'http://evil.com:8080/')).toBe(false);
  });

  it('treats a trailing-dot allowlist entry as its host without widening wildcard-only entries', () => {
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: ['example.com.'] }, 'https://example.com/')).toBe(true);
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: ['example.com.:8443'] }, 'https://example.com:8443/')).toBe(true);
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: ['example.com.'] }, 'https://example.com:8443/')).toBe(false);
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: ['*.'] }, 'https://example.com/')).toBe(false);
  });

  it.each([
    ['https://example.com/', 'example.com:443', true],
    ['https://example.com:443/', 'example.com:443', true],
    ['wss://example.com/socket', 'example.com:443', true],
    ['http://example.com/', 'example.com:80', true],
    ['http://example.com./', 'example.com:80', true],
    ['http://example.com/', 'example.com:443', false],
    ['https://example.com:8443/', 'example.com:443', false],
  ] as const)('an entry with an explicit port matches the effective port: %s with %s -> %s', (url, entry, matched) => {
    expect(isUrlAllowedByOriginPolicy({ blockedOrigins: [entry] }, url)).toBe(!matched);
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: [entry] }, url)).toBe(matched);
  });

  it('keeps a portless allowlist entry to the default port even when it is spelled out', () => {
    const policy = { allowedOrigins: ['example.com'] };
    expect(isUrlAllowedByOriginPolicy(policy, 'https://example.com:443/')).toBe(true);
    expect(isUrlAllowedByOriginPolicy(policy, 'http://example.com:443/')).toBe(false);
  });

  it('normalizes only the single root dot on the allow side, and every terminal dot on the block side', () => {
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: ['example.com..'] }, 'https://example.com/')).toBe(false);
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: ['example.com..:8443'] }, 'https://example.com:8443/')).toBe(false);
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: ['example.com'] }, 'https://example.com../')).toBe(false);
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: ['example.com'] }, 'https://example.com./')).toBe(true);
    expect(isUrlAllowedByOriginPolicy({ blockedOrigins: ['evil.com..'] }, 'http://evil.com/')).toBe(false);
    expect(isUrlAllowedByOriginPolicy({ blockedOrigins: ['evil.com'] }, 'http://evil.com...:8080/')).toBe(false);
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: ['evil.com'], blockedOrigins: ['evil.com..'] }, 'http://evil.com/')).toBe(false);
  });

  it.each([
    ['example.c*', 'https://example.com:8443/'],
    ['example.*', 'http://example.com:8080/'],
    ['example.com*', 'http://example.com:8080/'],
    ['*.example.com', 'https://a.example.com:8443/'],
  ] as const)('a portless allowlist host pattern %s cannot absorb the port of %s', (entry, url) => {
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: [entry] }, url)).toBe(false);
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: [entry] }, url.replace(/:\d+\//, '/'))).toBe(true);
  });

  it('applies host wildcards to the hostname and the configured port separately', () => {
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: ['*.example.com:8443'] }, 'https://a.example.com:8443/')).toBe(true);
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: ['*.example.com:8443'] }, 'https://a.example.com/')).toBe(false);
    expect(isUrlAllowedByOriginPolicy({ blockedOrigins: ['*.example.com'] }, 'https://a.example.com:8443/')).toBe(false);
    expect(isUrlAllowedByOriginPolicy({ blockedOrigins: ['example.c*:8443'] }, 'https://example.com:8443/')).toBe(false);
    expect(isUrlAllowedByOriginPolicy({ blockedOrigins: ['example.c*:8443'] }, 'https://example.com/')).toBe(true);
  });

  it.each([
    ['example.com:0443', 'https://example.com/', true],
    ['example.com:00443', 'wss://example.com/socket', true],
    ['example.com:080', 'http://example.com/', true],
    ['example.com:08080', 'http://example.com:8080/', true],
    ['example.com:08080', 'http://example.com:9090/', false],
    ['example.com:0443', 'http://example.com/', false],
  ] as const)('compares a zero-padded entry port by value: %s with %s -> %s', (entry, url, matched) => {
    expect(isUrlAllowedByOriginPolicy({ blockedOrigins: [entry] }, url)).toBe(!matched);
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: [entry] }, url)).toBe(matched);
  });

  it('matches a dotted wildcard entry against the literal hostname on any port', () => {
    for (const url of ['http://foo./', 'http://foo.:8080/', 'http://a.b.:9000/'])
      expect(isUrlAllowedByOriginPolicy({ blockedOrigins: ['*.'] }, url), url).toBe(false);
    expect(isUrlAllowedByOriginPolicy({ blockedOrigins: ['*.'] }, 'http://foo/')).toBe(true);
    expect(isUrlAllowedByOriginPolicy({ blockedOrigins: ['*.'] }, 'http://foo:8080/')).toBe(true);
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: ['*.'] }, 'http://foo./')).toBe(true);
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: ['*.'] }, 'http://foo/')).toBe(false);
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: ['*.'] }, 'http://foo.:8080/')).toBe(false);
  });

  it('keeps whole-URL glob matching for entries whose port is not numeric', () => {
    expect(isUrlAllowedByOriginPolicy({ blockedOrigins: ['example.com:*'] }, 'http://example.com:8080/')).toBe(false);
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: ['example.com:*'] }, 'http://example.com:8080/')).toBe(true);
    expect(isUrlAllowedByOriginPolicy({ blockedOrigins: ['[::1]'] }, 'http://[::1]:8080/')).toBe(false);
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: ['[::1]:8080'] }, 'http://[::1]:8080/')).toBe(true);
    expect(isUrlAllowedByOriginPolicy({ blockedOrigins: ['evil.com'] }, 'blob:http://evil.com/uuid')).toBe(false);
  });

  it('matches the hostname even when the request URL carries credentials', () => {
    expect(isUrlAllowedByOriginPolicy({ blockedOrigins: ['evil.com'] }, 'http://user:pass@evil.com:8080/')).toBe(false);
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: ['example.com'] }, 'http://example.com@evil.com/')).toBe(false);
  });

  it('does not block unrelated or lookalike hosts', () => {
    const policy = { blockedOrigins: ['evil.com'] };
    for (const url of ['http://notevil.com/', 'http://evil.com.example/', 'http://sub.evil.com/', 'http://example.com/?next=http://evil.com/'])
      expect(isUrlAllowedByOriginPolicy(policy, url), url).toBe(true);
  });

  it('keeps exact-port allowlist semantics and accepts the trailing-dot spelling of an allowed host', () => {
    const policy = { allowedOrigins: ['example.com', 'localhost:3000'] };
    expect(isUrlAllowedByOriginPolicy(policy, 'https://example.com/')).toBe(true);
    expect(isUrlAllowedByOriginPolicy(policy, 'https://example.com./')).toBe(true);
    expect(isUrlAllowedByOriginPolicy(policy, 'https://example.com:8443/')).toBe(false);
    expect(isUrlAllowedByOriginPolicy(policy, 'http://localhost:3000/')).toBe(true);
    expect(isUrlAllowedByOriginPolicy(policy, 'http://localhost.:3000/')).toBe(true);
    expect(isUrlAllowedByOriginPolicy(policy, 'http://localhost:3001/')).toBe(false);
    expect(isUrlAllowedByOriginPolicy(policy, 'https://evil.com/')).toBe(false);
  });

  it('lets the blocklist win over the allowlist on any port', () => {
    const policy = { allowedOrigins: ['*.example', 'tracker.example:8080'], blockedOrigins: ['tracker.example'] };
    expect(isUrlAllowedByOriginPolicy(policy, 'https://app.example/')).toBe(true);
    expect(isUrlAllowedByOriginPolicy(policy, 'http://tracker.example:8080/')).toBe(false);
    expect(isUrlAllowedByOriginPolicy(policy, 'http://tracker.example./')).toBe(false);
  });

  it('allows everything without a policy and keeps unparsable URLs to raw matching', () => {
    expect(isUrlAllowedByOriginPolicy(undefined, 'http://evil.com/')).toBe(true);
    expect(isUrlAllowedByOriginPolicy({}, 'http://evil.com:8080/')).toBe(true);
    expect(isUrlAllowedByOriginPolicy({ blockedOrigins: ['evil.com'] }, 'not a url')).toBe(true);
    expect(isUrlAllowedByOriginPolicy({ allowedOrigins: ['example.com'] }, 'not a url')).toBe(false);
  });
});
