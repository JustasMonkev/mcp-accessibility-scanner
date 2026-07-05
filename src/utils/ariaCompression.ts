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
const HAS_CURSOR_POINTER = /\[cursor=pointer\]/;
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

type SnapshotLine = {
  text: string;
  indent: number;
  parentIndex: number;
  role: string | undefined;
  hasRef: boolean;
  hasCursorPointer: boolean;
  signature: string;
  selfHasProtectedLineRole: boolean;
  containsProtectedSubtreeRole: boolean;
  selfHasProtectedSubtreeRole: boolean;
  insideProtectedSubtree: boolean;
  hasRowContainerAncestor: boolean;
};

export type CompressResult = {
  output: string;
  removed: number;
};

export function compressAriaSnapshot(yaml: string): CompressResult {
  const lines = parseSnapshotLines(yaml);
  const preCounts = new Map<string, number>();
  for (const line of lines) {
    if (!line.text.trim() || isProtectedLine(line))
      continue;
    const key = compressionKey(line);
    preCounts.set(key, (preCounts.get(key) ?? 0) + 1);
  }

  let maxCount = 0;
  for (const value of preCounts.values())
    maxCount = Math.max(maxCount, value);

  if (maxCount <= FIRE_THRESHOLD)
    return { output: yaml, removed: 0 };

  const sigCounts = new Map<string, number>();
  const output: string[] = [];
  let totalRemoved = 0;
  let skipBelowIndent: number | undefined;

  for (const line of lines) {
    if (!line.text.trim()) {
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

    if (isProtectedLine(line)) {
      output.push(line.text);
      continue;
    }

    const key = compressionKey(line);
    const lineCount = (sigCounts.get(key) ?? 0) + 1;
    sigCounts.set(key, lineCount);

    if (lineCount > KEEP_N && (preCounts.get(key) ?? 0) > FIRE_THRESHOLD) {
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

function parseSnapshotLines(yaml: string): SnapshotLine[] {
  const lines = yaml.split('\n').map((text): SnapshotLine => {
    const role = roleOf(text);
    const hasRef = HAS_REF.test(text);
    const hasCursorPointer = HAS_CURSOR_POINTER.test(text);
    return {
      text,
      indent: indentOf(text),
      parentIndex: -1,
      role,
      hasRef,
      hasCursorPointer,
      signature: signature(text),
      selfHasProtectedLineRole: shouldKeepLine(role, hasRef, hasCursorPointer),
      containsProtectedSubtreeRole: shouldKeepSubtree(role) || shouldKeepRefProtectedDescendants(role, hasRef) || shouldKeepCursorPointerRef(hasRef, hasCursorPointer),
      selfHasProtectedSubtreeRole: shouldKeepSubtree(role) || shouldKeepRefProtectedDescendants(role, hasRef) || shouldKeepCursorPointerRef(hasRef, hasCursorPointer),
      insideProtectedSubtree: false,
      hasRowContainerAncestor: false,
    };
  });

  const stack: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.text.trim())
      continue;

    while (stack.length && lines[stack[stack.length - 1]].indent >= line.indent)
      stack.pop();

    line.parentIndex = stack[stack.length - 1] ?? -1;
    const parent = line.parentIndex === -1 ? undefined : lines[line.parentIndex];
    line.hasRowContainerAncestor = parent !== undefined && (parent.hasRowContainerAncestor || isRowContainerRole(parent.role));
    stack.push(index);
  }

  for (const line of lines) {
    if (line.role === 'row' && line.hasRef && line.hasRowContainerAncestor) {
      line.selfHasProtectedLineRole = true;
      line.containsProtectedSubtreeRole = true;
      line.selfHasProtectedSubtreeRole = true;
    }
  }

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line.containsProtectedSubtreeRole || line.parentIndex === -1)
      continue;
    lines[line.parentIndex].containsProtectedSubtreeRole = true;
  }

  let protectedIndent: number | undefined;
  for (const line of lines) {
    if (!line.text.trim())
      continue;

    if (protectedIndent !== undefined && line.indent <= protectedIndent)
      protectedIndent = undefined;

    const insideProtectedSubtree = protectedIndent !== undefined;
    if (insideProtectedSubtree)
      line.insideProtectedSubtree = true;

    if (!insideProtectedSubtree && line.selfHasProtectedSubtreeRole)
      protectedIndent = line.indent;
  }

  return lines;
}

function isProtectedLine(line: SnapshotLine): boolean {
  return line.selfHasProtectedLineRole || line.containsProtectedSubtreeRole || line.insideProtectedSubtree;
}

function compressionKey(line: SnapshotLine): string {
  return `${line.parentIndex}:${line.indent}:${line.signature}`;
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

function shouldKeepLine(role: string | undefined, hasRef: boolean, hasCursorPointer: boolean): boolean {
  if (shouldKeepCursorPointerRef(hasRef, hasCursorPointer))
    return true;
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

function shouldKeepCursorPointerRef(hasRef: boolean, hasCursorPointer: boolean): boolean {
  return hasRef && hasCursorPointer;
}

const ROW_CONTAINER_ROLES = new Set(['grid', 'treegrid']);

function isRowContainerRole(role: string | undefined): boolean {
  return role !== undefined && ROW_CONTAINER_ROLES.has(role);
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}
