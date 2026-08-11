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

import { beforeAll, describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const cliArgs = [path.join(rootDir, 'cli.js')];

beforeAll(() => {
  execFileSync(process.execPath, [path.join(rootDir, 'node_modules/typescript/bin/tsc'), '--project', path.join(rootDir, 'tsconfig.json')]);
});

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
      expect(help).toContain('--mobile');
      expect(help).toContain('--timeout-settle');
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

  describe('global --cdp-header option', () => {
    it('does not swallow a following subcommand as a header value', () => {
      // With a variadic option this consumes "list-tools" as a second header
      // and aborts; the repeatable single-value option leaves it as the command.
      const output = runCLI('--cdp-header X-Test:1 list-tools');
      expect(output).toContain('browser_navigate');
    });
  });

  describe('--connect-tool with a profile-conflicting storage state', () => {
    it('rejects at startup instead of advertising two unusable providers', async () => {
      // The persistent default provider rejects --storage-state combined with
      // --user-data-dir only on its first browser operation, and the extension
      // provider refuses a storage state at switch time — starting the server
      // would advertise two providers and neither could create a context.
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-connect-tool-'));
      const stateFile = path.join(stateDir, 'auth.json');
      fs.writeFileSync(stateFile, JSON.stringify({ cookies: [], origins: [] }));
      const profileDir = path.join(stateDir, 'profile');
      const { stderr } = await collectOutput(['--connect-tool', '--storage-state', stateFile, '--user-data-dir', profileDir]);
      expect(stderr).toContain('--storage-state and --user-data-dir contradict each other');
    });
  });

  describe('--vscode with a profile-conflicting storage state', () => {
    it('rejects at startup instead of advertising two unusable providers', async () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-vscode-'));
      const stateFile = path.join(stateDir, 'auth.json');
      fs.writeFileSync(stateFile, JSON.stringify({ cookies: [], origins: [] }));
      const profileDir = path.join(stateDir, 'profile');
      const { stderr } = await collectOutput(['--vscode', '--storage-state', stateFile, '--user-data-dir', profileDir]);
      expect(stderr).toContain('--storage-state and --user-data-dir contradict each other');
    });
  });

  describe('browser session handles across handshake-free requests in proxy modes', () => {
    // Each handshake-free POST builds a fresh proxy backend with a fresh
    // inner BrowserServerBackend. With a request-local registry, the handle
    // minted by the first POST was unknown to the second one (and disposed
    // when its response closed); the registry must be process-scoped, exactly
    // like the direct startMCPServer path.
    async function startServer(args: string[]) {
      const child = spawn(process.execPath, [...cliArgs, ...args, '--port', '0'], { stdio: 'pipe' });
      let stderr = '';
      const url = await new Promise<string>((resolve, reject) => {
        // The timeout must kill the child: the test's finally-cleanup only
        // sees a child once startServer has returned, so a server that never
        // announced its URL would otherwise keep running — and holding its
        // port — for the rest of the test run.
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`server did not start:\n${stderr}`));
        }, 25_000);
        child.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
          const match = stderr.match(/Listening on (http:\S+)/);
          if (match) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
        // No kill needed here: 'close' only fires once the child has already
        // exited and its stdio streams are closed.
        child.on('close', () => {
          clearTimeout(timer);
          reject(new Error(`server exited early:\n${stderr}`));
        });
      });
      return { child, url };
    }

    async function callTool(url: string, id: number, name: string, args: Record<string, unknown>) {
      const response = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      const messages = response.headers.get('content-type')?.includes('application/json')
        ? [JSON.parse(text)]
        : text.split('\n\n')
            .map(chunk => chunk.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice('data: '.length)).join(''))
            .filter(Boolean)
            .map(data => JSON.parse(data));
      const message = messages.find(m => m.id === id);
      expect(message?.error).toBeUndefined();
      expect(message?.result).toBeDefined();
      return message.result;
    }

    // A browser_connect switch must survive the response that carried it:
    // handshake-free POSTs are each served by a throwaway proxy backend, so
    // without a process-scoped selection the switch reported success while
    // the very next request silently ran on the default provider again.
    it('--connect-tool keeps a browser_connect switch in force for later handshake-free POSTs', async () => {
      const { child, url } = await startServer(['--connect-tool']);
      try {
        const switched = await callTool(url, 1, 'browser_connect', { name: 'extension' });
        expect(switched.isError).not.toBe(true);

        // The extension provider vetoes separate browser sessions; before
        // the fix this call ran on the default provider and minted a handle.
        const vetoed = await callTool(url, 2, 'browser_session_open', {});
        expect(vetoed.isError).toBe(true);
        expect(JSON.stringify(vetoed.content)).toContain('browser you are already running');

        // Switching back re-enables the default provider for later requests.
        const back = await callTool(url, 3, 'browser_connect', { name: 'default' });
        expect(back.isError).not.toBe(true);
        const opened = await callTool(url, 4, 'browser_session_open', {});
        expect(opened.isError).not.toBe(true);
        const browserSessionId = JSON.stringify(opened).match(/bs_[0-9a-f-]+/)?.[0];
        expect(browserSessionId).toBeTruthy();
        await callTool(url, 5, 'browser_session_close', { browserSessionId });
      } finally {
        child.kill('SIGTERM');
      }
    });

    it('--vscode keeps a browser_connect switch in force for later handshake-free POSTs', async () => {
      const { child, url } = await startServer(['--vscode']);
      try {
        // The switch spawns the child provider and handshakes with it; no
        // browser operation runs, so the dead connection string is fine.
        const switched = await callTool(url, 1, 'browser_connect', { connectionString: 'ws://127.0.0.1:9/never-connected', lib: 'playwright' });
        expect(switched.isError).not.toBe(true);

        // Session-less traffic runs on the switched provider, whose dead
        // connection string surfaces on the first browser operation; before
        // the process-scoped selection fix this request silently reverted to
        // the default provider (and launched a real browser).
        const navigated = await callTool(url, 2, 'browser_navigate', { url: 'data:text/html,<p>hi</p>' });
        expect(navigated.isError).toBe(true);
        expect(JSON.stringify(navigated.content)).toContain('127.0.0.1:9');

        // The session tools are host-scoped: even while switched, the handle
        // is minted by the default provider's registry at the host — the
        // switched child could neither mint one (its factory vetoes
        // sessions) nor resolve one minted before the switch.
        const opened = await callTool(url, 3, 'browser_session_open', {});
        expect(opened.isError).not.toBe(true);
        const browserSessionId = JSON.stringify(opened).match(/bs_[0-9a-f-]+/)?.[0];
        expect(browserSessionId).toBeTruthy();

        // Disconnecting re-enables the default provider for later requests...
        const back = await callTool(url, 4, 'browser_connect', {});
        expect(back.isError).not.toBe(true);
        // ...and the handle minted while switched still resolves at the host.
        const closed = await callTool(url, 5, 'browser_session_close', { browserSessionId });
        expect(closed.isError).not.toBe(true);
        expect(JSON.stringify(closed.content)).toContain(browserSessionId);
      } finally {
        child.kill('SIGTERM');
      }
    });

    for (const mode of ['--connect-tool', '--vscode']) {
      it(`${mode} resolves a handle minted in an earlier handshake-free POST`, async () => {
        const { child, url } = await startServer([mode]);
        try {
          const openResult = await callTool(url, 1, 'browser_session_open', {});
          expect(openResult.isError).not.toBe(true);
          const browserSessionId = JSON.stringify(openResult).match(/bs_[0-9a-f-]+/)?.[0];
          expect(browserSessionId).toBeTruthy();

          const closeResult = await callTool(url, 2, 'browser_session_close', { browserSessionId });
          expect(closeResult.isError).not.toBe(true);
          expect(JSON.stringify(closeResult.content)).toContain(browserSessionId);
        } finally {
          child.kill('SIGTERM');
        }
      });
    }
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
