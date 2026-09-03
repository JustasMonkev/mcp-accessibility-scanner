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
import { z } from 'zod';
import { defineTabTool } from './tool.js';

import type { FullConfig } from '../config.js';

// setFiles() reads the given local paths into the page's upload, so with no
// restriction a rogue client can push arbitrary local files (e.g. ~/.ssh/)
// to whatever origin the page posts to. An configured allowlist confines
// uploads to operator-chosen directories; unset keeps the historical
// any-path behavior.
function assertUploadPathsAllowed(config: FullConfig, paths: string[]): void {
  const allowedDirs = config.browser.allowedUploadDirs;
  // Unset keeps the historical any-path behavior; an explicitly empty list
  // allows nothing, so it can never silently widen back to "any path".
  if (allowedDirs === undefined)
    return;
  const resolvedRoots = allowedDirs.map(dir => path.resolve(dir));
  const withinAllowed = (target: string) => {
    const resolved = path.resolve(target);
    return resolvedRoots.some(root => {
      const relative = path.relative(root, resolved);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
  };
  const rejected = paths.filter(target => !withinAllowed(target));
  if (rejected.length)
    throw new Error(`Upload path(s) outside the allowed upload directories (${allowedDirs.join('; ')}): ${rejected.join('; ')}. Restart with --allowed-upload-dirs covering them, or pick files inside the allowed directories.`);
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

    assertUploadPathsAllowed(tab.context.config, params.paths);

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
];
