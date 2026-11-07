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

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { contextFactory } from '../src/browserContextFactory.js';
import { resolveConfig } from '../src/config.js';

const stageTimeout = 15000;
const browsers: Browser[] = [];
const backends: BrowserServerBackend[] = [];
const processes: ChildProcess[] = [];
const stoppedProcessTrees = new WeakSet<ChildProcess>();
const profiles: string[] = [];
const sockets: WebSocket[] = [];
const launchPorts: number[] = [];
let origin: string;
let doomedRequests = 0;
const server = http.createServer((request, response) => {
  if (request.url === '/doomed')
    doomedRequests++;
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(request.url === '/healthy' ? '<title>Healthy tab</title><p>Still here</p>' : '<title>Doomed tab</title>');
});

type Target = { id: string; type: string; url: string; webSocketDebuggerUrl: string };
type CdpReply = { id?: number; error?: { message: string }; result?: { result?: { value?: unknown }; exceptionDetails?: unknown; targetInfo?: unknown } };

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Stage exceeded ${stageTimeout}ms`)), stageTimeout);
    })]);
  } finally {
    clearTimeout(timer!);
  }
}

type RunProcessCommand = (command: string, args: string[], options: { timeout: number; windowsHide: boolean }) => Promise<unknown>;

async function stopOwnedProcessTree(child: ChildProcess, platform = process.platform, runCommand: RunProcessCommand = promisify(execFile)) {
  const pid = child.pid;
  if (pid === undefined || stoppedProcessTrees.has(child))
    return;
  if (platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('Owned process exited before its Windows process tree could be terminated');
    const windowsRoot = process.env.SYSTEMROOT || process.env.windir || 'C:\\Windows';
    if (!path.win32.isAbsolute(windowsRoot))
      throw new Error('Windows system directory must be absolute');
    await runCommand(path.win32.join(windowsRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { timeout: stageTimeout, windowsHide: true });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH')
        throw error;
    }
  }
  if (child.exitCode === null && child.signalCode === null)
    await bounded(once(child, 'exit'));
  stoppedProcessTrees.add(child);
}

async function freePort() {
  const probe = net.createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP address');
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return address.port;
}

async function targets(endpoint: string): Promise<Target[]> {
  const response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(stageTimeout) });
  expect(response.ok).toBe(true);
  return response.json();
}

async function nativeTabs(endpoint: string) {
  return (await targets(endpoint)).filter(target => target.type === 'page').map(({ id, url }) => ({ id, url })).sort((a, b) => a.url.localeCompare(b.url));
}

async function connectRaw(target: Pick<Target, 'webSocketDebuggerUrl'>) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  sockets.push(socket);
  await bounded(once(socket, 'open'));
  let nextId = 0;
  return async (method: string, params: Record<string, unknown> = {}) => {
    const id = ++nextId;
    const reply = await bounded(new Promise<CdpReply>((resolve, reject) => {
      const onMessage = (data: WebSocket.RawData) => {
        const response: CdpReply = JSON.parse(data.toString());
        if (response.id !== id)
          return;
        socket.off('message', onMessage);
        if (response.error)
          reject(new Error(response.error.message));
        else
          resolve(response);
      };
      socket.on('message', onMessage);
      socket.send(JSON.stringify({ id, method, params }));
    }));
    expect(reply.result?.exceptionDetails).toBeUndefined();
    return reply.result;
  };
}

async function launchWithDiscardedTab() {
  doomedRequests = 0;
  const port = await freePort();
  const profile = await mkdtemp(path.join(os.tmpdir(), 'mcp-native-discard-'));
  profiles.push(profile);
  const child = spawn(chromium.executablePath(), [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', `${origin}/healthy`,
  ], { detached: true, stdio: 'ignore' });
  processes.push(child);
  launchPorts.push(port);
  await bounded(once(child, 'spawn'));
  const endpoint = `http://127.0.0.1:${port}`;
  await expect.poll(async () => {
    try {
      return (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) })).ok;
    } catch {
      return false;
    }
  }, { timeout: stageTimeout }).toBe(true);
  const version = await (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(stageTimeout) })).json();
  const browserSend = await connectRaw(version);
  for (const url of [`${origin}/doomed`, 'chrome://chrome-urls/'])
    await browserSend('Target.createTarget', { url, background: true });
  const control = (await targets(endpoint)).find(target => target.url === 'chrome://chrome-urls/');
  expect(control).toBeDefined();
  const send = await connectRaw(control!);
  const evaluate = async (expression: string) => (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;
  const urlsRoot = 'document.querySelector("chrome-urls-app")?.shadowRoot';
  await expect.poll(() => evaluate(`!!${urlsRoot}?.querySelector('cr-button')`), { timeout: stageTimeout }).toBe(true);
  await evaluate(`${urlsRoot}.querySelector('cr-button').click()`);
  await send('Page.navigate', { url: 'chrome://discards/' });
  await send('Page.bringToFront');
  const discardsRoot = 'document.querySelector("discards-main")?.shadowRoot?.querySelector("discards-tab")?.shadowRoot';
  const row = `[...(${discardsRoot}?.querySelectorAll('tbody tr') ?? [])].find(row => row.querySelector('.tab-url-cell')?.textContent.trim() === ${JSON.stringify(`${origin}/doomed`)})`;
  await expect.poll(() => evaluate(`!!${row}`), { timeout: stageTimeout }).toBe(true);
  await expect.poll(() => evaluate(`${row}?.cells[4].textContent.trim()`), { timeout: stageTimeout }).toBe('hidden');
  await evaluate(`[...${row}.querySelectorAll('.actions-cell div')].find(action => action.textContent.includes('Proactive Discard')).click()`);
  const state = `(() => { const row = ${row}; return row && { lifecycle: row.cells[6].textContent.trim(), count: row.cells[9].textContent.trim() }; })()`;
  await expect.poll(() => evaluate(state), { timeout: stageTimeout }).toEqual({ lifecycle: 'discarded (proactive)', count: '1' });
  process.stdout.write(JSON.stringify({ browser: 'native chrome://discards', action: 'Proactive Discard', state: await evaluate(state) }) + '\n');
  const healthy = (await targets(endpoint)).find(target => target.url === `${origin}/healthy`);
  expect(healthy).toBeDefined();
  await browserSend('Target.activateTarget', { targetId: healthy!.id });
  expect(await evaluate(state)).toEqual({ lifecycle: 'discarded (proactive)', count: '1' });
  const tabs = await nativeTabs(endpoint);
  expect(tabs.map(tab => tab.url)).toEqual(['chrome://discards/', `${origin}/doomed`, `${origin}/healthy`]);
  expect(doomedRequests).toBe(1);
  const doomed = tabs.find(tab => tab.url === `${origin}/doomed`)!;
  const readNativeState = async () => ({
    state: await evaluate(state), requests: doomedRequests,
    target: (await browserSend('Target.getTargetInfo', { targetId: doomed.id }))?.targetInfo,
  });
  process.stdout.write(JSON.stringify({ beforeAttach: await readNativeState() }) + '\n');
  return { endpoint, port, tabs, readNativeState };
}

function toolText(result: Awaited<ReturnType<BrowserServerBackend['callTool']>>) {
  return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}

// Requires a real desktop: explicitly opt in so a headless run is not discard evidence.
describe.runIf(process.env.MCP_TEST_HEADED_DISCARD === '1')('CDP attach with a natively discarded headed tab (#244)', () => {
  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected a TCP address');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    const profilesToRemove = profiles.splice(0);
    for (const backend of backends.splice(0))
      backend.serverClosed();
    for (const socket of sockets.splice(0))
      socket.terminate();
    const cleanup = await Promise.allSettled([
      ...browsers.splice(0).map(browser => bounded(browser.close())),
      ...processes.splice(0).map(child => stopOwnedProcessTree(child)),
    ]);
    const stopped = await Promise.allSettled(launchPorts.splice(0).map(port => expect.poll(async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
        return true;
      } catch {
        return false;
      }
    }, { timeout: stageTimeout }).toBe(false)));
    for (const result of [...cleanup, ...stopped])
      expect(result.status, result.status === 'rejected' ? String(result.reason) : '').toBe('fulfilled');
    const removed = await Promise.allSettled(profilesToRemove.map(profile => rm(profile, { recursive: true, force: true })));
    for (const result of removed)
      expect(result.status, result.status === 'rejected' ? String(result.reason) : '').toBe('fulfilled');
  });

  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

  it('raw Playwright attach omits the discarded tab and can use the healthy tab', async () => {
    const { endpoint, tabs, readNativeState } = await launchWithDiscardedTab();
    const browser = await bounded(chromium.connectOverCDP(endpoint, { timeout: 10000 }));
    browsers.push(browser);
    const pages = browser.contexts()[0].pages();
    const healthy = pages.find(page => page.url() === `${origin}/healthy`);
    expect(healthy).toBeDefined();
    expect(await bounded(healthy!.locator('p').textContent())).toBe('Still here');
    const native = await readNativeState();
    process.stdout.write(JSON.stringify({ afterAttach: native }) + '\n');
    expect(native.state).toEqual({ lifecycle: 'discarded (proactive)', count: '1' });
    expect(native.requests).toBe(1);
    expect(await nativeTabs(endpoint)).toEqual(tabs);
    expect(pages.map(page => page.url()).sort()).toEqual(['chrome://discards/', `${origin}/healthy`]);
  });

  for (const mode of ['endpoint', 'launch'] as const) {
    it.each([2000, 0])(`MCP ${mode} attach (cdpTimeout %i) exposes only the healthy tab and supports a follow-up tool`, async cdpTimeout => {
      const { endpoint, port, tabs, readNativeState } = await launchWithDiscardedTab();
      const launchPort = mode === 'launch' ? await freePort() : undefined;
      if (launchPort !== undefined)
        launchPorts.push(launchPort);
      const forwarder = `const net = require('node:net');
        const [port, target] = process.argv.slice(1).map(Number);
        net.createServer(socket => {
          const upstream = net.connect(target, '127.0.0.1');
          socket.pipe(upstream).pipe(socket);
          socket.on('error', () => upstream.destroy());
          upstream.on('error', () => socket.destroy());
        }).listen(port, '127.0.0.1');`;
      const config = await resolveConfig({
        browser: mode === 'endpoint' ? { cdpEndpoint: endpoint, cdpTimeout } : {
          cdpTimeout,
          cdpLaunch: { command: process.execPath, args: ['-e', forwarder, '{port}', String(port)], port: launchPort, startupTimeoutMs: 10000 },
        },
        timeouts: { settle: 50 },
      });
      const backend = new BrowserServerBackend(config, contextFactory(config));
      backends.push(backend);
      await bounded(backend.initialize({ notifyToolListChanged: async () => {} }, { name: 'vitest', version: '1.0.0' }));
      const result = await bounded(backend.callTool('browser_tabs', { action: 'list' }));
      expect(result.isError, toolText(result)).not.toBe(true);
      expect(toolText(result)).toContain(`${origin}/healthy`);
      const healthyLine = toolText(result).split('\n').find(line => line.includes(`${origin}/healthy`));
      const healthyIndex = healthyLine?.match(/^- (\d+):/);
      expect(healthyIndex).toBeTruthy();
      const selected = await bounded(backend.callTool('browser_tabs', { action: 'select', index: Number(healthyIndex![1]) }));
      expect(selected.isError, toolText(selected)).not.toBe(true);
      const followup = await bounded(backend.callTool('browser_evaluate', { function: '() => document.querySelector("p").textContent' }));
      expect(followup.isError, toolText(followup)).not.toBe(true);
      expect(toolText(followup)).toContain('Still here');
      const native = await readNativeState();
      process.stdout.write(JSON.stringify({ mode, cdpTimeout, afterAttach: native }) + '\n');
      expect(native.state).toEqual({ lifecycle: 'discarded (proactive)', count: '1' });
      expect(native.requests).toBe(1);
      expect(await nativeTabs(endpoint)).toEqual(tabs);
      expect(toolText(result)).not.toContain(`${origin}/doomed`);
    });
  }
});


describe('native browser fixture process cleanup', () => {
  const owned: ChildProcess[] = [];

  afterEach(async () => {
    await Promise.all(owned.splice(0).map(child => stopOwnedProcessTree(child)));
  });

  async function startTree(options: { detachedLeaf?: boolean } = {}) {
    const source = `const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: ${options.detachedLeaf ?? false}, stdio: 'ignore' });
      console.log(child.pid);
      setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['-e', source], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    owned.push(child);
    const [data] = await bounded(once(child.stdout!, 'data'));
    const descendantPid = Number(data.toString().trim());
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
    return { child, descendantPid };
  }

  async function isProcessRunning(pid: number, platform = process.platform, readStat: (file: string, encoding: 'utf8') => Promise<string> = readFile) {
    try {
      if (platform === 'linux') {
        const stat = await readStat(`/proc/${pid}/stat`, 'utf8');
        const state = stat.match(/^\d+ \([\s\S]*\) ([A-Za-z])(?: |$)/)?.[1];
        if (!state)
          throw new Error('Invalid Linux process stat');
        return !['Z', 'X', 'x'].includes(state);
      }
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ESRCH' || error.code === 'ENOENT'))
        return false;
      throw error;
    }
  }

  async function expectProcessTerminated(pid: number) {
    await expect.poll(() => isProcessRunning(pid), { timeout: stageTimeout }).toBe(false);
  }

  it('distinguishes terminated Linux states from active states with complex process names', async () => {
    for (const name of ['node', 'node worker', 'node ) worker', 'node\nworker)']) {
      for (const [state, running] of [['R', true], ['S', true], ['D', true], ['T', true], ['t', true], ['I', true], ['Z', false], ['X', false], ['x', false]] as const)
        await expect(isProcessRunning(process.pid, 'linux', async () => `${process.pid} (${name}) ${state} 1 2 3`)).resolves.toBe(running);
    }
  });

  it('accepts disappeared processes but preserves Linux read failures', async () => {
    for (const code of ['ENOENT', 'ESRCH']) {
      const error = Object.assign(new Error(code), { code });
      await expect(isProcessRunning(process.pid, 'linux', async () => { throw error; })).resolves.toBe(false);
    }
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    await expect(isProcessRunning(process.pid, 'linux', async () => { throw denied; })).rejects.toBe(denied);
  });

  it('rejects malformed Linux process state instead of accepting termination', async () => {
    for (const stat of ['', `${process.pid} node Z 1`, `${process.pid} (node) ?? 1`, `${process.pid} (node) `])
      await expect(isProcessRunning(process.pid, 'linux', async () => stat)).rejects.toThrow('Invalid Linux process stat');
  });

  it('terminates the detached parent and its descendant and tolerates repeated cleanup', async () => {
    const { child, descendantPid } = await startTree();
    await expect(isProcessRunning(descendantPid)).resolves.toBe(true);
    await stopOwnedProcessTree(child);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    await expectProcessTerminated(descendantPid);
    await stopOwnedProcessTree(child);
  });

  it('dispatches Windows cleanup to the system taskkill with tree termination', async () => {
    const { child } = await startTree();
    const runCommand = vi.fn(async () => {
      await stopOwnedProcessTree(child);
      return { stdout: '', stderr: '' };
    });
    await stopOwnedProcessTree(child, 'win32', runCommand);
    await stopOwnedProcessTree(child, 'win32', runCommand);
    expect(runCommand).toHaveBeenCalledTimes(1);
    const windowsRoot = process.env.SYSTEMROOT || process.env.windir || 'C:\\Windows';
    expect(runCommand).toHaveBeenCalledWith(path.win32.join(windowsRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { timeout: stageTimeout, windowsHide: true });
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('reports a failed Windows tree kill even when the root exits first', async () => {
    const { child, descendantPid } = await startTree({ detachedLeaf: true });
    const runCommand = vi.fn(async () => {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await bounded(exited);
      throw new Error('taskkill could not find the root');
    });
    try {
      await expect(stopOwnedProcessTree(child, 'win32', runCommand)).rejects.toThrow('taskkill could not find the root');
      await expect(isProcessRunning(descendantPid)).resolves.toBe(true);
      const alreadyExitedCommand = vi.fn(async () => ({ stdout: '', stderr: '' }));
      await expect(stopOwnedProcessTree(child, 'win32', alreadyExitedCommand)).rejects.toThrow('Owned process exited before its Windows process tree could be terminated');
      expect(alreadyExitedCommand).not.toHaveBeenCalled();
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        await stopOwnedProcessTree(child);
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH')
          throw error;
      }
      await expectProcessTerminated(descendantPid);
      owned.splice(owned.indexOf(child), 1);
    }
  });


  it.skipIf(process.platform === 'win32')('tolerates a POSIX group that exits before cleanup', async () => {
    const child = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' });
    owned.push(child);
    await bounded(once(child, 'exit'));
    await expect(stopOwnedProcessTree(child)).resolves.toBeUndefined();
  });

});
