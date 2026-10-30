import { describe, expect, it } from 'vitest';
import { HtmlPatternGroups, htmlTokens, semanticSignature, withinEditDistance } from '../src/utils/htmlPatterns.js';

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

function group(htmls: string[], maxPatterns = 50, maxNodes = 500) {
  const groups = new HtmlPatternGroups<string>(maxPatterns, maxNodes);
  for (const html of htmls)
    groups.add(html, html);
  return groups.summarize(3);
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1)
    return [items];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest]));
}

describe('semanticSignature', () => {
  it('reads the root element, its type and its role', () => {
    expect(semanticSignature('<INPUT Type="Checkbox" class="x">')).toBe('input type=checkbox role=');
    expect(semanticSignature('<input name="q">')).toBe('input type=text role=');
    expect(semanticSignature('<div role=\'button\'><span role="img"></span></div>')).toBe('div type= role=button');
    expect(semanticSignature('<div data-type="x" aria-role="y">')).toBe('div type= role=');
  });
});

describe('HtmlPatternGroups', () => {
  it('groups nodes that differ in an id, a source or a label', () => {
    const result = group([
      '<img src="/a.png" class="card-image">',
      '<img src="/b.png" class="card-image">',
      '<input type="text" id="email" name="email">',
      '<input type="text" id="phone" name="phone">',
      '<button>Save</button>',
      '<button>Cancel</button>',
    ]);
    expect(result).toMatchObject({ count: 3, capped: false });
  });

  it('keeps structurally different markup apart', () => {
    expect(group(['<p>Hi</p>', '<div>Hi</div>', '<a href="/x">Read more</a>', '<a href="/y">Click here</a>']).count).toBe(4);
  });

  it.each([
    ['input types', '<input type="text" class="form-control" name="email">', '<input type="checkbox" class="form-control" name="terms">'],
    ['an explicit type against the input default', '<input type="email" class="form-control" name="email">', '<input class="form-control" name="email">'],
    ['roles', '<div role="button" class="chip" tabindex="0">Save draft now</div>', '<div role="link" class="chip" tabindex="0">Save draft now</div>'],
    ['elements', '<a class="action primary large" href="#">Continue to payment page</a>', '<button class="action primary large" type="button">Continue to payment page</button>'],
  ])('never groups across %s', (_, first, second) => {
    expect(group([first, second]).count).toBe(2);
  });

  it('gives the same count and samples for every arrival order', () => {
    const nodes = ['<p>aa bb cc</p>', '<p>aa bb dd</p>', '<p>aa ee dd</p>'];
    const results = permutations(nodes).map(order => group(order));
    for (const result of results)
      expect(result).toEqual(results[0]);
    expect(results[0].count).toBe(2);
  });

  it('samples one node per pattern before repeating a pattern', () => {
    const result = group(['<img src="/a.png">', '<img src="/b.png">', '<img src="/c.png">', '<p>Some text here</p>']);
    expect(result.count).toBe(2);
    expect(result.samples).toEqual(['<img src="/a.png">', '<p>Some text here</p>', '<img src="/b.png">']);
  });

  it('marks the count partial past the pattern cap', () => {
    const result = group(['<p>one</p>', '<span class="x" role="note">two words</span>', '<p>uno</p>', '<table><tr><td>cell</td></tr></table>'], 2);
    expect(result).toMatchObject({ count: 2, capped: true });
  });

  it('keeps the canonically first nodes past the node cap, whatever the order', () => {
    const nodes = Array.from({ length: 30 }, (_, index) => `<x-widget-${String(index).padStart(2, '0')} role="w${index}">`);
    const forward = group(nodes, 50, 5);
    const backward = group([...nodes].reverse(), 50, 5);
    expect(forward).toEqual(backward);
    expect(forward).toMatchObject({ count: 5, capped: true });
    expect(forward.samples).toEqual(nodes.slice(0, 3));
  });
});
