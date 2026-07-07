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

describe('browser_drop tool', () => {
  const dropTool = snapshotTools.find(tool => tool.schema.name === 'browser_drop')!;

  function dropSetup() {
    const locator = {
      drop: vi.fn().mockResolvedValue(undefined),
      normalize: async () => ({ toString: () => `locator('#drop')` }),
    };
    const tab = {
      modalStates: vi.fn().mockReturnValue([]),
      refLocator: vi.fn().mockResolvedValue(locator),
      waitForCompletion: vi.fn(async (callback: () => Promise<void>) => {
        await callback();
      }),
    };
    const context = { currentTabOrDie: vi.fn().mockReturnValue(tab) };
    const response = {
      setIncludeSnapshot: vi.fn(),
      addError: vi.fn(),
      addCode: vi.fn(),
    };
    return { context, tab, locator, response };
  }

  it('should exist as a destructive core tool', () => {
    expect(dropTool).toBeDefined();
    expect(dropTool.schema.type).toBe('destructive');
    expect(dropTool.capability).toBe('core');
  });

  it('should error when neither paths nor data is provided', async () => {
    const { context, tab, response } = dropSetup();

    await dropTool.handle(context as any, { element: 'zone', ref: 'e1' } as any, response as any);

    expect(response.addError).toHaveBeenCalledWith('At least one of "paths" or "data" must be provided.');
    expect(tab.refLocator).not.toHaveBeenCalled();
  });

  it('should drop MIME-typed data onto the element', async () => {
    const { context, locator, response } = dropSetup();

    await dropTool.handle(
        context as any,
        { element: 'zone', ref: 'e1', data: { 'text/plain': 'hello' } } as any,
        response as any
    );

    expect(response.setIncludeSnapshot).toHaveBeenCalled();
    expect(locator.drop).toHaveBeenCalledWith({ data: { 'text/plain': 'hello' } });
    expect(response.addCode).toHaveBeenCalledWith(expect.stringContaining('.drop('));
  });

  it('should pass a single file path as a string', async () => {
    const { context, locator, response } = dropSetup();

    await dropTool.handle(
        context as any,
        { element: 'zone', ref: 'e1', paths: ['/tmp/a.txt'] } as any,
        response as any
    );

    expect(locator.drop).toHaveBeenCalledWith({ files: '/tmp/a.txt' });
  });

  it('should pass multiple file paths as an array', async () => {
    const { context, locator, response } = dropSetup();

    await dropTool.handle(
        context as any,
        { element: 'zone', ref: 'e1', paths: ['/tmp/a.txt', '/tmp/b.txt'] } as any,
        response as any
    );

    expect(locator.drop).toHaveBeenCalledWith({ files: ['/tmp/a.txt', '/tmp/b.txt'] });
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
