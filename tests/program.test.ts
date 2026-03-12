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

import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';

const cliArgs = ['--loader', 'ts-node/esm', path.resolve(__dirname, '..', 'src', 'program.ts')];

function runCLI(args: string): string {
  return execFileSync(process.execPath, [...cliArgs, ...args.split(' ').filter(Boolean)], {
    encoding: 'utf-8',
    timeout: 15_000,
  });
}

function collectOutput(args: string[], timeoutMs = 3000): Promise<{ stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [...cliArgs, ...args], { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ stdout, stderr });
    }, timeoutMs);
    child.on('close', () => resolve({ stdout, stderr }));
  });
}

describe('CLI command dispatch contract', () => {
  describe('help text', () => {
    it('shows list-tools and interactive as available commands', () => {
      const help = runCLI('--help');
      expect(help).toContain('list-tools');
      expect(help).toContain('interactive');
    });

    it('does NOT expose a serve command', () => {
      const help = runCLI('--help');
      expect(help).not.toMatch(/\bserve\b/);
    });

    it('shows global options like --browser and --config', () => {
      const help = runCLI('--help');
      expect(help).toContain('--browser');
      expect(help).toContain('--config');
      expect(help).toContain('--headless');
    });
  });

  describe('default command (no subcommand)', () => {
    it('routes to MCP server, not REPL', async () => {
      const { stdout } = await collectOutput([], 2000);
      expect(stdout).not.toContain('Interactive mode');
    });
  });

  describe('list-tools subcommand', () => {
    it('produces tool output with known tool names', () => {
      const output = runCLI('list-tools');
      expect(output).toContain('browser_navigate');
      expect(output).toContain('browser_snapshot');
      expect(output).toContain('browser_click');
      expect(output).toContain('scan_page');
    });
  });

  describe('subcommand --help flags', () => {
    it('list-tools accepts --help', () => {
      const output = runCLI('list-tools --help');
      expect(output).toContain('List available MCP tools');
    });

    it('interactive accepts --help', () => {
      const output = runCLI('interactive --help');
      expect(output).toContain('Start an interactive REPL');
    });
  });
});
