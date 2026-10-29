/**
 * Groups the HTML of Axe result nodes into patterns: nodes whose markup is
 * within a small token edit distance of each other are one pattern, so ten
 * product cards that differ only in an id, a src or a label count as one
 * component to fix instead of ten unique occurrences.
 *
 * Distance is unit-cost edit distance over tokens (tag names, attribute names,
 * attribute values, text words) rather than characters: changing `id="a1"` to
 * `id="b22"` is one edit, not three. Axe node HTML is short, so a banded
 * dynamic program with early exit is cheaper here than any asymptotically
 * faster scheme.
 */

// Long nodes are compared on their opening markup, where a component's
// identity lives; descendants past this point rarely change the pattern.
const maxTokens = 48;
// Two nodes are one pattern when at most this fraction of the longer token
// list has to change (minimum one edit).
const distanceRatio = 0.3;

const tokenPattern = /<\/?[a-z][\w:-]*|[^\s"'<>/=]+(?=\s*=)|"[^"]*"|'[^']*'|[^\s"'<>/=]+/gi;

/** Exported for tests. @public */
export function htmlTokens(html: string): string[] {
  const tokens: string[] = [];
  for (const match of html.matchAll(tokenPattern)) {
    const token = match[0];
    tokens.push(token.startsWith('<') ? token.toLowerCase() : token);
    if (tokens.length === maxTokens)
      break;
  }
  return tokens;
}

/**
 * Whether the unit-cost edit distance between `a` and `b` is at most `limit`.
 * Only the diagonal band of width 2·limit+1 is filled, and the scan stops as
 * soon as every cell in a row exceeds the limit. Exported for tests.
 * @public
 */
export function withinEditDistance(a: readonly string[], b: readonly string[], limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit)
    return false;
  const over = limit + 1;
  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++)
    previous[j] = j <= limit ? j : over;
  for (let i = 1; i <= a.length; i++) {
    const from = Math.max(1, i - limit);
    const to = Math.min(b.length, i + limit);
    current.fill(over);
    current[0] = i <= limit ? i : over;
    let rowMin = current[0];
    for (let j = from; j <= to; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      const value = Math.min(substitution, previous[j] + 1, current[j - 1] + 1, over);
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > limit)
      return false;
    [previous, current] = [current, previous];
  }
  return previous[b.length] <= limit;
}

function similar(a: readonly string[], b: readonly string[]): boolean {
  const limit = Math.max(1, Math.floor(distanceRatio * Math.max(a.length, b.length)));
  return withinEditDistance(a, b, limit);
}

/**
 * Assigns each added HTML snippet to the first stored pattern it is similar
 * to, or opens a new pattern. At most `maxPatterns` are stored, which bounds
 * the work per node; once full, a node that matches none of them is not
 * grouped and `capped` turns true, so `count` is then a lower bound.
 */
export class HtmlPatternGroups {
  private readonly _maxPatterns: number;
  private readonly _representatives: string[][] = [];
  private _capped = false;

  constructor(maxPatterns: number) {
    this._maxPatterns = maxPatterns;
  }

  /** The index of the node's pattern, or -1 when it fits none and the store is full. */
  add(html: string): number {
    const tokens = htmlTokens(html);
    const index = this._representatives.findIndex(representative => similar(representative, tokens));
    if (index !== -1)
      return index;
    if (this._representatives.length >= this._maxPatterns) {
      this._capped = true;
      return -1;
    }
    this._representatives.push(tokens);
    return this._representatives.length - 1;
  }

  get count(): number {
    return this._representatives.length;
  }

  get capped(): boolean {
    return this._capped;
  }
}
