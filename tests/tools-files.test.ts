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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fileTools from '../src/tools/files.js';
import { Response } from '../src/response.js';

const dropTool = fileTools.find(tool => tool.schema.name === 'browser_drop')!;

describe('browser_drop tool', () => {
  let context: any;
  let locator: any;
  let response: Response;
  let rootDir: string;
  let tab: any;

  beforeEach(async () => {
    rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-drop-'));
    rootDir = await fs.promises.realpath(rootDir);
    await Promise.all([
      fs.promises.writeFile(path.join(rootDir, 'a.txt'), 'a'),
      fs.promises.writeFile(path.join(rootDir, 'b.txt'), 'b'),
    ]);
    locator = {
      drop: vi.fn().mockResolvedValue(undefined),
      normalize: vi.fn().mockResolvedValue({ toString: () => `locator('#dropzone')` }),
    };
    tab = {
      modalStates: vi.fn().mockReturnValue([]),
      refLocator: vi.fn().mockResolvedValue(locator),
      waitForCompletion: vi.fn(async (callback: () => Promise<void>) => callback()),
    };
    context = {
      currentTabOrDie: vi.fn().mockReturnValue(tab),
      config: {},
      options: { clientInfo: { rootPath: rootDir } },
    };
    tab.context = context;
    response = new Response(context, 'browser_drop', {});
  });

  afterEach(async () => {
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  });

  it('should expose a destructive core tool with paths and data inputs', () => {
    expect(dropTool).toBeDefined();
    expect(dropTool.capability).toBe('core');
    expect(dropTool.schema.type).toBe('destructive');
    expect(dropTool.schema.inputSchema.parse({
      element: 'Drop target',
      ref: 'e1',
      data: { 'text/plain': 'hello' },
    })).toEqual({
      element: 'Drop target',
      ref: 'e1',
      data: { 'text/plain': 'hello' },
    });
    expect(() => dropTool.schema.inputSchema.parse({ element: 'Drop target', ref: 'e1' })).toThrow();
    expect(() => dropTool.schema.inputSchema.parse({ element: 'Drop target', ref: 'e1', paths: [], data: {} })).toThrow();
  });

  it('should reject an empty payload when called directly', async () => {
    await dropTool.handle(context, { element: 'Drop target', ref: 'e1' } as any, response);

    expect(response.isError()).toBe(true);
    expect(response.result()).toContain('At least one of "paths" or "data" must be provided');
    expect(tab.refLocator).not.toHaveBeenCalled();
    expect(locator.drop).not.toHaveBeenCalled();
  });

  it('should drop MIME-typed data onto the target', async () => {
    await dropTool.handle(context, {
      element: 'Drop target',
      ref: 'e1',
      data: { 'text/plain': 'hello', 'text/uri-list': 'https://example.com' },
    }, response);

    expect(tab.refLocator).toHaveBeenCalledWith({
      element: 'Drop target',
      ref: 'e1',
      data: { 'text/plain': 'hello', 'text/uri-list': 'https://example.com' },
    });
    expect(locator.drop).toHaveBeenCalledWith({
      data: { 'text/plain': 'hello', 'text/uri-list': 'https://example.com' },
    });
    expect(response.code()).toContain(`await page.locator('#dropzone').drop(`);
    expect(response.code()).toContain(`'text/plain': 'hello'`);
    expect(response.code()).toContain(`'text/uri-list': 'https://example.com'`);
  });

  it('should pass one file path as a string', async () => {
    await dropTool.handle(context, {
      element: 'Drop target',
      ref: 'e1',
      paths: [path.join(rootDir, 'a.txt')],
    }, response);

    expect(locator.drop).toHaveBeenCalledWith({ files: path.join(rootDir, 'a.txt') });
    expect(response.code()).toContain(`files: '${path.join(rootDir, 'a.txt')}'`);
  });

  it('should pass multiple file paths as an array', async () => {
    await dropTool.handle(context, {
      element: 'Drop target',
      ref: 'e1',
      paths: [path.join(rootDir, 'a.txt'), path.join(rootDir, 'b.txt')],
    }, response);

    expect(locator.drop).toHaveBeenCalledWith({ files: [path.join(rootDir, 'a.txt'), path.join(rootDir, 'b.txt')] });
  });

  it('should reject file paths outside the client root', async () => {
    const outsideDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-drop-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    await fs.promises.writeFile(outsideFile, 'secret');

    try {
      await expect(dropTool.handle(context, {
        element: 'Drop target',
        ref: 'e1',
        paths: [outsideFile],
      }, response)).rejects.toThrow('outside the client filesystem root');
      expect(locator.drop).not.toHaveBeenCalled();
    } finally {
      await fs.promises.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('should include a post-action snapshot', async () => {
    const setIncludeSnapshot = vi.spyOn(response, 'setIncludeSnapshot');

    await dropTool.handle(context, {
      element: 'Drop target',
      ref: 'e1',
      data: { 'text/plain': 'hello' },
    }, response);

    expect(setIncludeSnapshot).toHaveBeenCalledTimes(1);
    expect(tab.waitForCompletion).toHaveBeenCalledTimes(1);
  });
});
