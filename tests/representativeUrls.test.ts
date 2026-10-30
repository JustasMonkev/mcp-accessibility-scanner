import { describe, expect, it } from 'vitest';
import { selectRepresentativeUrls } from '../src/utils/representativeUrls.js';

// The objective and coverage rule, written out independently. The distance is
// 0 for a shared template, otherwise 2^-(number of leading segments in common).
function segments(url: string): string[] {
  const parsed = new URL(url);
  const mask = (value: string) => /^\d+$/.test(value) ? ':id' : value;
  const query = [...parsed.searchParams.entries()].sort().map(([key, value]) => `?${key}=${mask(value)}`);
  return [parsed.host, ...parsed.pathname.split('/').filter(Boolean).map(mask), ...query];
}

function distance(first: string, second: string): number {
  const a = segments(first);
  const b = segments(second);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common])
    common++;
  return common === a.length && common === b.length ? 0 : 2 ** -common;
}

function cost(urls: string[], chosen: string[]): number {
  return urls.reduce((sum, url) => sum + Math.min(...chosen.map(facility => distance(url, facility))), 0);
}

// Whenever the chosen URLs under a prefix are at least its number of branches
// (its own template plus each distinct next segment), each branch has one.
function covers(urls: string[], chosen: string[]): boolean {
  const all = urls.map(segments);
  const picked = chosen.map(segments);
  const key = (parts: string[]) => parts.join('\u0000');
  const prefixes = new Set(all.flatMap(parts => parts.map((_, depth) => key(parts.slice(0, depth)))));
  for (const prefix of prefixes) {
    const under = (parts: string[]) => parts.length > 0 && (prefix === '' || key(parts).startsWith(prefix + '\u0000') || key(parts) === prefix);
    const depth = prefix === '' ? 0 : prefix.split('\u0000').length;
    const branch = (parts: string[]) => parts.length === depth ? '' : parts[depth];
    const branches = new Set(all.filter(under).map(branch));
    const chosenUnder = picked.filter(under);
    if (chosenUnder.length >= branches.size && new Set(chosenUnder.map(branch)).size < branches.size)
      return false;
  }
  return true;
}

function subsets<T>(items: T[], size: number): T[][] {
  if (size === 0)
    return [[]];
  if (items.length < size)
    return [];
  const [first, ...rest] = items;
  return [...subsets(rest, size - 1).map(subset => [first, ...subset]), ...subsets(rest, size)];
}

function seededRandom(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
}

describe('selectRepresentativeUrls', () => {
  it('returns every URL in order when the budget covers the list', () => {
    const urls = ['https://example.com/b', 'https://example.com/a'];
    expect(selectRepresentativeUrls(urls, 2)).toEqual(urls);
    expect(selectRepresentativeUrls(urls, 5)).toEqual(urls);
  });

  it('spreads the budget across sections instead of the first listed URLs', () => {
    const blog = Array.from({ length: 40 }, (_, index) => `https://example.com/blog/post-${index}`);
    const urls = [
      ...blog,
      'https://example.com/',
      'https://example.com/pricing',
      'https://example.com/docs/install',
      'https://example.com/docs/api',
      'https://example.com/products/1',
      'https://example.com/products/2',
    ];

    const selected = selectRepresentativeUrls(urls, 5);

    expect(selected).toHaveLength(5);
    expect(selected.filter(url => url.includes('/blog/'))).toHaveLength(1);
    expect(selected).toEqual(expect.arrayContaining(['https://example.com/', 'https://example.com/pricing', 'https://example.com/products/1']));
    expect(selected.filter(url => url.includes('/docs/'))).toHaveLength(1);
    // Listed order is kept.
    expect(selected).toEqual(urls.filter(url => selected.includes(url)));
  });

  it('treats numeric, UUID and long hex segments as one template', () => {
    const urls = [
      'https://example.com/orders/123',
      'https://example.com/orders/456',
      'https://example.com/items/123e4567-e89b-12d3-a456-426614174000',
      'https://example.com/items/0123456789abcdef',
      'https://example.com/about',
    ];
    // A word made of hex letters alone is a page name, not an id.
    expect(selectRepresentativeUrls([
      'https://example.com/items/0123456789abcdef',
      'https://example.com/items/abcdef0123456789',
      'https://example.com/items/facadeaccede',
    ], 2)).toEqual(['https://example.com/items/0123456789abcdef', 'https://example.com/items/facadeaccede']);
    const selected = selectRepresentativeUrls(urls, 3);
    expect(selected).toEqual([
      'https://example.com/orders/123',
      'https://example.com/items/123e4567-e89b-12d3-a456-426614174000',
      'https://example.com/about',
    ]);
  });

  it('separates hosts before paths', () => {
    const urls = [
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
      'https://blog.example.com/a',
    ];
    expect(selectRepresentativeUrls(urls, 2)).toContain('https://blog.example.com/a');
  });

  it('covers every section the budget can reach, even against populous ones', () => {
    const urls = [
      ...Array.from({ length: 100 }, (_, index) => `https://example.com/blog/news/post-${index}`),
      ...Array.from({ length: 100 }, (_, index) => `https://example.com/blog/guides/post-${index}`),
      'https://example.com/checkout',
    ];
    expect(selectRepresentativeUrls(urls, 2)).toEqual(['https://example.com/blog/news/post-0', 'https://example.com/checkout']);
    expect(selectRepresentativeUrls(urls, 3)).toEqual(['https://example.com/blog/news/post-0', 'https://example.com/blog/guides/post-0', 'https://example.com/checkout']);
  });

  it('lets k-median weigh sections by size when the budget cannot cover them all', () => {
    const urls = [
      ...Array.from({ length: 100 }, (_, index) => `https://example.com/blog/post-${index}`),
      'https://example.com/checkout',
      'https://example.com/help',
    ];
    // Three sections, one page: the blog serves the most URLs.
    expect(selectRepresentativeUrls(urls, 1)).toEqual(['https://example.com/blog/post-0']);
  });

  it('tells query-routed screens apart while masking id values', () => {
    const urls = [
      'https://example.com/?page=home',
      'https://example.com/?page=article',
      'https://example.com/?page=checkout',
      ...Array.from({ length: 20 }, (_, index) => `https://example.com/blog/post-${index}`),
      'https://example.com/item?id=1',
      'https://example.com/item?id=2',
    ];
    expect(selectRepresentativeUrls(urls, 5)).toEqual([
      'https://example.com/?page=home',
      'https://example.com/?page=article',
      'https://example.com/?page=checkout',
      'https://example.com/blog/post-0',
      'https://example.com/item?id=1',
    ]);
  });

  it('finds the optimal selection under the coverage rule', () => {
    const random = seededRandom(7);
    const words = ['a', 'b', 'c', '1', '2'];
    for (let round = 0; round < 200; round++) {
      const urls = new Set<string>();
      const size = 2 + Math.floor(random() * 8);
      while (urls.size < size) {
        const depth = Math.floor(random() * 4);
        const host = random() < 0.2 ? 'other.example' : 'example.com';
        const path = Array.from({ length: depth }, () => words[Math.floor(random() * words.length)]).join('/');
        const query = random() < 0.25 ? `?v=${words[Math.floor(random() * words.length)]}` : '';
        urls.add(`https://${host}/${path}${query}`);
      }
      const list = [...urls];
      const k = 1 + Math.floor(random() * Math.min(4, list.length - 1));

      const selected = selectRepresentativeUrls(list, k);

      expect(new Set(selected).size).toBe(k);
      expect(covers(list, selected), `${list.join(' ')} -> ${selected.join(' ')}`).toBe(true);
      const optimum = Math.min(...subsets(list, k).filter(subset => covers(list, subset)).map(subset => cost(list, subset)));
      expect(cost(list, selected)).toBe(optimum);
    }
  });

  it('merges a flat list of single pages as one part', () => {
    const urls = Array.from({ length: 100000 }, (_, index) => `https://example.com/page-${index}`);
    const startedAt = performance.now();
    expect(selectRepresentativeUrls(urls, 200)).toEqual(urls.slice(0, 200));
    expect(performance.now() - startedAt).toBeLessThan(5000);
  });

  it('handles a large list within the maximum budget quickly', () => {
    const urls = Array.from({ length: 20000 }, (_, index) => `https://example.com/section-${index % 40}/page-${index}`);
    const startedAt = performance.now();
    const selected = selectRepresentativeUrls(urls, 200);
    expect(selected).toHaveLength(200);
    expect(new Set(selected.map(url => url.split('/')[3])).size).toBe(40);
    expect(performance.now() - startedAt).toBeLessThan(5000);
  });
});
