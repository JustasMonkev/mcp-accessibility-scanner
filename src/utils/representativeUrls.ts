
type TreeNode = {
  depth: number;
  children: Map<string, TreeNode>;
  terminal: number[];
  size: number;
  best: ArrayLike<number>;
  // Kept from solve() so collect() can replay the choices without merging again.
  parts?: Part[];
  free?: Uint16Array[];
  covered?: Uint16Array[];
};

const idSegment = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[a-f]*\d)[0-9a-f]{12,})$/i;

function templateSegments(url: string): string[] {
  const parsed = new URL(url);
  const mask = (value: string) => idSegment.test(value) ? ':id' : value;
  const path = parsed.pathname.split('/').filter(Boolean).map(mask);
  if (!parsed.search)
    return [parsed.host, ...path];
  // Same stable code-unit order as URLSearchParams.sort(), which would also
  // write the sorted query back into the URL and parse it again.
  const entries = [...parsed.searchParams].sort(([a], [b]) => compareCodeUnits(a, b));
  const query = entries.map(([key, value]) => `?${key}=${mask(value)}`);
  return [parsed.host, ...path, ...query];
}

function compareCodeUnits(a: string, b: string): number {
  if (a === b)
    return 0;
  return a < b ? -1 : 1;
}

function newNode(depth: number): TreeNode {
  return { depth, children: new Map(), terminal: [], size: 0, best: [] };
}

type Part =
  | { kind: 'terminal', size: number, urls: number[] }
  | { kind: 'singles', size: number, children: TreeNode[] }
  | { kind: 'child', size: number, child: TreeNode };

function parts(node: TreeNode): Part[] {
  const result: Part[] = [];
  if (node.terminal.length)
    result.push({ kind: 'terminal', size: node.terminal.length, urls: node.terminal });
  let singles: Extract<Part, { kind: 'singles' }> | undefined;
  for (const child of node.children.values()) {
    if (child.size > 1) {
      result.push({ kind: 'child', size: child.size, child });
    } else if (singles) {
      singles.children.push(child);
      singles.size++;
    } else {
      singles = { kind: 'singles', size: 1, children: [child] };
      result.push(singles);
    }
  }
  return result;
}

function branchCount(node: TreeNode): number {
  return (node.terminal.length ? 1 : 0) + node.children.size;
}

function coveredCount(part: Part): number {
  return part.kind === 'singles' ? part.size : 1;
}

// Cost of giving `count` selections to the part, for every count it can take.
function partCosts(part: Part, k: number, missCost: number): Float64Array {
  const costs = new Float64Array(Math.min(k, part.size) + 1);
  costs[0] = part.size * missCost;
  for (let count = 1; count < costs.length; count++) {
    if (part.kind === 'singles')
      costs[count] = (part.size - count) * missCost;
    else if (part.kind === 'child')
      costs[count] = part.child.best[count];
  }
  return costs;
}

function mergePart(previous: Float64Array, costs: Float64Array, minimum: number, k: number): { row: Float64Array, choice: Uint16Array } {
  const last = previous.length - 1;
  const limit = Math.min(k, last + costs.length - 1);
  const row = new Float64Array(limit + 1);
  const choice = new Uint16Array(limit + 1);
  for (let total = 0; total <= limit; total++) {
    let best = Infinity;
    let chosen = 0;
    const end = Math.min(total, costs.length - 1);
    for (let count = Math.max(minimum, total - last); count <= end; count++) {
      const value = previous[total - count] + costs[count];
      if (value < best) {
        best = value;
        chosen = count;
      }
    }
    row[total] = best;
    choice[total] = chosen;
  }
  return { row, choice };
}

function mergeParts(nodeParts: Part[], costs: Float64Array[], k: number, cover: boolean, choices: Uint16Array[]): Float64Array {
  let previous: Float64Array = new Float64Array(1);
  for (let index = 0; index < nodeParts.length; index++) {
    const { row, choice } = mergePart(previous, costs[index], cover ? coveredCount(nodeParts[index]) : 0, k);
    choices.push(choice);
    previous = row;
  }
  return previous;
}

function solve(node: TreeNode, k: number) {
  if (!node.children.size) {
    node.best = new Float64Array(Math.min(k, node.size) + 1);
    return;
  }
  for (const child of node.children.values()) {
    if (child.size > 1)
      solve(child, k);
  }
  if (!node.terminal.length && node.children.size === 1 && node.size > 1) {
    const [child] = node.children.values();
    node.best = child.best;
    return;
  }
  const nodeParts = parts(node);
  const missCost = 2 ** -node.depth;
  const costs = nodeParts.map(part => partCosts(part, k, missCost));
  node.parts = nodeParts;
  node.free = [];
  const free = mergeParts(nodeParts, costs, k, false, node.free);
  const branches = branchCount(node);
  if (branches > k) {
    node.best = free;
    return;
  }
  node.covered = [];
  const covered = mergeParts(nodeParts, costs, k, true, node.covered);
  node.best = free.map((cost, count) => count >= branches ? covered[count] : cost);
}

function collect(node: TreeNode, count: number, selected: number[]) {
  if (!node.children.size) {
    for (let index = 0; index < count; index++)
      selected.push(node.terminal[index]);
    return;
  }
  if (!node.terminal.length && node.children.size === 1) {
    const [child] = node.children.values();
    collect(child, count, selected);
    return;
  }
  // Rows merged with a smaller budget are prefixes of the rows solve() merged.
  const nodeParts = node.parts!;
  const choices = count >= branchCount(node) ? node.covered! : node.free!;
  let remaining = count;
  for (let index = nodeParts.length - 1; index >= 0; index--) {
    const given = choices[index][remaining];
    remaining -= given;
    if (!given)
      continue;
    const part = nodeParts[index];
    if (part.kind === 'terminal')
      selected.push(...part.urls.slice(0, given));
    else if (part.kind === 'singles')
      part.children.slice(0, given).forEach(child => collect(child, 1, selected));
    else
      collect(part.child, given, selected);
  }
}

export function selectRepresentativeUrls(urls: readonly string[], k: number): string[] {
  if (urls.length <= k)
    return [...urls];
  const root = newNode(0);
  urls.forEach((url, index) => {
    let node = root;
    node.size++;
    for (const segment of templateSegments(url)) {
      let child = node.children.get(segment);
      if (!child) {
        child = newNode(node.depth + 1);
        node.children.set(segment, child);
      }
      node = child;
      node.size++;
    }
    node.terminal.push(index);
  });
  solve(root, k);
  const selected: number[] = [];
  collect(root, k, selected);
  return selected.sort((first, second) => first - second).map(index => urls[index]);
}
