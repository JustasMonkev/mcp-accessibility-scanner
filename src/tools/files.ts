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

import path from 'node:path';
import fs from 'node:fs';
import coreBundle from 'playwright-core/lib/coreBundle';
import { z } from 'zod';
import { defineTabTool } from './tool.js';
import { waitForCompletion as waitForCompletionEvenWithModalOpen } from './utils.js';

import type { FullConfig } from '../config.js';

type UploadPayload = { name: string; mimeType: string; buffer: Buffer };

const maxRestrictedUploadBytes = 50 * 1024 * 1024;
const darwinNoFollowAnyComponent = 0x20000000;

export async function prepareUploadFiles(config: FullConfig, paths: string[]) {
  const allowedDirs = config.browser.allowedUploadDirs;
  if (allowedDirs === undefined || !paths.length)
    return paths;
  if (!allowedDirs.length)
    throw outsideAllowedDirsError();
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Error('Restricted file uploads and drops require macOS or Linux with /proc/self/fd.');
  const payloads: UploadPayload[] = [];
  const budget = { remainingBytes: maxRestrictedUploadBytes };
  for (const target of paths) {
    const canonical = await fs.promises.realpath(target);
    if (!allowedDirs.some(root => isInsideDirectory(root, canonical)))
      throw outsideAllowedDirsError();
    payloads.push({
      name: path.basename(target),
      mimeType: coreBundle.iso.getMimeTypeForPath(target) ?? 'application/octet-stream',
      buffer: await readStableRegularFile(canonical, budget),
    });
  }
  return payloads;
}

function outsideAllowedDirsError(): Error {
  return new Error('Upload path(s) outside the allowed upload directories.');
}

function notRegularFileError(): Error {
  return new Error('Restricted uploads require regular files, not directories or devices.');
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function readStableRegularFile(canonical: string, budget: { remainingBytes: number }): Promise<Buffer> {
  const before = await fs.promises.stat(canonical);
  if (!before.isFile())
    throw notRegularFileError();
  const noFollow = process.platform === 'darwin' ? darwinNoFollowAnyComponent : fs.constants.O_NOFOLLOW;
  const handle = await fs.promises.open(canonical, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile())
      throw notRegularFileError();
    const sameInode = opened.dev === before.dev && opened.ino === before.ino;
    if (!sameInode || !await descriptorStillPointsAt(handle.fd, canonical))
      throw new Error('Upload file changed during validation. Retry with a stable file.');
    const chunks: Buffer[] = [];
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      budget.remainingBytes -= chunk.length;
      if (budget.remainingBytes < 0)
        throw new Error('Restricted uploads exceed the 50 MiB total limit.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

async function descriptorStillPointsAt(fd: number, canonical: string): Promise<boolean> {
  if (process.platform !== 'linux')
    return true;
  return await fs.promises.readlink(`/proc/self/fd/${fd}`) === canonical;
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

    const files = await prepareUploadFiles(tab.context.config, params.paths);

    response.addCode(`await fileChooser.setFiles(${JSON.stringify(params.paths)})`);

    await waitForCompletionEvenWithModalOpen(tab, async () => {
      await modalState.fileChooser.setFiles(files);
      tab.clearModalState(modalState);
    });
  },
  clearsModalState: 'fileChooser',
});

export default [
  uploadFile,
];
