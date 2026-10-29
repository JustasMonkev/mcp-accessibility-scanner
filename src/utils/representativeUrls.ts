/**
 * Picks `k` URLs that best represent a larger list, for crawls whose page budget
 * is smaller than the URL list (a sitemap with thousands of blog posts and a
 * budget of 25 pages should not spend all 25 on the blog).
 *
 * This is k-median: choose k URLs minimizing the summed distance from every
 * listed URL to its nearest chosen one. URLs are placed in a tree by host and
 * path segment, with id-like segments masked so /products/1 and /products/2
 * share a node. Two URLs are at distance 2^-depth of their deepest common node,
 * and 0 when they share a template. That distance is an ultrametric, which makes
 * k-median solvable exactly by a knapsack over the tree, so no approximation
 * is needed.
 */

type TreeNode = {
  depth: number;
  children: Map<string, TreeNode>;
  // URLs whose template ends at this node, as indices into the input list.
  terminal: number[];
  size: number;
  // best[j] = least cost of serving every URL below this node with exactly j
  // chosen URLs below it, for 1 <= j <= min(k, size). best[0] is unused.
  best: number[];
};

const idSegment = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[a-f]*\d)[0-9a-f]{12,})$/i;

function templateSegments(url: string): string[] {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').filter(Boolean).map(segment => idSegment.test(segment) ? ':id' : segment);
  return [parsed.host, ...segments];
}

function newNode(depth: number): TreeNode {
  return { depth, children: new Map(), terminal: [], size: 0, best: [] };
}

// A child is either a subtree or the node's own terminal URLs, which are all
// at distance 0 from each other.
type Part = { size: number, cost: (count: number) => number };

function parts(node: TreeNode): Part[] {
  const result: Part[] = [];
  if (node.terminal.length)
    result.push({ size: node.terminal.length, cost: () => 0 });
  for (const child of node.children.values())
    result.push({ size: child.size, cost: count => child.best[count] });
  return result;
}

/**
 * Merges the parts of a node: table[i][t] is the least cost of the first i
 * parts with t chosen URLs among them. A part given none is served from a
 * sibling at this node's distance.
 */
function mergeParts(node: TreeNode, k: number): { tables: number[][], choices: number[][] } {
  const missCost = 2 ** -node.depth;
  const tables: number[][] = [[0]];
  const choices: number[][] = [[0]];
  for (const part of parts(node)) {
    const previous = tables[tables.length - 1];
    const limit = Math.min(k, previous.length - 1 + Math.min(k, part.size));
    const table = new Array<number>(limit + 1).fill(Infinity);
    const choice = new Array<number>(limit + 1).fill(0);
    for (let t = 0; t <= limit; t++) {
      for (let count = Math.max(0, t - (previous.length - 1)); count <= Math.min(t, part.size); count++) {
        const value = previous[t - count] + (count === 0 ? part.size * missCost : part.cost(count));
        if (value < table[t]) {
          table[t] = value;
          choice[t] = count;
        }
      }
    }
    tables.push(table);
    choices.push(choice);
  }
  return { tables, choices };
}

function solve(node: TreeNode, k: number) {
  for (const child of node.children.values())
    solve(child, k);
  const { tables } = mergeParts(node, k);
  node.best = tables[tables.length - 1];
}

function collect(node: TreeNode, count: number, k: number, selected: number[]) {
  const { choices } = mergeParts(node, k);
  const nodeParts: ({ terminal: number[] } | { child: TreeNode })[] = [];
  if (node.terminal.length)
    nodeParts.push({ terminal: node.terminal });
  for (const child of node.children.values())
    nodeParts.push({ child });
  let remaining = count;
  for (let index = nodeParts.length - 1; index >= 0; index--) {
    const given = choices[index + 1][remaining];
    remaining -= given;
    if (!given)
      continue;
    const part = nodeParts[index];
    if ('terminal' in part)
      selected.push(...part.terminal.slice(0, given));
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
