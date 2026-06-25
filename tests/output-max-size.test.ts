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
import { afterEach, describe, expect, it } from 'vitest';
import { outputFile, resolveConfig } from '../src/config.js';

const tempDirs: string[] = [];

async function createOutputDir(): Promise<string> {
  const outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-output-max-size-'));
  tempDirs.push(outputDir);
  return outputDir;
}

async function writeSizedFile(filePath: string, size: number, mtimeMs: number) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, Buffer.alloc(size, 'x'));
  const mtime = new Date(mtimeMs);
  await fs.promises.utimes(filePath, mtime, mtime);
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.promises.access(filePath).then(() => true, () => false);
}

async function sortedEntries(dir: string): Promise<string[]> {
  return (await fs.promises.readdir(dir)).sort();
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })));
});

describe('outputMaxSize', () => {
  it('evicts the oldest evictable files and keeps session logs', async () => {
    const outputDir = await createOutputDir();
    const baseTime = Date.now() - 10_000;

    for (let i = 0; i < 5; i++)
      await writeSizedFile(path.join(outputDir, `file-${i}.bin`), 1_000, baseTime + i);
    await writeSizedFile(path.join(outputDir, 'session-1', 'session.md'), 1_000, baseTime - 1);

    const config = await resolveConfig({ outputDir, outputMaxSize: 3_000 });

    await expect(outputFile(config, undefined, 'next.bin')).resolves.toBe(path.join(outputDir, 'next.bin'));

    await expect(sortedEntries(outputDir)).resolves.toEqual([
      'file-2.bin',
      'file-3.bin',
      'file-4.bin',
      'session-1',
    ]);
    await expect(fileExists(path.join(outputDir, 'session-1', 'session.md'))).resolves.toBe(true);
  });

  it('evicts an oversize previous artifact before returning the next path', async () => {
    const outputDir = await createOutputDir();
    const config = await resolveConfig({ outputDir, outputMaxSize: 100 });

    const firstFile = await outputFile(config, undefined, 'page-1.png');
    await writeSizedFile(firstFile, 1_000, Date.now() - 1_000);

    const secondFile = await outputFile(config, undefined, 'page-2.png');
    await writeSizedFile(secondFile, 1_000, Date.now());

    await expect(sortedEntries(outputDir)).resolves.toEqual(['page-2.png']);
  });
});
