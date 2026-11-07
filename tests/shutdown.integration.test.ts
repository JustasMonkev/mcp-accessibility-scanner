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

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const rootDir = path.resolve(__dirname, '..');
const triggers = ['stdin', 'SIGINT', 'SIGTERM', 'SIGHUP', 'repeated-signals'] as const;
const fixtureResponseSchema = z.object({
  id: z.number().optional(),
  error: z.unknown().optional(),
  result: z.object({ isError: z.boolean().optional() }).loose().optional(),
});
type FixtureResponse = z.infer<typeof fixtureResponseSchema>;

function descendants(pid: number): number[] {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
      .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const result = [pid];
  for (let i = 0; i < result.length; i++)
    result.push(...rows.filter(([, parent]) => parent === result[i]).map(([child]) => child));
  return result.slice(1);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
      return false;
    throw error;
  }
}

describe.skipIf(process.platform === 'win32')('POSIX CLI shutdown', () => {
  let buildDir: string;

  beforeAll(async () => {
    const cacheDir = path.join(rootDir, 'node_modules', '.cache');
    await fs.mkdir(cacheDir, { recursive: true });
    buildDir = await fs.mkdtemp(path.join(cacheDir, 'shutdown-'));
    await Promise.all(['cli.js', 'package.json'].map(file => fs.copyFile(path.join(rootDir, file), path.join(buildDir, file))));
    execFileSync(process.execPath, [path.join(rootDir, 'node_modules/typescript/bin/tsc'), '--project', path.join(rootDir, 'tsconfig.json'), '--outDir', path.join(buildDir, 'lib')]);
  });

  afterAll(async () => {
    if (buildDir)
      await fs.rm(buildDir, { recursive: true, force: true });
  });

  it.each([
    ...triggers.map(trigger => ({ trigger, isolated: true })),
    ...triggers.map(trigger => ({ trigger, isolated: false })),
  ])('cleans owned browser processes on $trigger with isolated=$isolated', async ({ trigger, isolated }) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-shutdown-'));
    const temporary = path.join(directory, 'temporary');
    const profile = path.join(directory, 'profile');
    await fs.mkdir(temporary);
    await fs.mkdir(profile);
    const sentinel = path.join(profile, 'caller-owned.txt');
    await fs.writeFile(sentinel, 'retain');
    await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ browser: { isolated, userDataDir: isolated ? undefined : profile, launchOptions: { channel: 'chromium' } } }));
    const child = spawn(process.execPath, [path.join(buildDir, 'cli.js'), '--headless', '--browser', 'chromium', '--config', path.join(directory, 'config.json')], {
      stdio: 'pipe',
      env: { PATH: process.env.PATH, TMPDIR: temporary, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH },
    });
    const exited = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let stderr = '';
    child.stderr.on('data', data => stderr += data.toString());
    let id = 0;
    const pending = new Map<number, (message: FixtureResponse) => void>();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      const message = fixtureResponseSchema.parse(JSON.parse(line));
      if (message.id === undefined)
        return;
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });
    const call = (method: string, params: Record<string, unknown>) => new Promise<FixtureResponse>((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Timed out on ${method}: ${stderr}`)); }, 15_000);
      pending.set(requestId, message => { clearTimeout(timer); resolve(message); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });
    let pids: number[] = [];
    try {
      const initialized = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'shutdown-test', version: '1' } });
      expect(initialized.error, stderr).toBeUndefined();
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const result = await call('tools/call', { name: 'browser_navigate', arguments: { url: 'data:text/html,<title>Shutdown fixture</title>' } });
      expect(result.error, stderr).toBeUndefined();
      expect(result.result).toBeDefined();
      expect(result.result?.isError, JSON.stringify(result)).not.toBe(true);
      pids = descendants(child.pid!);
      expect(pids.length).toBeGreaterThan(0);
      const browserDirectories = (await fs.readdir(temporary)).filter(name => name.startsWith('playwright')).map(name => path.join(temporary, name));
      if (trigger === 'stdin') {
        child.stdin.end();
      } else if (trigger === 'repeated-signals') {
        child.kill('SIGTERM');
        child.kill('SIGINT');
      } else {
        child.kill(trigger);
      }
      await expect.poll(() => child.exitCode ?? child.signalCode, { timeout: 5000 }).toBe(0);
      await expect(exited).resolves.toEqual({ code: 0, signal: null });
      await expect.poll(() => pids.filter(alive), { timeout: 5000 }).toEqual([]);
      for (const browserDirectory of browserDirectories)
        await expect(fs.stat(browserDirectory)).rejects.toThrow();
      expect(await fs.readFile(sentinel, 'utf8')).toBe('retain');
    } finally {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) {
        pids = [...new Set([...pids, ...descendants(child.pid!)])];
        child.kill('SIGKILL');
      }
      for (const pid of pids.filter(alive)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH')
            throw error;
        }
      }
      await exited;
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
