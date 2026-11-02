
const maxTokens = 48;
const distanceRatio = 0.3;

const tokenPattern = /<\/?[a-z][\w:-]*|[^\s"'<>/=]+(?=\s*=)|"[^"]*"|'[^']*'|[^\s"'<>/=]+/gi;

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

/** @public */
export function semanticSignature(html: string): string {
  const match = tagName.exec(html);
  if (!match)
    return '';
  const tag = match[1].toLowerCase();
  const attributes = rootAttributes(html, match[0].length);
  const read = (name: string) => attributes.get(name)?.trim().toLowerCase();
  const type = read('type') || (tag === 'input' ? 'text' : '');
  return JSON.stringify([tag, type, read('role') ?? '']);
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
