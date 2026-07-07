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

import { describe, expect, it, vi } from 'vitest';
import type { JSONSchema7 } from 'json-schema';
import snapshotTools from '../src/tools/snapshot.js';
import { toMcpTool } from '../src/mcp/tool.js';

describe('Snapshot Tools', () => {
  const snapshotTool = snapshotTools.find(tool => tool.schema.name === 'browser_snapshot')!;
  const findTool = snapshotTools.find(tool => tool.schema.name === 'browser_find')!;

  it('should expose browser_snapshot with optional compression', () => {
    const mcpTool = toMcpTool(snapshotTool.schema);
    const jsonSchema = mcpTool.inputSchema as JSONSchema7;
    const compressSchema = jsonSchema.properties?.compress as JSONSchema7;

    expect(snapshotTool).toBeDefined();
    expect(snapshotTool.schema.type).toBe('readOnly');
    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.required ?? []).toEqual([]);
    expect(compressSchema.type).toBe('boolean');
    expect(compressSchema.description).toContain('more than 100 times');
    expect(snapshotTool.schema.inputSchema.parse({})).toEqual({});
    expect(snapshotTool.schema.inputSchema.parse({ compress: true })).toEqual({ compress: true });
    expect(snapshotTool.schema.inputSchema.parse({ compress: false })).toEqual({ compress: false });
  });

  it('should request the current snapshot flow with compression disabled by default', async () => {
    const context = {
      ensureTab: vi.fn().mockResolvedValue(undefined),
    };
    const response = {
      setIncludeSnapshot: vi.fn(),
    };

    await snapshotTool.handle(context as any, {}, response as any);

    expect(context.ensureTab).toHaveBeenCalled();
    expect(response.setIncludeSnapshot).toHaveBeenCalledWith(undefined);
  });

  it('should pass the compression option to the snapshot response', async () => {
    const context = {
      ensureTab: vi.fn().mockResolvedValue(undefined),
    };
    const response = {
      setIncludeSnapshot: vi.fn(),
    };

    await snapshotTool.handle(context as any, { compress: true }, response as any);

    expect(context.ensureTab).toHaveBeenCalled();
    expect(response.setIncludeSnapshot).toHaveBeenCalledWith(true);
  });

  it('should pass explicit compression opt-out to the snapshot response', async () => {
    const context = {
      ensureTab: vi.fn().mockResolvedValue(undefined),
    };
    const response = {
      setIncludeSnapshot: vi.fn(),
    };

    await snapshotTool.handle(context as any, { compress: false }, response as any);

    expect(context.ensureTab).toHaveBeenCalled();
    expect(response.setIncludeSnapshot).toHaveBeenCalledWith(false);
  });

  it('should expose browser_find with text and regex search options', () => {
    const mcpTool = toMcpTool(findTool.schema);
    const jsonSchema = mcpTool.inputSchema as JSONSchema7;

    expect(findTool).toBeDefined();
    expect(findTool.schema.type).toBe('readOnly');
    expect(jsonSchema.properties?.text).toBeDefined();
    expect(jsonSchema.properties?.regex).toBeDefined();
    expect(() => findTool.schema.inputSchema.parse({})).toThrow();
    expect(() => findTool.schema.inputSchema.parse({ text: 'Submit', regex: 'Submit' })).toThrow();
    expect(() => findTool.schema.inputSchema.parse({ regex: '(' })).toThrow();
    expect(() => findTool.schema.inputSchema.parse({ regex: '(?=a)a' })).toThrow();
  });

  it('should find snapshot lines by case-insensitive text', async () => {
    const context = findContext(`- heading "Groceries"\n- list:\n  - listitem: Apples\n  - listitem: Bananas\n  - listitem: Cherries`);
    const response = findResponse();

    await findTool.handle(context as any, { text: 'bananas' }, response as any);

    expect(response.addResult).toHaveBeenCalledWith(expect.stringContaining('Found 1 match for "bananas":'));
    expect(response.addResult).toHaveBeenCalledWith(expect.stringContaining('Apples'));
    expect(response.addResult).toHaveBeenCalledWith(expect.stringContaining('Cherries'));
  });

  it('should find snapshot lines by regex with flags', async () => {
    const context = findContext(`- heading "Groceries"\n- listitem: Apples\n- listitem: Bananas`);
    const response = findResponse();

    await findTool.handle(context as any, { regex: '/apples/i' }, response as any);

    expect(response.addResult).toHaveBeenCalledWith(expect.stringContaining('Found 1 match for /apples/i:'));
  });

  it('should merge overlapping browser_find context windows', async () => {
    const context = findContext(['- text "Alpha"', '- text "One"', '- text "Two"', '- text "Beta"'].join('\n'));
    const response = findResponse();

    await findTool.handle(context as any, { regex: '/Alpha|Beta/' }, response as any);

    expect(response.addResult).toHaveBeenCalledWith(expect.stringContaining('Found 2 matches for /Alpha|Beta/:'));
    expect(response.addResult).not.toHaveBeenCalledWith(expect.stringContaining('----'));
  });

  it('should show browser_find matches under their path from the root', async () => {
    const context = findContext([
      '- main [ref=e1]:',
      '  - region "Sidebar" [ref=e2]:',
      '    - navigation "Primary" [ref=e3]:',
      '      - list [ref=e4]:',
      '        - listitem [ref=e5]:',
      '          - link "Home" [ref=e6]',
      '        - listitem [ref=e7]:',
      '          - link "Products" [ref=e8]',
      '        - listitem [ref=e9]:',
      '          - link "About" [ref=e10]',
      '        - listitem [ref=e11]:',
      '          - link "Contact" [ref=e12]',
      '        - listitem [ref=e13]:',
      '          - link "Careers" [ref=e14]',
      '        - listitem [ref=e15]:',
      '          - link "Deep Target Link" [ref=e16]',
    ].join('\n'));
    const response = findResponse();

    await findTool.handle(context as any, { text: 'Deep Target Link' }, response as any);

    expect(response.addResult).toHaveBeenCalledWith(expect.stringContaining([
      'Found 1 match for "Deep Target Link":',
      '',
      '- main [ref=e1]:',
      '  - region "Sidebar" [ref=e2]:',
      '    - navigation "Primary" [ref=e3]:',
      '      - list [ref=e4]:',
      '        - listitem [ref=e13]:',
      '          - link "Careers" [ref=e14]',
      '        - listitem [ref=e15]:',
      '          - link "Deep Target Link" [ref=e16]',
    ].join('\n')));
  });

  it('should mark gaps inside off-path browser_find context', async () => {
    const context = findContext([
      '- main [ref=e1]:',
      '  - group "Toolbar" [ref=e2]:',
      '    - button "One" [ref=e3]',
      '    - button "Two" [ref=e4]',
      '    - button "Three" [ref=e5]',
      '    - button "Four" [ref=e6]',
      '  - group "Content" [ref=e7]:',
      '    - button "Target Button" [ref=e8]',
    ].join('\n'));
    const response = findResponse();

    await findTool.handle(context as any, { text: 'Target Button' }, response as any);

    expect(response.addResult).toHaveBeenCalledWith(expect.stringContaining([
      '- main [ref=e1]:',
      '  - group "Toolbar" [ref=e2]:',
      '    ...',
      '    - button "Three" [ref=e5]',
      '    - button "Four" [ref=e6]',
      '  - group "Content" [ref=e7]:',
      '    - button "Target Button" [ref=e8]',
    ].join('\n')));
  });

  it('should keep broad deep browser_find queries near-linear', async () => {
    const lines = [];
    for (let i = 0; i < 3000; i++)
      lines.push(`${'  '.repeat(i)}- group "Target ${i}":`);
    const context = findContext(lines.join('\n'));
    const response = findResponse();

    const start = performance.now();
    await findTool.handle(context as any, { text: 'Target' }, response as any);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(1500);
    expect(response.addResult).toHaveBeenCalledWith(expect.stringContaining('Found 3000 matches for "Target":'));
  });

  it('should report when browser_find has no matches', async () => {
    const context = findContext('- button "Submit"');
    const response = findResponse();

    await findTool.handle(context as any, { text: 'Cancel' }, response as any);

    expect(response.addResult).toHaveBeenCalledWith('No matches found for "Cancel".');
  });

  it('should truncate data URLs in browser_find snippets', async () => {
    const payload = '<svg viewBox="0 0 10 10"><text>Hello</text></svg>';
    const context = findContext(`- link "Logo" [ref=e1]:\n  - /url: data:image/svg+xml,${payload}\n- button "Next" [ref=e2]`);
    const response = findResponse();

    await findTool.handle(context as any, { text: 'Logo' }, response as any);

    expect(response.addResult).toHaveBeenCalledWith(expect.stringContaining('data:image/svg+xml,...'));
    expect(response.addResult).not.toHaveBeenCalledWith(expect.stringContaining(payload));
  });

  it('should report browser_find argument errors', async () => {
    const context = findContext('- button "Submit"');
    const response = findResponse();

    await findTool.handle(context as any, {}, response as any);
    await findTool.handle(context as any, { text: 'Submit', regex: 'Submit' }, response as any);

    expect(response.addError).toHaveBeenCalledWith('Provide either "text" or "regex" to search for.');
    expect(response.addError).toHaveBeenCalledWith('Provide only one of "text" or "regex", not both.');
  });
});

function findContext(snapshot: string) {
  const tab = {
    modalStates: vi.fn().mockReturnValue([]),
    page: {
      ariaSnapshot: vi.fn().mockResolvedValue(snapshot),
    },
  };
  return {
    currentTabOrDie: vi.fn().mockReturnValue(tab),
  };
}

function findResponse() {
  return {
    addResult: vi.fn(),
    addError: vi.fn(),
  };
}
