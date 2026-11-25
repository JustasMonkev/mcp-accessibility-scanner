/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { expect, it } from 'vitest';
import { representativeUrlsFixtures } from '../bench/all-utils-fixtures.mjs';

type Node = { depth: number, children: Map<string, Node>, terminal: number[], size: number, best: number[] };
type Part = { kind: 'child', size: number, child: Node };
type Row = { run: (input?: unknown) => unknown, prepare?: () => unknown, project?: (output: unknown, input: unknown) => unknown };

// The private API of the published baseline (9ec0e20, a2dfea9): costs are
// priced one count at a time and merged as number[] rows.
function legacyBuild() {
  const newNode = (depth: number): Node => ({ depth, children: new Map(), terminal: [], size: 0, best: [] });
  const parts = (node: Node): Part[] => [...node.children.values()].map(child => ({ kind: 'child', size: child.size, child }));
  const partCost = (part: Part, count: number, missCost: number) => count ? part.child.best[count] ?? 0 : part.size * missCost;
  return {
    newNode, parts,
    templateSegments: (url: string) => [new URL(url).host],
    branchCount: (node: Node) => node.children.size,
    coveredCount: () => 1,
    solve(node: Node, k: number) {
      for (const child of node.children.values())
        child.best = new Array(Math.min(k, child.size) + 1).fill(0);
      node.best = new Array(Math.min(k, node.size) + 1).fill(0);
    },
    partCost,
    mergePart(previous: number[], part: Part, minimum: number, k: number, missCost: number) {
      expect(part.kind).toBe('child');
      return { row: previous.map(cost => cost + partCost(part, 0, missCost)), choice: new Uint16Array(previous.length) };
    },
    mergeParts(node: Node, nodeParts: Part[]) {
      expect(nodeParts).toEqual(parts(node));
      return [0];
    },
    collect(node: Node, count: number, selected: number[]) {
      selected.push(...node.terminal.slice(0, count));
    },
    selectRepresentativeUrls: (urls: string[], k: number) => urls.slice(0, k),
  };
}

it('builds representativeUrls fixtures for the published baseline API', () => {
  const build = legacyBuild();
  const rows = new Map<string, Row>();
  representativeUrlsFixtures(build, (name: string, run: Row['run'], options = {}) => rows.set(name, { run, ...options }), (inputs: Record<string, unknown[]>) => {
    for (const [name, args] of Object.entries(inputs)) {
      const helper = (build as Record<string, unknown>)[name];
      if (typeof helper === 'function')
        rows.set(name, { run: () => helper(...args) });
    }
  });

  // Every helper the build has gets a fixture, and none it lacks.
  expect([...rows.keys()].sort()).toEqual(Object.keys(build).sort());
  for (const row of rows.values()) {
    const input = row.prepare?.();
    const output = row.run(input);
    row.project?.(output, input);
  }
});
