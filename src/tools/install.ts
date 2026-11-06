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

import { execFile, fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { defineTool } from './tool.js';

const windowsArchitectureScript = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeBrowserArchitecture {
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsWow64Process2(IntPtr process, out ushort processMachine, out ushort nativeMachine);

  public static string GetNativeArchitecture() {
    using (var currentProcess = System.Diagnostics.Process.GetCurrentProcess()) {
      ushort processMachine, nativeMachine;
      if (!IsWow64Process2(currentProcess.Handle, out processMachine, out nativeMachine))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      switch (nativeMachine) {
        case 0xAA64: return "Arm64";
        case 0x8664: return "X64";
        case 0x014c: return "X86";
        default: return "Unknown";
      }
    }
  }
}
'@
[NativeBrowserArchitecture]::GetNativeArchitecture()
`;

const install = defineTool({
  capability: 'install',
  schema: {
    name: 'browser_install',
    title: 'Install the browser specified in the config',
    description: 'Install the browser specified in the config. Call this if you get an error about the browser not being installed.',
    inputSchema: z.object({}),
    type: 'destructive',
  },

  handle: async (context, params, response) => {
    const channel = context.config.browser?.launchOptions?.channel ?? context.config.browser?.browserName ?? 'chrome';
    if (process.platform === 'win32' && (channel === 'chrome' || channel === 'chrome-beta')) {
      const workaround = 'Provision native Chrome separately and select it with browser.launchOptions.executablePath (--executable-path).';
      let architecture: string;
      try {
        architecture = await new Promise<string>((resolve, reject) => {
          execFile('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command', windowsArchitectureScript,
          ], { encoding: 'utf8', timeout: 5000, windowsHide: true }, (error, stdout) => {
            if (error)
              reject(error);
            else
              resolve(stdout.trim());
          });
        });
      } catch (error) {
        throw new Error(`Cannot verify native Windows architecture; refusing the Chrome installer. ${workaround}`, { cause: error });
      }
      if (architecture === 'Arm64')
        throw new Error(`Chrome installation on Windows ARM64 is blocked because Playwright's stable/beta installer selects x64 Chrome. ${workaround}`);
      if (architecture !== 'X64' && architecture !== 'X86')
        throw new Error(`Cannot verify native Windows architecture; refusing the Chrome installer. ${workaround}`);
    }
    const cliUrl = import.meta.resolve('playwright/package.json');
    const cliPath = path.join(fileURLToPath(cliUrl), '..', 'cli.js');
    const child = fork(cliPath, ['install', channel], {
      stdio: 'pipe',
    });
    const output: string[] = [];
    child.stdout?.on('data', data => output.push(data.toString()));
    child.stderr?.on('data', data => output.push(data.toString()));
    await new Promise<void>((resolve, reject) => {
      child.on('close', code => {
        if (code === 0)
          resolve();
        else
          reject(new Error(`Failed to install browser: ${output.join('')}`));
      });
    });
    response.addResult(`Browser ${channel} installed successfully.`);
    response.setIncludeTabs();
  },
});

export default [
  install,
];
