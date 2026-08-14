import { describe, it, expect } from 'vitest';
import { parseSitemapLocations } from '../src/tools/auditSite.js';

// A sitemap is fetched from the audited site, so its bytes are attacker-
// controlled whenever the site is. The previous lazily-quantified
// /<loc>([\s\S]*?)<\/loc>/gi backtracked over the whole remaining document at
// every unclosed <loc>, which is quadratic: 500KB took ~11s of blocked event
// loop and froze every other MCP session in the process.

describe('parseSitemapLocations', () => {
  it('extracts plain locations in document order', () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://example.com/</loc></url>
      <url><loc>https://example.com/about</loc></url>
    </urlset>`;
    expect(parseSitemapLocations(xml)).toEqual([
      'https://example.com/',
      'https://example.com/about',
    ]);
  });

  it('unwraps CDATA and trims surrounding whitespace', () => {
    const xml = '<loc><![CDATA[https://example.com/a]]></loc><loc>\n  https://example.com/b\n  </loc>';
    expect(parseSitemapLocations(xml)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });

  it('matches tags case-insensitively, as the previous regex did', () => {
    expect(parseSitemapLocations('<LOC>https://example.com/x</LOC>')).toEqual(['https://example.com/x']);
    expect(parseSitemapLocations('<Loc >https://example.com/y</Loc >')).toEqual(['https://example.com/y']);
  });

  it('skips empty locations', () => {
    expect(parseSitemapLocations('<loc></loc><loc>   </loc><loc>https://example.com/z</loc>'))
        .toEqual(['https://example.com/z']);
  });

  it('ignores an unterminated trailing location instead of consuming the rest', () => {
    expect(parseSitemapLocations('<loc>https://example.com/ok</loc><loc>https://example.com/dangling'))
        .toEqual(['https://example.com/ok']);
  });

  it('pairs a closing tag with the nearest preceding opening tag', () => {
    // The lazy quantifier this replaced paired the same way, but emitted the
    // stray tag as part of the URL ("<loc>https://example.com/a"), which could
    // never parse. Taking the nearest open drops the stray instead.
    expect(parseSitemapLocations('<loc><loc>https://example.com/a</loc><loc>https://example.com/b</loc>'))
        .toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('drops a location longer than the cap without dropping its neighbours', () => {
    const huge = 'h'.repeat(5000);
    expect(parseSitemapLocations(`<loc>${huge}</loc><loc>https://example.com/kept</loc>`))
        .toEqual(['https://example.com/kept']);
  });

  it('returns nothing for a document with no locations', () => {
    expect(parseSitemapLocations('<urlset></urlset>')).toEqual([]);
    expect(parseSitemapLocations('')).toEqual([]);
  });

  // Regression guard for the quadratic blow-up. The bound is deliberately
  // generous (the old implementation needed ~11s for this input, ~100x the
  // ceiling here) so the test measures the complexity class, not the machine.
  it('parses a large run of unclosed tags in linear time', () => {
    const hostile = '<loc>'.repeat(500 * 1024 / 5);
    const start = performance.now();
    const result = parseSitemapLocations(hostile);
    const elapsed = performance.now() - start;

    expect(result).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
  });

  it('stays linear when unclosed tags are interleaved with real locations', () => {
    const hostile = `${'<loc>'.repeat(200 * 1024 / 5)}<loc>https://example.com/last</loc>`;
    const start = performance.now();
    const result = parseSitemapLocations(hostile);
    const elapsed = performance.now() - start;

    expect(result).toEqual(['https://example.com/last']);
    expect(elapsed).toBeLessThan(1000);
  });
});
