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
import path from 'node:path';
import { z } from 'zod';

import * as javascript from '../utils/codegen.js';
import { defineTabTool } from './tool.js';
import { elementSchema } from './snapshot.js';
import { generateLocator } from './utils.js';

import type { Tab } from '../tab.js';

const dropSchema = elementSchema.extend({
  paths: z.array(z.string().min(1).refine(filePath => path.isAbsolute(filePath), { message: 'Drop file paths must be absolute.' })).optional().describe('Absolute paths to files to drop onto the element.'),
  data: z.record(z.string(), z.string()).optional().describe('Data to drop, as a map of MIME type to string value (e.g. {"text/plain": "hello", "text/uri-list": "https://example.com"}).'),
}).superRefine((params, context) => {
  if (!params.paths?.length && !Object.keys(params.data ?? {}).length)
    context.addIssue({ code: 'custom', message: 'At least one of "paths" or "data" must be provided' });
});

const drop = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_drop',
    title: 'Drop files or data onto an element',
    description: 'Drop files or MIME-typed data onto an element, as if dragged from outside the page. At least one of "paths" or "data" must be provided.',
    inputSchema: dropSchema,
    type: 'destructive',
  },

  handle: async (tab, params, response) => {
    if (!params.paths?.length && !Object.keys(params.data ?? {}).length) {
      response.addError('At least one of "paths" or "data" must be provided');
      return;
    }

    response.setIncludeSnapshot();

    const locator = await tab.refLocator(params);
    const resolvedPaths = params.paths?.length ? await resolveDropPaths(tab, params.paths) : undefined;
    const payload = {
      ...(resolvedPaths?.length && { files: resolvedPaths.length === 1 ? resolvedPaths[0] : resolvedPaths }),
      ...(params.data && Object.keys(params.data).length && { data: params.data }),
    };

    response.addCode(`await page.${await generateLocator(locator)}.drop(${javascript.formatObject(payload)});`);

    await tab.waitForCompletion(async () => {
      await locator.drop(payload);
    });
  },
});

async function resolveDropPaths(tab: Tab, filePaths: string[]): Promise<string[]> {
  const configuredRoots = [
    tab.context.options.clientInfo.rootPath,
    tab.context.config.outputDir,
  ].filter((root): root is string => !!root);
  if (!configuredRoots.length)
    throw new Error('File drops require a client filesystem root or configured output directory.');

  const allowedRoots = await Promise.all(configuredRoots.map(async root => {
    const absoluteRoot = path.resolve(root);
    return await fs.promises.realpath(absoluteRoot).catch(() => absoluteRoot);
  }));

  return await Promise.all(filePaths.map(async filePath => {
    if (!path.isAbsolute(filePath))
      throw new Error(`Drop file path must be absolute: ${filePath}`);

    let resolvedPath: string;
    try {
      resolvedPath = await fs.promises.realpath(filePath);
    } catch {
      throw new Error(`Drop file does not exist: ${filePath}`);
    }
    if (!allowedRoots.some(root => isPathInside(root, resolvedPath)))
      throw new Error(`Drop file is outside the client filesystem root and output directory: ${filePath}`);
    if (!(await fs.promises.stat(resolvedPath)).isFile())
      throw new Error(`Drop path is not a file: ${filePath}`);
    return resolvedPath;
  }));
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

const uploadFile = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_file_upload',
    title: 'Upload files',
    description: 'Upload one or multiple files',
    inputSchema: z.object({
      paths: z.array(z.string()).describe('The absolute paths to the files to upload. Can be a single file or multiple files.'),
    }),
    type: 'destructive',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();

    const modalState = tab.modalStates().find(state => state.type === 'fileChooser');
    if (!modalState)
      throw new Error('No file chooser visible');

    response.addCode(`await fileChooser.setFiles(${JSON.stringify(params.paths)})`);

    tab.clearModalState(modalState);
    await tab.waitForCompletion(async () => {
      await modalState.fileChooser.setFiles(params.paths);
    });
  },
  clearsModalState: 'fileChooser',
});

export default [
  uploadFile,
  drop,
];
