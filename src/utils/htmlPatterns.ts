
const maxTokens = 48;
const distanceRatio = 0.3;

const tokenPattern = /<\/?[a-z][\w:-]*|"[^"]*"|'[^']*'|[^\s"'<>/=]+/gi;

/** @public */
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

/** @public */
export function withinEditDistance(a: readonly string[], b: readonly string[], limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit)
    return false;
  let start = 0;
  let aEnd = a.length;
  let bEnd = b.length;
  while (start < aEnd && start < bEnd && a[start] === b[start])
    start++;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  const rows = aEnd - start;
  const columns = bEnd - start;
  if (Math.max(rows, columns) <= limit)
    return true;
  const over = limit + 1;
  let previous = new Array<number>(columns + 1);
  let current = new Array<number>(columns + 1);
  for (let j = 0; j <= columns; j++)
    previous[j] = j <= limit ? j : over;
  for (let i = 1; i <= rows; i++) {
    const from = Math.max(1, i - limit);
    const to = Math.min(columns, i + limit);
    current[from - 1] = over;
    if (to < columns)
      current[to + 1] = over;
    current[0] = i <= limit ? i : over;
    let rowMin = current[0];
    for (let j = from; j <= to; j++) {
      const substitution = previous[j - 1] + (a[start + i - 1] === b[start + j - 1] ? 0 : 1);
      const value = Math.min(substitution, previous[j] + 1, current[j - 1] + 1, over);
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > limit)
      return false;
    [previous, current] = [current, previous];
  }
  return previous[columns] <= limit;
}

function similar(a: readonly string[], b: readonly string[]): boolean {
  const limit = Math.max(1, Math.floor(distanceRatio * Math.max(a.length, b.length)));
  return withinEditDistance(a, b, limit);
}

const tagName = /^\s*<([a-z][^\s/>]*)/i;

function rootAttributes(html: string, from: number): { type?: string, role?: string } {
  const attributes: { type?: string, role?: string } = {};
  const isSpace = (char: string) => char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
  let index = from;
  while (index < html.length) {
    while (index < html.length && (isSpace(html[index]) || html[index] === '/'))
      index++;
    if (index >= html.length || html[index] === '>')
      break;
    const nameStart = index;
    index++;
    while (index < html.length && !isSpace(html[index]) && html[index] !== '/' && html[index] !== '>' && html[index] !== '=')
      index++;
    const name = html.slice(nameStart, index).toLowerCase();
    while (index < html.length && isSpace(html[index]))
      index++;
    let valueStart = index;
    let valueEnd = index;
    if (html[index] === '=') {
      index++;
      while (index < html.length && isSpace(html[index]))
        index++;
      const quote = html[index];
      if (quote === '"' || quote === '\'') {
        const close = html.indexOf(quote, index + 1);
        valueStart = index + 1;
        valueEnd = close === -1 ? html.length : close;
        index = valueEnd + 1;
      } else {
        valueStart = index;
        while (index < html.length && !isSpace(html[index]) && html[index] !== '>')
          index++;
        valueEnd = index;
      }
    }
    if ((name === 'type' || name === 'role') && attributes[name] === undefined) {
      attributes[name] = html.slice(valueStart, valueEnd).trim().toLowerCase();
      if (attributes.type !== undefined && attributes.role !== undefined)
        break;
    }
  }
  return attributes;
}

/** @public */
export function semanticSignature(html: string): string {
  const match = tagName.exec(html);
  if (!match)
    return '';
  const tag = match[1].toLowerCase();
  const attributes = rootAttributes(html, match[0].length);
  const type = attributes.type || (tag === 'input' ? 'text' : '');
  return JSON.stringify([tag, type, attributes.role ?? '']);
}

type Entry<T> = { key: string, signature: string, tokens: string[], item: T };

function byKey<T>(first: Entry<T>, second: Entry<T>): number {
  if (first.key === second.key)
    return 0;
  return first.key < second.key ? -1 : 1;
}

export class HtmlPatternGroups<T> {
  private readonly _maxPatterns: number;
  private readonly _maxNodes: number;
  private readonly _entries = new Map<string, Entry<T>>();
  private _truncated = false;

  constructor(maxPatterns: number, maxNodes: number) {
    this._maxPatterns = maxPatterns;
    this._maxNodes = maxNodes;
  }

  add(html: string, item: T) {
    const tokens = htmlTokens(html);
    const signature = semanticSignature(html);
    const key = JSON.stringify([signature, tokens]);
    if (this._entries.has(key))
      return;
    this._entries.set(key, { key, signature, tokens, item });
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
