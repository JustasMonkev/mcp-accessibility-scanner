/**
 * Picks `k` URLs to stand for a larger list, for crawls whose page budget is
 * smaller than the URL list.
 *
 * URLs are placed in a tree by host, path segment, then query parameter, with
 * id-like segments and values masked, so /products/1 and /products/2 (or
 * ?id=1 and ?id=2) share a node while ?page=home and ?page=checkout do not.
 * URLs that end at the same node share a template and are treated as
 * interchangeable; nothing else (fragments, client state) tells them apart.
 *
 * Selection follows two rules, and is exact under both:
 * - Coverage: when the pages allotted to a node are at least the number of its
 *   branches (its own template counts as one branch), every branch gets a
 *   page. With maxPages at least the number of top-level sections, every
 *   section is scanned.
 * - k-median for the rest: minimize the summed distance from every listed URL
 *   to its nearest chosen one, where two URLs are at distance 2^-depth of
 *   their deepest common node and 0 when they share a template. Below the
 *   coverage threshold this weighs sections by size, so a populous section can
 *   take pages a small one does not get. The distance is an ultrametric, which
 *   makes both rules solvable exactly by a knapsack over the tree.
 */

type TreeNode = {
  depth: number;
  children: Map<string, TreeNode>;
  // URLs whose template ends at this node, as indices into the input list.
  terminal: number[];
  size: number;
  // best[j] = least cost of serving every URL below this node with exactly j
  // chosen URLs below it, under the coverage rule, for 1 <= j <= min(k, size).
  best: number[];
};

const idSegment = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[a-f]*\d)[0-9a-f]{12,})$/i;

function templateSegments(url: string): string[] {
  const parsed = new URL(url);
  const mask = (value: string) => idSegment.test(value) ? ':id' : value;
  const path = parsed.pathname.split('/').filter(Boolean).map(mask);
  const query = [...parsed.searchParams.entries()]
      .sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0))
      .map(([key, value]) => `?${key}=${mask(value)}`);
  return [parsed.host, ...path, ...query];
}

function newNode(depth: number): TreeNode {
  return { depth, children: new Map(), terminal: [], size: 0, best: [] };
}

// What a node merges over: its own terminal URLs, which are all at distance 0
// from each other; its single-URL children, which are interchangeable and so
// merged as one part (a flat sitemap of thousands of pages is one part, not
// thousands); and each larger child subtree.
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

// The node's branches: its own template plus each child.
function branchCount(node: TreeNode): number {
  return (node.terminal.length ? 1 : 0) + node.children.size;
}

// The fewest pages a part takes when every branch must be covered.
function coveredCount(part: Part): number {
  return part.kind === 'singles' ? part.size : 1;
}

// Cost of serving a part's URLs with `count` (>= 1) chosen among them.
function partCost(part: Part, count: number, missCost: number): number {
  if (part.kind === 'terminal')
    return 0;
  if (part.kind === 'singles')
    return (part.size - count) * missCost;
  return part.child.best[count];
}

/**
 * Merges a node's parts one at a time: after part i, row[t] is the least cost
 * of the first i parts with t chosen URLs among them. A part given none is
 * served from a sibling at this node's distance. With `cover`, each part gets
 * at least its covered count. Only the previous row is kept; `onRow` receives
 * how many URLs each part got in each row's optimum, for the reconstruction
 * pass.
 */
function mergeParts(node: TreeNode, nodeParts: Part[], k: number, cover: boolean, onRow?: (choice: Uint16Array) => void): number[] {
  const missCost = 2 ** -node.depth;
  let previous = [0];
  for (const part of nodeParts) {
    const minimum = cover ? coveredCount(part) : 0;
    const limit = Math.min(k, previous.length - 1 + Math.min(k, part.size));
    const row = new Array<number>(limit + 1).fill(Infinity);
    const choice = onRow ? new Uint16Array(limit + 1) : undefined;
    for (let t = 0; t <= limit; t++) {
      for (let count = Math.max(minimum, t - (previous.length - 1)); count <= Math.min(t, part.size); count++) {
        const value = previous[t - count] + (count === 0 ? part.size * missCost : partCost(part, count, missCost));
        if (value < row[t]) {
          row[t] = value;
          if (choice)
            choice[t] = count;
        }
      }
    }
    if (choice)
      onRow!(choice);
    previous = row;
  }
  return previous;
}

function solve(node: TreeNode, k: number) {
  for (const child of node.children.values())
    solve(child, k);
  const nodeParts = parts(node);
  const free = mergeParts(node, nodeParts, k, false);
  const branches = branchCount(node);
  if (branches > k) {
    node.best = free;
    return;
  }
  const covered = mergeParts(node, nodeParts, k, true);
  node.best = free.map((cost, count) => count >= branches ? covered[count] : cost);
}

function collect(node: TreeNode, count: number, k: number, selected: number[]) {
  const nodeParts = parts(node);
  const choices: Uint16Array[] = [];
  mergeParts(node, nodeParts, k, count >= branchCount(node), choice => choices.push(choice));
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
      part.children.slice(0, given).forEach(child => collect(child, 1, k, selected));
    else
      collect(part.child, given, k, selected);
  }
}

/** The chosen URLs in their original order; all of them when k covers the list. */
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
  collect(root, k, k, selected);
  return selected.sort((first, second) => first - second).map(index => urls[index]);
}
