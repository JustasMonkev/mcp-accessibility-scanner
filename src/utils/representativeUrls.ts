
type TreeNode = {
  depth: number;
  children: Map<string, TreeNode>;
  terminal: number[];
  size: number;
  best: Costs;
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
  const entries = [...parsed.searchParams].sort(([a], [b]) => compareCodeUnits(a, b));
  const query = entries.map(([key, value]) => `?${key}=${mask(value)}`);
  return [parsed.host, ...path, ...query];
}

function compareCodeUnits(a: string, b: string): number {
  if (a === b)
    return 0;
  return a < b ? -1 : 1;
}

// A miss at depth d costs 2 ** -d. Each cost is kept as value * 2 ** -depth,
// at the depth of its shallowest miss, so costs below a deep shared prefix
// keep their relative sizes instead of underflowing to zero. A zero cost has
// value 0 at depth noMiss.
type Costs = { value: Float64Array, depth: Int32Array };

const noMiss = 0x7fffffff;

function newCosts(length: number): Costs {
  return { value: new Float64Array(length), depth: new Int32Array(length).fill(noMiss) };
}

const unsolved = newCosts(0);

// 2 ** -levels, for rescaling a cost to a shallower depth. Past the smallest
// double it is 0: a nonzero value is at least 1, so the deeper cost is then
// far below the precision of the shallower one.
const halves = Float64Array.from({ length: 1076 }, (_, levels) => 2 ** -levels);

function half(levels: number): number {
  return levels < halves.length ? halves[levels] : 0;
}

// Whether the first cost is lower than the second, compared at the shallower depth.
function lower(firstValue: number, firstDepth: number, secondValue: number, secondDepth: number): boolean {
  if (firstDepth === secondDepth)
    return firstValue < secondValue;
  if (firstDepth < secondDepth)
    return firstValue < secondValue * half(secondDepth - firstDepth);
  return firstValue * half(firstDepth - secondDepth) < secondValue;
}

function newNode(depth: number): TreeNode {
  return { depth, children: new Map(), terminal: [], size: 0, best: unsolved };
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

// The costs of giving each count of URLs to a part of the node at `depth`,
// where the part's own URLs are missed when it gets none.
function partCosts(part: Part, k: number, depth: number): Costs {
  const costs = newCosts(Math.min(k, part.size) + 1);
  costs.value[0] = part.size;
  costs.depth[0] = depth;
  for (let count = 1; count < costs.value.length; count++) {
    if (part.kind === 'singles' && count < part.size) {
      costs.value[count] = part.size - count;
      costs.depth[count] = depth;
    } else if (part.kind === 'child') {
      costs.value[count] = part.child.best.value[count];
      costs.depth[count] = part.child.best.depth[count];
    }
  }
  return costs;
}

function mergePart(previous: Costs, costs: Costs, minimum: number, k: number): { row: Costs, choice: Uint16Array } {
  const { value: previousValues, depth: previousDepths } = previous;
  const { value: partValues, depth: partDepths } = costs;
  const last = previousValues.length - 1;
  const limit = Math.min(k, last + partValues.length - 1);
  const row = newCosts(limit + 1);
  const choice = new Uint16Array(limit + 1);
  for (let total = 0; total <= limit; total++) {
    let bestValue = Infinity;
    let bestDepth = 0;
    let chosen = 0;
    const end = Math.min(total, partValues.length - 1);
    for (let count = Math.max(minimum, total - last); count <= end; count++) {
      // Adds the two costs at the shallower of their depths.
      let value = previousValues[total - count];
      let depth = previousDepths[total - count];
      const partValue = partValues[count];
      const partDepth = partDepths[count];
      if (depth === partDepth) {
        value += partValue;
      } else if (depth < partDepth) {
        value += partValue * half(partDepth - depth);
      } else {
        value = partValue + value * half(depth - partDepth);
        depth = partDepth;
      }
      if (lower(value, depth, bestValue, bestDepth)) {
        bestValue = value;
        bestDepth = depth;
        chosen = count;
      }
    }
    row.value[total] = bestValue;
    row.depth[total] = bestDepth;
    choice[total] = chosen;
  }
  return { row, choice };
}

function mergeParts(nodeParts: Part[], costs: Costs[], k: number, cover: boolean, choices: Uint16Array[]): Costs {
  let previous = newCosts(1);
  for (let index = 0; index < nodeParts.length; index++) {
    const { row, choice } = mergePart(previous, costs[index], cover ? coveredCount(nodeParts[index]) : 0, k);
    choices.push(choice);
    previous = row;
  }
  return previous;
}

// Bounds the selection work (trie segments plus dynamic-programming cells),
// which grows with how many URLs are listed, how deep they go and maxPages.
const defaultWorkBudget = 200_000_000;

class WorkBudgetExceeded extends Error {}

class WorkBudget {
  private _remaining: number;

  constructor(units: number) {
    this._remaining = units;
  }

  spend(units: number): void {
    this._remaining -= units;
    if (this._remaining < 0)
      throw new WorkBudgetExceeded();
  }
}

// The cells mergeParts fills: each part's row holds at most k + 1 totals,
// each trying at most that part's number of counts.
function mergeCells(costs: Costs[], k: number): number {
  let cells = 0;
  let total = 0;
  for (const { value } of costs) {
    total += value.length - 1;
    cells += (Math.min(k, total) + 1) * value.length;
  }
  return cells;
}

function solveNode(node: TreeNode, k: number, budget: WorkBudget) {
  if (!node.children.size) {
    node.best = newCosts(Math.min(k, node.size) + 1);
    return;
  }
  if (!node.terminal.length && node.children.size === 1 && node.size > 1) {
    const [child] = node.children.values();
    node.best = child.best;
    return;
  }
  const nodeParts = parts(node);
  budget.spend(nodeParts.reduce((units, part) => units + Math.min(k, part.size) + 1, 0));
  const costs = nodeParts.map(part => partCosts(part, k, node.depth));
  const mergeWork = mergeCells(costs, k);
  budget.spend(mergeWork);
  node.parts = nodeParts;
  node.free = [];
  const free = mergeParts(nodeParts, costs, k, false, node.free);
  const branches = branchCount(node);
  if (branches > k) {
    node.best = free;
    return;
  }
  budget.spend(mergeWork);
  node.covered = [];
  const covered = mergeParts(nodeParts, costs, k, true, node.covered);
  node.best = {
    value: free.value.map((cost, count) => count >= branches ? covered.value[count] : cost),
    depth: free.depth.map((depth, count) => count >= branches ? covered.depth[count] : depth),
  };
}

// Children are solved before their parent. The traversal keeps its own stack,
// since the tree is as deep as the longest listed URL.
function solve(root: TreeNode, k: number, budget: WorkBudget) {
  const preorder: TreeNode[] = [];
  const pending = [root];
  for (let node = pending.pop(); node; node = pending.pop()) {
    preorder.push(node);
    for (const child of node.children.values()) {
      if (child.size > 1)
        pending.push(child);
    }
  }
  for (let index = preorder.length - 1; index >= 0; index--)
    solveNode(preorder[index], k, budget);
}

function collect(root: TreeNode, k: number, selected: number[]) {
  const pending: { node: TreeNode, count: number }[] = [{ node: root, count: k }];
  for (let task = pending.pop(); task; task = pending.pop()) {
    let { node } = task;
    const { count } = task;
    while (node.children.size === 1 && !node.terminal.length)
      [node] = node.children.values();
    if (!node.children.size) {
      for (let index = 0; index < count; index++)
        selected.push(node.terminal[index]);
      continue;
    }
    const nodeParts = node.parts;
    const choices = count >= branchCount(node) ? node.covered : node.free;
    if (!nodeParts || !choices)
      throw new Error('Representative URL tree was not prepared before collecting.');
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
        pending.push(...part.children.slice(0, given).map(child => ({ node: child, count: 1 })));
      else
        pending.push({ node: part.child, count: given });
    }
  }
}

function buildTree(urls: readonly string[], budget: WorkBudget): TreeNode {
  const root = newNode(0);
  urls.forEach((url, index) => {
    const segments = templateSegments(url);
    budget.spend(segments.length + 1);
    let node = root;
    node.size++;
    for (const segment of segments) {
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
  return root;
}

/**
 * `complete` is false when the selection would exceed its work budget; the
 * first `k` URLs in listed order are returned instead.
 */
export function selectRepresentativeUrls(urls: readonly string[], k: number, workBudget = defaultWorkBudget): { urls: string[], complete: boolean } {
  if (urls.length <= k)
    return { urls: [...urls], complete: true };
  const selected: number[] = [];
  try {
    const budget = new WorkBudget(workBudget);
    const root = buildTree(urls, budget);
    solve(root, k, budget);
    collect(root, k, selected);
  } catch (error) {
    if (!(error instanceof WorkBudgetExceeded))
      throw error;
    return { urls: urls.slice(0, k), complete: false };
  }
  return { urls: selected.sort((first, second) => first - second).map(index => urls[index]), complete: true };
}
