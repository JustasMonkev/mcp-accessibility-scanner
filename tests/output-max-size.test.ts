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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OUTPUT_TRACE_FOLDER_PREFIX, evictOutputFiles, outputFile, resolveCLIConfig, resolveConfig, setProtectedOutputDirsProvider } from '../src/config.js';
import { Context, outputEvictionGate } from '../src/context.js';
import { SessionLog } from '../src/sessionLog.js';
import { SESSION_LOG_FILE_NAME, SESSION_LOG_FOLDER_PREFIX } from '../src/sessionLogConstants.js';

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
  vi.unstubAllEnvs();
  setProtectedOutputDirsProvider(() => []);
  await Promise.all(tempDirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })));
});

describe('outputMaxSize', () => {
  it('evicts the oldest evictable files and keeps session log folders', async () => {
    const outputDir = await createOutputDir();
    const baseTime = Date.now() - 10_000;

    for (let i = 0; i < 5; i++)
      await writeSizedFile(path.join(outputDir, `file-${i}.bin`), 1_000, baseTime + i);
    await writeSizedFile(path.join(outputDir, 'session-1', SESSION_LOG_FILE_NAME), 1_000, baseTime - 1);
    await writeSizedFile(path.join(outputDir, 'session-1', '001.snapshot.yml'), 1_000, baseTime - 1);
    setProtectedOutputDirsProvider(() => [path.join(outputDir, 'session-1')]);

    // Limit 5 KB with the 2 KB session folder counted: only 3 KB of the five
    // 1 KB files may remain, so the two oldest are evicted.
    const config = await resolveConfig({ outputDir, outputMaxSize: 5_000 });

    await evictOutputFiles(config, undefined);

    await expect(sortedEntries(outputDir)).resolves.toEqual([
      'file-2.bin',
      'file-3.bin',
      'file-4.bin',
      'session-1',
    ]);
    await expect(fileExists(path.join(outputDir, 'session-1', SESSION_LOG_FILE_NAME))).resolves.toBe(true);
    await expect(fileExists(path.join(outputDir, 'session-1', '001.snapshot.yml'))).resolves.toBe(true);
  });

  it('evicts a stray session.md file at the output root instead of protecting the whole tree', async () => {
    const outputDir = await createOutputDir();
    const baseTime = Date.now() - 10_000;

    // A normal artifact/download that happens to be named session.md must not
    // mark the entire output directory as a protected session-log folder.
    await writeSizedFile(path.join(outputDir, SESSION_LOG_FILE_NAME), 1_000, baseTime);
    await writeSizedFile(path.join(outputDir, 'report-1.json'), 1_000, baseTime + 1);
    await writeSizedFile(path.join(outputDir, 'report-2.json'), 1_000, baseTime + 2);

    const config = await resolveConfig({ outputDir, outputMaxSize: 1_500 });

    await evictOutputFiles(config, undefined);

    await expect(sortedEntries(outputDir)).resolves.toEqual(['report-2.json']);
  });

  it('preserves trace folders for the active session', async () => {
    const outputDir = await createOutputDir();
    const baseTime = Date.now() - 10_000;

    await writeSizedFile(path.join(outputDir, `${OUTPUT_TRACE_FOLDER_PREFIX}123`, 'trace.zip'), 1_000, baseTime);
    await writeSizedFile(path.join(outputDir, 'screenshot-1.png'), 1_000, baseTime + 1);
    await writeSizedFile(path.join(outputDir, 'screenshot-2.png'), 1_000, baseTime + 2);
    setProtectedOutputDirsProvider(() => [path.join(outputDir, `${OUTPUT_TRACE_FOLDER_PREFIX}123`)]);

    // Limit 2 KB with the 1 KB trace folder counted leaves room for one
    // screenshot, so only the oldest screenshot is evicted.
    const config = await resolveConfig({ outputDir, outputMaxSize: 2_000 });

    await evictOutputFiles(config, undefined);

    await expect(sortedEntries(outputDir)).resolves.toEqual([
      'screenshot-2.png',
      `${OUTPUT_TRACE_FOLDER_PREFIX}123`,
    ]);
    await expect(fileExists(path.join(outputDir, `${OUTPUT_TRACE_FOLDER_PREFIX}123`, 'trace.zip'))).resolves.toBe(true);
  });

  it('evicts closed trace folders while keeping the active one', async () => {
    const outputDir = await createOutputDir();
    const baseTime = Date.now() - 10_000;

    // An older, closed trace folder and the active one (only the active folder
    // is reported as live).
    await writeSizedFile(path.join(outputDir, `${OUTPUT_TRACE_FOLDER_PREFIX}100`, 'trace.zip'), 1_000, baseTime);
    await writeSizedFile(path.join(outputDir, `${OUTPUT_TRACE_FOLDER_PREFIX}200`, 'trace.zip'), 1_000, baseTime + 5_000);
    setProtectedOutputDirsProvider(() => [path.join(outputDir, `${OUTPUT_TRACE_FOLDER_PREFIX}200`)]);

    const config = await resolveConfig({ outputDir, outputMaxSize: 0 });

    await evictOutputFiles(config, undefined);

    await expect(fileExists(path.join(outputDir, `${OUTPUT_TRACE_FOLDER_PREFIX}100`, 'trace.zip'))).resolves.toBe(false);
    await expect(fileExists(path.join(outputDir, `${OUTPUT_TRACE_FOLDER_PREFIX}200`, 'trace.zip'))).resolves.toBe(true);
  });

  it('preserves every live session folder when concurrent sessions share an output dir', async () => {
    const outputDir = await createOutputDir();
    const baseTime = Date.now() - 10_000;

    // Two concurrent HTTP sessions, each with its own active session-log folder.
    const sessionA = path.join(outputDir, `${SESSION_LOG_FOLDER_PREFIX}100`);
    const sessionB = path.join(outputDir, `${SESSION_LOG_FOLDER_PREFIX}200`);
    await writeSizedFile(path.join(sessionA, SESSION_LOG_FILE_NAME), 1_000, baseTime);
    await writeSizedFile(path.join(sessionB, SESSION_LOG_FILE_NAME), 1_000, baseTime + 5_000);
    await writeSizedFile(path.join(outputDir, 'old-report.json'), 1_000, baseTime - 1_000);
    setProtectedOutputDirsProvider(() => [sessionA, sessionB]);

    const config = await resolveConfig({ outputDir, outputMaxSize: 0 });

    await evictOutputFiles(config, undefined);

    // Eviction triggered by either session must not delete the other's log.
    await expect(fileExists(path.join(sessionA, SESSION_LOG_FILE_NAME))).resolves.toBe(true);
    await expect(fileExists(path.join(sessionB, SESSION_LOG_FILE_NAME))).resolves.toBe(true);
    await expect(fileExists(path.join(outputDir, 'old-report.json'))).resolves.toBe(false);
  });

  it('preserves the active session log folder nested under the default temp root', async () => {
    const tempRoot = await createOutputDir();
    vi.stubEnv('TMPDIR', tempRoot);
    const outputRoot = path.join(tempRoot, 'playwright-mcp-output', String(process.pid));
    const baseTime = Date.now() - 10_000;

    // In default mode each call nests under a timestamped fallback dir, so the
    // live session folder is not an immediate child of the eviction root.
    const sessionDir = path.join(outputRoot, '2026-01-01T00-00-00', `${SESSION_LOG_FOLDER_PREFIX}500`);
    await writeSizedFile(path.join(sessionDir, SESSION_LOG_FILE_NAME), 1_000, baseTime);
    await writeSizedFile(path.join(sessionDir, '001.snapshot.yml'), 1_000, baseTime);
    await writeSizedFile(path.join(outputRoot, '2025-01-01T00-00-00', 'old.png'), 1_000, baseTime - 1_000);
    setProtectedOutputDirsProvider(() => [sessionDir]);

    const config = await resolveConfig({ outputMaxSize: 0 });

    await evictOutputFiles(config, undefined);

    await expect(fileExists(path.join(sessionDir, SESSION_LOG_FILE_NAME))).resolves.toBe(true);
    await expect(fileExists(path.join(sessionDir, '001.snapshot.yml'))).resolves.toBe(true);
    await expect(fileExists(path.join(outputRoot, '2025-01-01T00-00-00', 'old.png'))).resolves.toBe(false);
  });

  it('counts protected bytes toward the budget and still evicts what it can', async () => {
    const outputDir = await createOutputDir();
    const baseTime = Date.now() - 10_000;

    const sessionDir = path.join(outputDir, `${SESSION_LOG_FOLDER_PREFIX}1`);
    await writeSizedFile(path.join(sessionDir, SESSION_LOG_FILE_NAME), 2_000, baseTime);
    await writeSizedFile(path.join(outputDir, 'report.json'), 1_000, baseTime + 1);
    setProtectedOutputDirsProvider(() => [sessionDir]);

    const config = await resolveConfig({ outputDir, outputMaxSize: 1_000 });

    await evictOutputFiles(config, undefined);

    // The protected 2 KB counts toward the 1 KB cap, so the evictable report is
    // removed even though the evictable bytes alone were within the limit.
    await expect(fileExists(path.join(outputDir, 'report.json'))).resolves.toBe(false);
    await expect(fileExists(path.join(sessionDir, SESSION_LOG_FILE_NAME))).resolves.toBe(true);
  });

  it('does not create the output directory when no size limit is configured', async () => {
    const tempRoot = await createOutputDir();
    const outputDir = path.join(tempRoot, 'unused-output');

    const config = await resolveConfig({ outputDir });
    await evictOutputFiles(config, undefined);

    await expect(fileExists(outputDir)).resolves.toBe(false);
  });

  it('evicts the oldest artifacts until the directory is back under the limit', async () => {
    const outputDir = await createOutputDir();
    const config = await resolveConfig({ outputDir, outputMaxSize: 1_000 });

    await writeSizedFile(path.join(outputDir, 'page-1.png'), 1_000, Date.now() - 1_000);
    await writeSizedFile(path.join(outputDir, 'page-2.png'), 1_000, Date.now());

    await evictOutputFiles(config, undefined);

    await expect(sortedEntries(outputDir)).resolves.toEqual(['page-2.png']);
  });

  it('rejects invalid outputMaxSize values from config and CLI/env sources', async () => {
    await expect(resolveConfig({ outputMaxSize: -1 })).rejects.toThrow('outputMaxSize must be a non-negative number');
    await expect(resolveCLIConfig({ outputMaxSize: Number.NaN })).rejects.toThrow('outputMaxSize must be a non-negative number');

    vi.stubEnv('PLAYWRIGHT_MCP_OUTPUT_MAX_SIZE', 'not-a-number');
    await expect(resolveCLIConfig({})).rejects.toThrow('outputMaxSize must be a non-negative number');
  });

  it('uses the stable temp output root when evicting fallback output', async () => {
    const tempRoot = await createOutputDir();
    vi.stubEnv('TMPDIR', tempRoot);
    const outputRoot = path.join(tempRoot, 'playwright-mcp-output', String(process.pid));
    const baseTime = Date.now() - 10_000;

    await writeSizedFile(path.join(outputRoot, 'old-1', 'artifact.bin'), 1_000, baseTime);
    await writeSizedFile(path.join(outputRoot, 'old-2', 'artifact.bin'), 1_000, baseTime + 1);

    const config = await resolveConfig({ outputMaxSize: 500 });
    await evictOutputFiles(config, undefined);

    // Eviction sees siblings under the stable temp root, not just a fresh dir.
    await expect(fileExists(path.join(outputRoot, 'old-1', 'artifact.bin'))).resolves.toBe(false);
    await expect(fileExists(path.join(outputRoot, 'old-2', 'artifact.bin'))).resolves.toBe(false);

    // New output paths are still allocated under that same stable temp root.
    const nextFile = await outputFile(config, undefined, 'next.bin');
    expect(nextFile.startsWith(outputRoot + path.sep)).toBe(true);
  });

  it('evicts only when globally idle and serializes eviction before tool bodies run', async () => {
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const evictions: string[] = [];
    const events: string[] = [];

    // The first (outer) tool's eviction is slow: it blocks until released.
    let releaseOuterEviction: () => void = () => {};
    const outerEviction = new Promise<void>(resolve => { releaseOuterEviction = resolve; });

    const outer = outputEvictionGate.run(
        async () => { evictions.push('outer'); await outerEviction; },
        async () => { events.push('outer-body'); },
    );
    let inner: Promise<void> | undefined;
    try {
      await tick();
      // The outer eviction started (it was globally idle) but its body is still
      // waiting on that eviction to finish.
      expect(evictions).toEqual(['outer']);
      expect(events).toEqual([]);

      // A second tool overlaps while the outer eviction is still running.
      inner = outputEvictionGate.run(
          async () => { evictions.push('inner'); },
          async () => { events.push('inner-body'); },
      );
      await tick();
      // It must not evict (not globally idle) and must not start writing until
      // the in-flight eviction has finished.
      expect(evictions).toEqual(['outer']);
      expect(events).toEqual([]);
    } finally {
      // Always release the shared gate so a failed assertion can't leave it
      // stuck pending and pollute later tests.
      releaseOuterEviction();
      await Promise.all([outer, inner]);
    }

    expect(evictions).toEqual(['outer']);
    expect(events).toEqual(['outer-body', 'inner-body']);
  });

  it('reports its active session log folder as a protected output dir', async () => {
    const outputDir = await createOutputDir();
    const sessionFolder = path.join(outputDir, `${SESSION_LOG_FOLDER_PREFIX}999`);
    const withSession = new Context({
      tools: [],
      config: {} as any,
      browserContextFactory: {} as any,
      sessionLog: new SessionLog(sessionFolder),
      clientInfo: { name: 'test', version: '1.0.0', rootPath: undefined },
    });
    const withoutSession = new Context({
      tools: [],
      config: {} as any,
      browserContextFactory: {} as any,
      sessionLog: undefined,
      clientInfo: { name: 'test', version: '1.0.0', rootPath: undefined },
    });

    try {
      expect(withSession.protectedOutputDirs()).toContain(sessionFolder);
      expect(withoutSession.protectedOutputDirs()).toEqual([]);
    } finally {
      await withSession.dispose();
      await withoutSession.dispose();
    }
  });
});
