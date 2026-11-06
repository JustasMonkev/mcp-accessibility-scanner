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

import childProcess, { ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import installTools from '../src/tools/install.js';
import { Response } from '../src/response.js';
import type { Context } from '../src/context.js';

const install = installTools[0];
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const architecture = Object.getOwnPropertyDescriptor(process, 'arch')!;
let nativeArchitecture = 'Arm64';
let architectureError: Error | null = null;

function context(browser: Partial<Context['config']['browser']> = {}): Context {
  return { config: { browser } } as Context;
}

describe('browser_install platform selection', () => {
  beforeEach(() => {
    vi.spyOn(childProcess, 'fork').mockImplementation(() => {
      const child = new ChildProcess();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    nativeArchitecture = 'Arm64';
    architectureError = null;
    vi.spyOn(childProcess, 'execFile').mockImplementation((...args) => {
      const callback = args.at(-1);
      if (typeof callback !== 'function')
        throw new Error('Architecture query must provide a callback');
      queueMicrotask(() => callback(architectureError, `${nativeArchitecture}\r\n`, ''));
      return new ChildProcess();
    });
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    Object.defineProperty(process, 'arch', architecture);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  it.each(['arm64', 'x64', 'ia32'])('refuses Chrome stable/beta on ARM64 Windows with %s Node before launching an installer', async arch => {
    Object.defineProperty(process, 'arch', { value: arch });
    for (const channel of ['chrome', 'chrome-beta']) {
      const ctx = context({ launchOptions: { channel } });
      await expect(install.handle(ctx, {}, new Response(ctx, 'browser_install', {})))
          .rejects.toThrow(/Windows ARM64.*native Chrome.*executablePath/);
      expect(childProcess.fork).not.toHaveBeenCalled();
    }
  });

  it.each<Partial<Context['config']['browser']>>([{}, { launchOptions: { channel: 'chrome' }, browserName: 'chromium' }])(
      'also guards the default and explicit channel precedence (%j)', async browser => {
        const ctx = context(browser);
        await expect(install.handle(ctx, {}, new Response(ctx, 'browser_install', {})))
            .rejects.toThrow(/Windows ARM64/);
        expect(childProcess.fork).not.toHaveBeenCalled();
      });

  it.each([
    { platform: 'win32', native: 'X64', channel: 'chrome' },
    { platform: 'win32', native: 'X64', channel: 'chrome-beta' },
    { platform: 'win32', native: 'X86', channel: 'chrome' },
    { platform: 'darwin', native: 'Arm64', channel: 'chrome' },
    { platform: 'linux', native: 'Arm64', channel: 'chrome' },
    { platform: 'win32', native: 'Arm64', channel: 'chromium' },
    { platform: 'win32', native: 'Arm64', channel: 'msedge' },
    { platform: 'win32', native: 'Arm64', channel: 'chrome-dev' },
    { platform: 'win32', native: 'Arm64', channel: 'chrome-canary' },
  ])('keeps installer delegation for $platform/$native/$channel', async item => {
    Object.defineProperty(process, 'platform', { value: item.platform });
    nativeArchitecture = item.native;
    const ctx = context({ launchOptions: { channel: item.channel } });
    const response = new Response(ctx, 'browser_install', {});
    await install.handle(ctx, {}, response);
    expect(childProcess.fork).toHaveBeenCalledWith(expect.stringMatching(/[/\\]cli\.js$/), ['install', item.channel], { stdio: 'pipe' });
    expect(response.result()).toContain(`Browser ${item.channel} installed successfully.`);
    if (item.platform !== 'win32' || !['chrome', 'chrome-beta'].includes(item.channel))
      expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it('preserves bundled browser-name selection on ARM64 Windows', async () => {
    const ctx = context({ browserName: 'chromium' });
    await install.handle(ctx, {}, new Response(ctx, 'browser_install', {}));
    expect(childProcess.fork).toHaveBeenCalledWith(expect.any(String), ['install', 'chromium'], { stdio: 'pipe' });
  });

  it.each(['', 'unexpected', 'Arm'])('refuses an unrecognized native Windows architecture %j without installing', async machine => {
    nativeArchitecture = machine;
    const ctx = context({ launchOptions: { channel: 'chrome' } });
    await expect(install.handle(ctx, {}, new Response(ctx, 'browser_install', {})))
        .rejects.toThrow(/Cannot verify.*Windows.*executablePath/);
    expect(childProcess.fork).not.toHaveBeenCalled();
  });

  it.each(['PowerShell unavailable', 'query timed out', 'IsWow64Process2 unavailable', 'native API call failed'])('fails closed when architecture detection fails: %s', async message => {
    architectureError = new Error(message);
    const ctx = context({ launchOptions: { channel: 'chrome-beta' } });
    await expect(install.handle(ctx, {}, new Response(ctx, 'browser_install', {})))
        .rejects.toThrow(/Cannot verify.*Windows.*executablePath/);
    expect(childProcess.fork).not.toHaveBeenCalled();
  });

  it('uses a bounded fixed native OS query rather than Node process architecture', async () => {
    const ctx = context();
    await expect(install.handle(ctx, {}, new Response(ctx, 'browser_install', {}))).rejects.toThrow(/Windows ARM64/);
    expect(childProcess.execFile).toHaveBeenCalledWith('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', expect.any(String),
    ], { encoding: 'utf8', timeout: 30000, windowsHide: true }, expect.any(Function));
    const script = vi.mocked(childProcess.execFile).mock.calls[0][1]?.[3];
    expect(script).toContain('Add-Type');
    expect(script).toContain('IsWow64Process2(currentProcess.Handle, out processMachine, out nativeMachine)');
    expect(script).toContain('switch (nativeMachine)');
    expect(script).toContain('case 0xAA64: return "Arm64";');
    expect(script).toContain('case 0x8664: return "X64";');
    expect(script).toContain('case 0x014c: return "X86";');
    expect(script).not.toMatch(/RuntimeInformation|process\.arch|os\.machine|\$env:|switch \(processMachine\)/);
  });
});
