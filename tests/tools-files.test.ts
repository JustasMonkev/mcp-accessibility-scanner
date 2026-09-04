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
import { describe, expect, it, vi } from 'vitest';
import uploadFileTools from '../src/tools/files.js';

const uploadFile = uploadFileTools.find(entry => entry.schema.name === 'browser_file_upload')!;

function createHarness(allowedUploadDirs?: string[], setFilesImpl: (files: unknown) => Promise<void> = async () => undefined) {
  const setFiles = vi.fn(setFilesImpl);
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
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-upload-'));
    const inside = path.join(dir, 'upload.txt');
    await fs.promises.writeFile(inside, 'upload');
    const { context, response, setFiles } = createHarness([dir]);

    try {
      await uploadFile.handle(context as any, { paths: [inside] }, response as any);

      expect(setFiles).toHaveBeenCalledTimes(1);
      // SAFETY: the restricted upload contract passes FilePayload objects to setFiles.
      const uploaded = setFiles.mock.calls[0][0] as Array<{ name: string, buffer: Uint8Array }>;
      expect(uploaded[0].name).toBe('upload.txt');
      expect(Buffer.from(uploaded[0].buffer).toString()).toBe('upload');
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['upload', 'upload.unknown-extension'])('uploads %s with a fallback MIME type', async name => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-upload-'));
    const file = path.join(dir, name);
    const { context, response, setFiles } = createHarness([dir]);
    try {
      await fs.promises.writeFile(file, 'upload');
      await uploadFile.handle(context as any, { paths: [file] }, response as any);
      expect(setFiles).toHaveBeenCalledWith([{ name, mimeType: 'application/octet-stream', buffer: Buffer.from('upload') }]);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects paths outside the configured directories before touching the file chooser', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-upload-'));
    const { context, response, setFiles, tab } = createHarness([dir]);

    try {
      await expect(uploadFile.handle(context as any, { paths: ['/etc/passwd', '/etc/hosts'] }, response as any))
          .rejects.toThrow(/outside the allowed upload directories/);

      expect(setFiles).not.toHaveBeenCalled();
      expect(tab.clearModalState).not.toHaveBeenCalled();
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects traversal that escapes the configured directory', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-upload-'));
    const dir = path.join(root, 'allowed');
    await fs.promises.mkdir(dir);
    const outside = path.join(root, 'outside.txt');
    await fs.promises.writeFile(outside, 'outside');
    const { context, response, setFiles } = createHarness([dir]);
    const escaping = path.join(dir, '..', 'outside.txt');

    try {
      await expect(uploadFile.handle(context as any, { paths: [escaping] }, response as any))
          .rejects.toThrow(/outside the allowed upload directories/);

      expect(setFiles).not.toHaveBeenCalled();
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('accepts every path only when each is inside some allowed directory', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-upload-'));
    const first = path.join(root, 'uploads-a');
    const second = path.join(root, 'uploads-b');
    await fs.promises.mkdir(first);
    await fs.promises.mkdir(second);
    const firstFile = path.join(first, 'a.txt');
    const secondFile = path.join(second, 'b.txt');
    await fs.promises.writeFile(firstFile, 'a');
    await fs.promises.writeFile(secondFile, 'b');
    const { context, response, setFiles } = createHarness([first, second]);

    try {
      await expect(uploadFile.handle(context as any, { paths: [firstFile, secondFile] }, response as any))
          .resolves.toBeUndefined();
      expect(setFiles).toHaveBeenCalledTimes(1);

      await expect(uploadFile.handle(context as any, { paths: [firstFile, '/etc/passwd'] }, response as any))
          .rejects.toThrow(/outside the allowed upload directories/);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('allows a file below an allowed root symlink', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-upload-'));
    const realRoot = path.join(root, 'real');
    const linkedRoot = path.join(root, 'linked');
    await fs.promises.mkdir(realRoot);
    await fs.promises.symlink(realRoot, linkedRoot, 'dir');
    const inside = path.join(realRoot, 'inside.txt');
    await fs.promises.writeFile(inside, 'safe');
    const { context, response, setFiles } = createHarness([linkedRoot]);

    try {
      await uploadFile.handle(context as any, { paths: [path.join(linkedRoot, 'inside.txt')] }, response as any);

      // SAFETY: the restricted upload contract passes FilePayload objects to setFiles.
      const uploaded = setFiles.mock.calls[0][0] as Array<{ name: string, buffer: Uint8Array }>;
      expect(uploaded[0].name).toBe('inside.txt');
      expect(Buffer.from(uploaded[0].buffer).toString()).toBe('safe');
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a file symlink that resolves outside an allowed root', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-upload-'));
    const allowed = path.join(root, 'allowed');
    const outside = path.join(root, 'secret.txt');
    const link = path.join(allowed, 'upload.txt');
    await fs.promises.mkdir(allowed);
    await fs.promises.writeFile(outside, 'secret');
    await fs.promises.symlink(outside, link);
    const { context, response, setFiles } = createHarness([allowed]);

    try {
      await expect(uploadFile.handle(context as any, { paths: [link] }, response as any))
          .rejects.toThrow(/outside the allowed upload directories/);
      expect(setFiles).not.toHaveBeenCalled();
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('freezes the upload before an allowed file is replaced', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-upload-'));
    const allowed = path.join(root, 'allowed');
    await fs.promises.mkdir(allowed);
    const target = path.join(allowed, 'upload.txt');
    const outside = path.join(root, 'secret.txt');
    await fs.promises.writeFile(target, 'safe');
    await fs.promises.writeFile(outside, 'secret');
    const setFilesImpl = async (files: unknown) => {
      await fs.promises.unlink(target);
      await fs.promises.symlink(outside, target);
      // SAFETY: the restricted upload contract passes FilePayload objects to setFiles.
      const uploaded = files as Array<{ buffer: Uint8Array }>;
      expect(Buffer.from(uploaded[0].buffer).toString()).toBe('safe');
    };
    const { context, response, setFiles } = createHarness([allowed], setFilesImpl);

    try {
      await uploadFile.handle(context as any, { paths: [target] }, response as any);
      expect(setFiles).toHaveBeenCalledTimes(1);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an ancestor replacement detected after the descriptor opens', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-upload-'));
    const allowed = path.join(root, 'allowed');
    const parked = path.join(root, 'allowed-parked');
    const outside = path.join(root, 'outside');
    const target = path.join(allowed, 'upload.txt');
    await fs.promises.mkdir(allowed);
    await fs.promises.mkdir(outside);
    await fs.promises.writeFile(target, 'safe');
    await fs.promises.writeFile(path.join(outside, 'upload.txt'), 'secret');
    const originalRealpath = fs.promises.realpath.bind(fs.promises);
    const originalStat = fs.promises.stat.bind(fs.promises);
    let ancestorSwapped = false;
    let hasSwapped = false;
    const isTargetPath = (filePath: string | Buffer | URL) => String(filePath).endsWith(`${path.sep}allowed${path.sep}upload.txt`);
    const swapAncestor = async () => {
      await fs.promises.rename(allowed, parked);
      await fs.promises.symlink(outside, allowed, 'dir');
      ancestorSwapped = true;
      hasSwapped = true;
    };
    const restoreAncestor = async () => {
      if (ancestorSwapped) {
        await fs.promises.unlink(allowed);
        await fs.promises.rename(parked, allowed);
        ancestorSwapped = false;
      }
    };
    vi.spyOn(fs.promises, 'stat').mockImplementation(async filePath => {
      if (!hasSwapped && isTargetPath(filePath))
        await swapAncestor();
      return await originalStat(filePath);
    });
    vi.spyOn(fs.promises, 'realpath').mockImplementation(async filePath => {
      if (ancestorSwapped && isTargetPath(filePath))
        await restoreAncestor();
      return await originalRealpath(filePath);
    });
    const { context, response, setFiles } = createHarness([allowed]);

    try {
      await expect(uploadFile.handle(context as any, { paths: [target] }, response as any))
          .rejects.toThrow(/changed during validation/);
      expect(setFiles).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await restoreAncestor();
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects directories under a restricted upload root', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-upload-'));
    const allowed = path.join(root, 'allowed');
    const directory = path.join(allowed, 'folder');
    await fs.promises.mkdir(directory, { recursive: true });
    const { context, response, setFiles } = createHarness([allowed]);

    try {
      await expect(uploadFile.handle(context as any, { paths: [directory] }, response as any))
          .rejects.toThrow(/regular files/);
      expect(setFiles).not.toHaveBeenCalled();
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects restricted uploads over the 50 MiB total limit', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-upload-'));
    const target = path.join(root, 'large.bin');
    await fs.promises.writeFile(target, '');
    await fs.promises.truncate(target, 50 * 1024 * 1024 + 1);
    const { context, response, setFiles } = createHarness([root]);

    try {
      await expect(uploadFile.handle(context as any, { paths: [target] }, response as any))
          .rejects.toThrow(/50 MiB/);
      expect(setFiles).not.toHaveBeenCalled();
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects every path when the allowlist is explicitly empty', async () => {
    const { context, response, setFiles } = createHarness([]);

    await expect(uploadFile.handle(context as any, { paths: [path.join(os.tmpdir(), 'x.txt')] }, response as any))
        .rejects.toThrow(/outside the allowed upload directories/);

    expect(setFiles).not.toHaveBeenCalled();
  });

  it('preserves empty uploads as the file chooser clear operation', async () => {
    const { context, response, setFiles } = createHarness([]);

    await uploadFile.handle(context as any, { paths: [] }, response as any);

    expect(setFiles).toHaveBeenCalledWith([]);
  });
});
