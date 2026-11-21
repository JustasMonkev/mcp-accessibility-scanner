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

const FIRE_THRESHOLD = 100;
const KEEP_N = 10;

const KEEP_REF_ALL = /\[ref=[^\]]+\]/g;
const HAS_REF = /\[ref=[^\]]+\]/;
const ROLE_PREFIX_RE = /^\s*-\s*([a-z][a-z0-9-]*)\b/i;
const PROTECTED_LINE_ROLES = new Set([
  'alert',
  'banner',
  'button',
  'checkbox',
  'columnheader',
  'combobox',
  'dialog',
  'form',
  'grid',
  'gridcell',
  'heading',
  'input',
  'link',
  'listbox',
  'main',
  'menu',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'navigation',
  'option',
  'radio',
  'rowheader',
  'search',
  'searchbox',
  'select',
  'slider',
  'spinbutton',
  'status',
  'switch',
  'tab',
  'textbox',
  'tree',
  'treegrid',
  'treeitem',
  'region',
]);
const REF_PROTECTED_LINE_ROLES = new Set([
  'grid',
  'gridcell',
  'scrollbar',
  'separator',
  'treegrid',
]);
const REF_PROTECTED_DESCENDANT_ROLES = new Set([
  'columnheader',
  'gridcell',
  'rowheader',
  'scrollbar',
  'separator',
]);
const PROTECTED_SUBTREE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'input',
  'link',
  'listbox',
  'menu',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'select',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'tree',
  'treeitem',
]);

type CompressionGroup = { total: number, seen: number };

type SnapshotLine = {
  text: string;
  indent: number;
  parentIndex: number;
  group: CompressionGroup | undefined;
  protectedLine: boolean;
  protectedSubtree: boolean;
  containsProtectedSubtree: boolean;
  underRowContainer: boolean;
};

export type CompressResult = {
  output: string;
  removed: number;
};

export function compressAriaSnapshot(yaml: string): CompressResult {
  let newline = -1;
  for (let count = 0; count < FIRE_THRESHOLD; count++) {
    newline = yaml.indexOf('\n', newline + 1);
    if (newline === -1)
      return { output: yaml, removed: 0 };
  }
  if (!hasCrowdedParent(yaml))
    return { output: yaml, removed: 0 };
  const lines = parseSnapshotLines(yaml);
  const candidates = new Uint32Array(lines.length + 1);
  let crowded = false;
  for (const line of lines) {
    if (isCandidate(line) && ++candidates[line.parentIndex + 1] > FIRE_THRESHOLD)
      crowded = true;
  }
  if (!crowded)
    return { output: yaml, removed: 0 };

  const groups = new Map<string, CompressionGroup>();
  let maxCount = 0;
  for (const line of lines) {
    if (!isCandidate(line) || candidates[line.parentIndex + 1] <= FIRE_THRESHOLD)
      continue;
    const key = `${line.parentIndex}:${line.indent}:${signature(line.text)}`;
    let group = groups.get(key);
    if (!group) {
      group = { total: 0, seen: 0 };
      groups.set(key, group);
    }
    line.group = group;
    maxCount = Math.max(maxCount, ++group.total);
  }

  if (maxCount <= FIRE_THRESHOLD)
    return { output: yaml, removed: 0 };

  const output: string[] = [];
  let totalRemoved = 0;
  let skipBelowIndent: number | undefined;

  for (const line of lines) {
    if (line.indent === line.text.length) {
      if (skipBelowIndent === undefined)
        output.push(line.text);
      else
        totalRemoved++;
      continue;
    }

    if (skipBelowIndent !== undefined && line.indent <= skipBelowIndent)
      skipBelowIndent = undefined;

    if (skipBelowIndent !== undefined) {
      totalRemoved++;
      continue;
    }

    const group = line.group;
    if (!group) {
      output.push(line.text);
      continue;
    }

    if (group.total > FIRE_THRESHOLD && ++group.seen > KEEP_N) {
      totalRemoved++;
      skipBelowIndent = line.indent;
    } else {
      output.push(line.text);
    }
  }

  if (totalRemoved === 0)
    return { output: yaml, removed: 0 };

  const note = `\n# playwright-compress: ${totalRemoved} repeated ARIA nodes collapsed - use browser_evaluate() to enumerate the full list`;
  return { output: output.join('\n') + note, removed: totalRemoved };
}

function hasCrowdedParent(yaml: string): boolean {
  const indents: number[] = [];
  const stack: number[] = [];
  const children = new Map<number, number>();
  for (let start = 0; start <= yaml.length;) {
    let end = yaml.indexOf('\n', start);
    if (end === -1)
      end = yaml.length;
    let indent = start;
    while (indent < end && yaml.charCodeAt(indent) === 32)
      indent++;
    indent -= start;
    if (start + indent < end) {
      const code = yaml.charCodeAt(start + indent);
      if (code <= 32 || code >= 0x80)
        indent = indentOf(yaml.slice(start, end));
    }
    if (start + indent < end) {
      while (stack.length && indents[stack[stack.length - 1]] >= indent)
        stack.pop();
      const parent = stack[stack.length - 1] ?? -1;
      const count = (children.get(parent) ?? 0) + 1;
      if (count > FIRE_THRESHOLD)
        return true;
      children.set(parent, count);
      stack.push(indents.length);
    }
    indents.push(indent);
    start = end + 1;
  }
  return false;
}

function parseSnapshotLines(yaml: string): SnapshotLine[] {
  const lines: SnapshotLine[] = [];
  const stack: number[] = [];
  for (const text of yaml.split('\n')) {
    const indent = indentOf(text);
    const blank = indent === text.length;
    if (!blank) {
      while (stack.length && lines[stack[stack.length - 1]].indent >= indent)
        stack.pop();
    }
    const parentIndex = stack[stack.length - 1] ?? -1;
    const parent = lines[parentIndex];
    const role = roleOf(text);
    const hasRef = text.includes('[ref=') && HAS_REF.test(text);
    const hasCursorPointer = hasRef && text.includes('[cursor=pointer]');
    const protectedRow = role === 'row' && hasRef && !!parent?.underRowContainer;
    const protectedSubtree = !!parent?.protectedSubtree || protectedRow || shouldKeepSubtree(role) ||
        shouldKeepRefProtectedDescendants(role, hasRef) || hasCursorPointer;
    if (!blank)
      stack.push(lines.length);
    lines.push({
      text, indent, parentIndex, protectedSubtree, group: undefined,
      protectedLine: shouldKeepLine(role, hasRef),
      containsProtectedSubtree: protectedSubtree,
      underRowContainer: !!parent?.underRowContainer || isRowContainerRole(role),
    });
  }

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line.containsProtectedSubtree && line.parentIndex !== -1)
      lines[line.parentIndex].containsProtectedSubtree = true;
  }
  return lines;
}

function isCandidate(line: SnapshotLine): boolean {
  return line.indent !== line.text.length && !line.protectedLine && !line.containsProtectedSubtree;
}

function signature(line: string): string {
  let result = line.trimEnd().replace(KEEP_REF_ALL, '[ref=?]');
  result = result.replace(/"[^"]*"/g, '""');
  result = result.replace(/'[^']*'/g, "''");
  result = result.replace(/\b\d+\b/g, 'N');
  return result.trimStart().slice(0, 80);
}

function roleOf(line: string): string | undefined {
  return ROLE_PREFIX_RE.exec(line)?.[1]?.toLowerCase();
}

function shouldKeepLine(role: string | undefined, hasRef: boolean): boolean {
  if (role === undefined)
    return false;
  return PROTECTED_LINE_ROLES.has(role) || hasRef && REF_PROTECTED_LINE_ROLES.has(role);
}

function shouldKeepSubtree(role: string | undefined): boolean {
  return role !== undefined && PROTECTED_SUBTREE_ROLES.has(role);
}

function shouldKeepRefProtectedDescendants(role: string | undefined, hasRef: boolean): boolean {
  return role !== undefined && hasRef && REF_PROTECTED_DESCENDANT_ROLES.has(role);
}

const ROW_CONTAINER_ROLES = new Set(['grid', 'treegrid']);

function isRowContainerRole(role: string | undefined): boolean {
  return role !== undefined && ROW_CONTAINER_ROLES.has(role);
}

function indentOf(line: string): number {
  let index = 0;
  while (index < line.length && line.charCodeAt(index) === 32)
    index++;
  if (index < line.length && (line.charCodeAt(index) <= 32 || line.charCodeAt(index) >= 0x80))
    return line.length - line.trimStart().length;
  return index;
}
