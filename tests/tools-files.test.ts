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

import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import uploadFileTools from '../src/tools/files.js';

const uploadFile = uploadFileTools.find(entry => entry.schema.name === 'browser_file_upload')!;

function createHarness(allowedUploadDirs?: string[]) {
  const setFiles = vi.fn(async () => undefined);
  const modalState = { type: 'fileChooser', fileChooser: { setFiles } };
  const context = {
    currentTabOrDie: vi.fn(),
    config: { browser: { allowedUploadDirs } },
  };
  const tab = {
    modalStates: vi.fn(() => [modalState]),
    clearModalState: vi.fn(),
    waitForCompletion: vi.fn(async (action: () => Promise<void>) => action()),
    context,
  };
  context.currentTabOrDie.mockReturnValue(tab);
  const response = {
    setIncludeSnapshot: vi.fn(),
    addCode: vi.fn(),
  };
  return { context, response, setFiles, tab };
}

describe('browser_file_upload allowedUploadDirs', () => {
  it('allows any path when no allowlist is configured', async () => {
    const { context, response, setFiles } = createHarness(undefined);

    await uploadFile.handle(context as any, { paths: ['/etc/passwd'] }, response as any);

    expect(setFiles).toHaveBeenCalledWith(['/etc/passwd']);
  });

  it('allows paths inside a configured directory', async () => {
    const dir = os.tmpdir();
    const { context, response, setFiles } = createHarness([dir]);
    const inside = path.join(dir, 'upload.txt');

    await uploadFile.handle(context as any, { paths: [inside] }, response as any);

    expect(setFiles).toHaveBeenCalledWith([inside]);
  });

  it('rejects paths outside the configured directories before touching the file chooser', async () => {
    const { context, response, setFiles, tab } = createHarness([path.join(os.tmpdir(), 'uploads')]);

    await expect(uploadFile.handle(context as any, { paths: ['~/.ssh/id_rsa', '/etc/passwd'] }, response as any))
        .rejects.toThrow(/outside the allowed upload directories/);

    expect(setFiles).not.toHaveBeenCalled();
    expect(tab.clearModalState).not.toHaveBeenCalled();
  });

  it('rejects traversal that escapes the configured directory', async () => {
    const dir = path.join(os.tmpdir(), 'uploads');
    const { context, response, setFiles } = createHarness([dir]);
    const escaping = path.join(dir, '..', '..', 'etc', 'passwd');

    await expect(uploadFile.handle(context as any, { paths: [escaping] }, response as any))
        .rejects.toThrow(/outside the allowed upload directories/);

    expect(setFiles).not.toHaveBeenCalled();
  });

  it('accepts every path only when each is inside some allowed directory', async () => {
    const first = path.join(os.tmpdir(), 'uploads-a');
    const second = path.join(os.tmpdir(), 'uploads-b');
    const { context, response, setFiles } = createHarness([first, second]);

    await expect(uploadFile.handle(context as any, { paths: [path.join(first, 'a.txt'), path.join(second, 'b.txt')] }, response as any))
        .resolves.toBeUndefined();
    expect(setFiles).toHaveBeenCalledTimes(1);

    await expect(uploadFile.handle(context as any, { paths: [path.join(first, 'a.txt'), '/etc/passwd'] }, response as any))
        .rejects.toThrow(/outside the allowed upload directories/);
  });

  it('rejects every path when the allowlist is explicitly empty', async () => {
    const { context, response, setFiles } = createHarness([]);

    await expect(uploadFile.handle(context as any, { paths: [path.join(os.tmpdir(), 'x.txt')] }, response as any))
        .rejects.toThrow(/outside the allowed upload directories/);

    expect(setFiles).not.toHaveBeenCalled();
  });
});
