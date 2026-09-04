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

import type { FullConfig } from '../config.js';

async function prepareUploadFiles(config: FullConfig, paths: string[]) {
  const allowedDirs = config.browser.allowedUploadDirs;
  if (allowedDirs === undefined || !paths.length)
    return paths;
  const rejected = () => new Error('Upload path(s) outside the allowed upload directories.');
  if (!allowedDirs.length)
    throw rejected();
  const roots = await Promise.all(allowedDirs.map(dir => fs.promises.realpath(dir)));
  const payloads: { name: string; mimeType: string; buffer: Buffer }[] = [];
  let totalBytes = 0;
  for (const target of paths) {
    const canonical = await fs.promises.realpath(target);
    if (!roots.some(root => {
      const relative = path.relative(root, canonical);
      return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    }))
      throw rejected();
    const before = await fs.promises.stat(canonical);
    if (!before.isFile())
      throw new Error('Restricted uploads require regular files, not directories or devices.');
    const handle = await fs.promises.open(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino || await fs.promises.realpath(canonical) !== canonical)
        throw new Error('Upload file changed during validation. Retry with a stable file.');
      const checked = await fs.promises.stat(canonical);
      if (opened.dev !== checked.dev || opened.ino !== checked.ino)
        throw new Error('Upload file changed during validation. Retry with a stable file.');
      // Read the checked descriptor; setFiles must never reopen an attacker-replaceable path.
      const chunks: Buffer[] = [];
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        totalBytes += chunk.length;
        if (totalBytes > 50 * 1024 * 1024)
          throw new Error('Restricted uploads exceed the 50 MiB total limit.');
        chunks.push(chunk);
      }
      payloads.push({ name: path.basename(target), mimeType: coreBundle.iso.getMimeTypeForPath(target), buffer: Buffer.concat(chunks) });
    } finally {
      await handle.close();
    }
  }
  return payloads;
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

    tab.clearModalState(modalState);
    await tab.waitForCompletion(async () => {
      await modalState.fileChooser.setFiles(files);
    });
  },
  clearsModalState: 'fileChooser',
});

export default [
  uploadFile,
];
