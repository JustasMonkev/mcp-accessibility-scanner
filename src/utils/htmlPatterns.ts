/**
 * Groups the HTML of Axe result nodes into patterns of near-identical markup:
 * ten product cards that differ only in an id, a src or a label text form one
 * pattern instead of ten unique occurrences. This is a markup heuristic: nodes
 * in one pattern often share a template, but similar markup does not prove a
 * shared root cause, and different markup can share one.
 *
 * Two nodes can share a pattern only when their root element, its `type`
 * (inputs default to text) and its `role` match; within that, they share one
 * when their markup is within a small edit distance over tokens (tag names,
 * attribute names, attribute values, text words) rather than characters, so
 * changing `id="a1"` to `id="b22"` is one edit, not three. Only the first
 * tokens of a node are compared (see maxTokens); differences past them are
 * invisible. Axe node HTML is short, so a banded dynamic program with early
 * exit is cheaper here than any asymptotically faster scheme.
 *
 * Similarity is not transitive, so grouping depends on the order nodes are
 * compared in. Nodes are therefore buffered and grouped in a canonical sort
 * order, which makes the result depend only on the set of nodes, not on the
 * order a crawl found them in.
 */

// Long nodes are compared on their opening markup, where a component's
// identity usually lives; differences past this many tokens are not seen.
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

const tagName = /^\s*<([a-z][^\s/>]*)/i;

/**
 * The root element's attributes, read the way the HTML tokenizer reads them:
 * a quoted value runs to its closing quote whatever it contains (`>`, `=`,
 * other attribute names), an unquoted one to whitespace or `>`, and the first
 * of duplicate attributes wins. Names are lower-cased.
 */
function rootAttributes(html: string, from: number): Map<string, string> {
  const attributes = new Map<string, string>();
  const isSpace = (char: string) => char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
  let index = from;
  while (index < html.length) {
    while (index < html.length && (isSpace(html[index]) || html[index] === '/'))
      index++;
    if (index >= html.length || html[index] === '>')
      break;
    const nameStart = index;
    // A leading `=` is part of the name, as in the tokenizer.
    index++;
    while (index < html.length && !isSpace(html[index]) && html[index] !== '/' && html[index] !== '>' && html[index] !== '=')
      index++;
    const name = html.slice(nameStart, index).toLowerCase();
    while (index < html.length && isSpace(html[index]))
      index++;
    let value = '';
    if (html[index] === '=') {
      index++;
      while (index < html.length && isSpace(html[index]))
        index++;
      const quote = html[index];
      if (quote === '"' || quote === '\'') {
        const close = html.indexOf(quote, index + 1);
        const valueEnd = close === -1 ? html.length : close;
        value = html.slice(index + 1, valueEnd);
        index = valueEnd + 1;
      } else {
        const valueStart = index;
        while (index < html.length && !isSpace(html[index]) && html[index] !== '>')
          index++;
        value = html.slice(valueStart, index);
      }
    }
    if (!attributes.has(name))
      attributes.set(name, value);
  }
  return attributes;
}

/** The root element, its type and its role, which fuzzy matching may not change. @public */
export function semanticSignature(html: string): string {
  const match = tagName.exec(html);
  if (!match)
    return '';
  const tag = match[1].toLowerCase();
  const attributes = rootAttributes(html, match[0].length);
  const read = (name: string) => attributes.get(name)?.trim().toLowerCase();
  // An input with no or an empty type is a text input.
  const type = read('type') || (tag === 'input' ? 'text' : '');
  return `${tag} type=${type} role=${read('role') ?? ''}`;
}

type Entry<T> = { key: string, signature: string, tokens: string[], item: T };

const byKey = <T>(first: Entry<T>, second: Entry<T>) => (first.key < second.key ? -1 : first.key > second.key ? 1 : 0);

/**
 * Collects a rule's unique nodes, then groups them in canonical order: each
 * node joins the first pattern whose leading node it is similar to, or opens a
 * new one. At most `maxNodes` nodes (the first in canonical order) and
 * `maxPatterns` patterns are kept, which bounds memory and the comparisons per
 * node; when either limit cuts in, `capped` is true and the count covers only
 * part of the nodes.
 */
export class HtmlPatternGroups<T> {
  private readonly _maxPatterns: number;
  private readonly _maxNodes: number;
  private readonly _entries = new Map<string, Entry<T>>();
  private _truncated = false;

  constructor(maxPatterns: number, maxNodes: number) {
    this._maxPatterns = maxPatterns;
    this._maxNodes = maxNodes;
  }

  /** Records a node; `item` is what `summarize` returns as its sample. */
  add(html: string, item: T) {
    const tokens = htmlTokens(html);
    const signature = semanticSignature(html);
    const key = `${signature}\u0001${tokens.join('\u0000')}`;
    if (this._entries.has(key))
      return;
    this._entries.set(key, { key, signature, tokens, item });
    // Pruning to the canonical first maxNodes keeps the result independent of
    // arrival order: a node dropped here could never rank among them later.
    if (this._entries.size > 2 * this._maxNodes)
      this._prune();
  }

  private _prune() {
    const kept = [...this._entries.values()].sort(byKey).slice(0, this._maxNodes);
    this._truncated = true;
    this._entries.clear();
    for (const entry of kept)
      this._entries.set(entry.key, entry);
  }

  /** The pattern count, and samples that show as many different patterns as they can. */
  summarize(maxSamples: number): { count: number, capped: boolean, samples: T[] } {
    if (this._entries.size > this._maxNodes)
      this._prune();
    const leaders = new Map<string, Entry<T>[]>();
    const firsts: Entry<T>[] = [];
    const rest: Entry<T>[] = [];
    let capped = this._truncated;
    for (const entry of [...this._entries.values()].sort(byKey)) {
      const sameSignature = leaders.get(entry.signature) ?? [];
      if (sameSignature.some(leader => similar(leader.tokens, entry.tokens))) {
        rest.push(entry);
      } else if (firsts.length < this._maxPatterns) {
        sameSignature.push(entry);
        leaders.set(entry.signature, sameSignature);
        firsts.push(entry);
      } else {
        capped = true;
        rest.push(entry);
      }
    }
    return {
      count: firsts.length,
      capped,
      samples: [...firsts, ...rest].slice(0, maxSamples).map(entry => entry.item),
    };
  }
}
