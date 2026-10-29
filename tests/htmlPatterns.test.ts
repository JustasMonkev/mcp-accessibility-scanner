import { describe, expect, it } from 'vitest';
import { HtmlPatternGroups, htmlTokens, withinEditDistance } from '../src/utils/htmlPatterns.js';

function editDistance(a: string[], b: string[]): number {
  const table = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++)
      table[i][j] = Math.min(table[i - 1][j] + 1, table[i][j - 1] + 1, table[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return table[a.length][b.length];
}

describe('htmlTokens', () => {
  it('splits markup into tags, attribute names, values and words', () => {
    expect(htmlTokens('<BUTTON class="btn primary" data-id=\'7\' disabled>Save draft</button>')).toEqual([
      '<button', 'class', '"btn primary"', 'data-id', '\'7\'', 'disabled', 'Save', 'draft', '</button',
    ]);
  });

  it('caps the token count for long markup', () => {
    expect(htmlTokens('<p>' + 'word '.repeat(200) + '</p>')).toHaveLength(48);
  });
});

describe('withinEditDistance', () => {
  it('agrees with the full dynamic program', () => {
    const alphabet = ['a', 'b', 'c'];
    let seed = 11;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const word = () => Array.from({ length: Math.floor(next() * 8) }, () => alphabet[Math.floor(next() * alphabet.length)]);
    for (let round = 0; round < 500; round++) {
      const a = word();
      const b = word();
      const limit = Math.floor(next() * 5);
      expect(withinEditDistance(a, b, limit), `${a.join('')} vs ${b.join('')} within ${limit}`).toBe(editDistance(a, b) <= limit);
    }
  });
});

describe('HtmlPatternGroups', () => {
  it('groups nodes that differ in an id, a source or a label', () => {
    const groups = new HtmlPatternGroups(50);
    expect(groups.add('<img src="/a.png" class="card-image">')).toBe(0);
    expect(groups.add('<img src="/b.png" class="card-image">')).toBe(0);
    expect(groups.add('<input type="text" id="email" name="email">')).toBe(1);
    expect(groups.add('<input type="text" id="phone" name="phone">')).toBe(1);
    expect(groups.add('<button>Save</button>')).toBe(2);
    expect(groups.add('<button>Cancel</button>')).toBe(2);
    expect(groups.count).toBe(3);
    expect(groups.capped).toBe(false);
  });

  it('keeps structurally different markup apart', () => {
    const groups = new HtmlPatternGroups(50);
    groups.add('<p>Hi</p>');
    groups.add('<div>Hi</div>');
    groups.add('<a href="/x">Read more</a>');
    groups.add('<a href="/y">Click here</a>');
    expect(groups.count).toBe(4);
  });

  it('stops storing patterns at the cap and says the count is a lower bound', () => {
    const groups = new HtmlPatternGroups(2);
    expect(groups.add('<p>one</p>')).toBe(0);
    expect(groups.add('<span class="x" role="note">two words</span>')).toBe(1);
    expect(groups.add('<p>uno</p>')).toBe(0);
    expect(groups.capped).toBe(false);
    expect(groups.add('<table><tr><td>cell</td></tr></table>')).toBe(-1);
    expect(groups.count).toBe(2);
    expect(groups.capped).toBe(true);
  });
});
