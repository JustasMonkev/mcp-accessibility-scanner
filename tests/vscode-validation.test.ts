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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { VSCodeBrowserContextFactory } from '../src/vscode/browserContextFactory.js';
import { VSCodeProxyBackend } from '../src/vscode/host.js';
import { validateBrowserConnectConnectionString, validateBrowserConnectLib } from '../src/vscode/validation.js';

describe('browser_connect validation', () => {
  afterEach(() => {
    delete process.env.PLAYWRIGHT_MCP_VSCODE_ALLOW_REMOTE;
    vi.restoreAllMocks();
  });

  describe('validateBrowserConnectLib', () => {
    it('allows the bundled Playwright specifiers', () => {
      expect(validateBrowserConnectLib('playwright')).toBeUndefined();
      expect(validateBrowserConnectLib('playwright-core')).toBeUndefined();
    });

    it('rejects paths, traversal, schemes and builtins', () => {
      const evil = [
        '/tmp/evil.mjs',
        './evil.mjs',
        '../evil.mjs',
        'playwright/test',
        'playwright\\test',
        '..\\evil',
        '.',
        '..',
        'C:\\evil.mjs',
        'data:text/javascript,process.exit(1)',
        'https://evil.example/evil.mjs',
        'http://evil.example/evil.mjs',
        'file:///tmp/evil.mjs',
        'node:fs',
        'node:child_process',
        'fs',
        'playwright\u0000evil',
        '',
      ];
      for (const lib of evil)
        expect(validateBrowserConnectLib(lib), `lib=${JSON.stringify(lib)}`).toBeDefined();
      expect(validateBrowserConnectLib(undefined)).toBeDefined();
    });
  });

  describe('validateBrowserConnectConnectionString', () => {
    it('allows loopback ws/wss endpoints', () => {
      for (const url of [
        'ws://127.0.0.1:1234/',
        'ws://localhost:1234/',
        'ws://[::1]:1234/',
        // The URL parser canonicalizes [::ffff:127.0.0.1] to this hex form.
        'ws://[::ffff:7f00:1]:1234/',
        'wss://127.0.0.1:1234/token',
        'ws://127.0.0.1:1234/path?query=1',
      ])
        expect(validateBrowserConnectConnectionString(url), url).toBeUndefined();
    });

    it('rejects non-ws schemes, userinfo and non-loopback hosts (SSRF)', () => {
      const evil = [
        'ws://169.254.169.254/',
        'ws://169.254.169.254/latest/meta-data/',
        'ws://evil.example/',
        'ws://192.168.1.10:1234/',
        'ws://10.0.0.1/',
        'ws://localhost.evil.example/',
        'ws://127.0.0.1.evil.example/',
        'ws://0.0.0.0:1234/',
        // Hex v4-mapped form of a non-loopback address.
        'ws://[::ffff:8.8.8.8]/',
        'http://127.0.0.1:1234/',
        'https://127.0.0.1:1234/',
        'data:text/plain,hi',
        'file:///tmp/x',
        'ws://user:pass@127.0.0.1:1234/',
        'ws://127.0.0.1@evil.example/',
        'ws:///no-host',
        'not-a-url',
        '',
      ];
      for (const url of evil)
        expect(validateBrowserConnectConnectionString(url), url).toBeDefined();
      expect(validateBrowserConnectConnectionString(undefined)).toBeDefined();
    });

    it('allows remote hosts only when the operator opts in', () => {
      expect(validateBrowserConnectConnectionString('ws://192.168.1.10:1234/')).toBeDefined();
      process.env.PLAYWRIGHT_MCP_VSCODE_ALLOW_REMOTE = '1';
      expect(validateBrowserConnectConnectionString('ws://192.168.1.10:1234/')).toBeUndefined();
      // Userinfo stays rejected even with remote opt-in.
      expect(validateBrowserConnectConnectionString('ws://user:pass@192.168.1.10:1234/')).toBeDefined();
      // Non-ws schemes stay rejected even with remote opt-in.
      expect(validateBrowserConnectConnectionString('http://192.168.1.10:1234/')).toBeDefined();
    });
  });

  describe('VSCodeProxyBackend rejects exploits without spawning', () => {
    async function makeBackend() {
      const config = await resolveConfig({});
      const backend = new VSCodeProxyBackend(config, vi.fn(async () => ({ id: 'default-transport' } as any)));
      const close = vi.fn(async () => undefined);
      (backend as any)._currentClient = {
        listTools: vi.fn(async () => ({ tools: [{ name: 'scan_page' }] })),
        callTool: vi.fn(async () => ({ content: [] })),
        close,
      };
      const createSwitchTransport = vi.spyOn(backend as any, '_createSwitchTransport');
      const setCurrentClient = vi.spyOn(backend as any, '_setCurrentClient').mockResolvedValue(undefined);
      return { backend, close, createSwitchTransport, setCurrentClient };
    }

    it.each([
      ['lib=/tmp/evil.mjs', { connectionString: 'ws://127.0.0.1:1234/', lib: '/tmp/evil.mjs' }],
      ['lib=data: URL', { connectionString: 'ws://127.0.0.1:1234/', lib: 'data:text/javascript,process.exit(1)' }],
      ['lib=https: URL', { connectionString: 'ws://127.0.0.1:1234/', lib: 'https://evil.example/evil.mjs' }],
      ['connectionString=metadata SSRF', { connectionString: 'ws://169.254.169.254/', lib: 'playwright' }],
      ['connectionString=http scheme', { connectionString: 'http://127.0.0.1:1234/', lib: 'playwright' }],
      ['connectionString=userinfo', { connectionString: 'ws://user:pass@127.0.0.1:1234/', lib: 'playwright' }],
    ])('rejects %s with isError and without spawning', async (_label, args) => {
      const { backend, close, createSwitchTransport, setCurrentClient } = await makeBackend();
      const result = await backend.callTool('browser_connect', args);
      expect(result.isError).toBe(true);
      expect(createSwitchTransport).not.toHaveBeenCalled();
      expect(setCurrentClient).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    });

    it('still connects for allowlisted lib + loopback endpoint', async () => {
      const { backend, setCurrentClient } = await makeBackend();
      const result = await backend.callTool('browser_connect', { connectionString: 'ws://127.0.0.1:1234/', lib: 'playwright' });
      expect(result.isError).not.toBe(true);
      expect(setCurrentClient).toHaveBeenCalledTimes(1);
    });
  });

  describe('VSCodeBrowserContextFactory last line of defense', () => {
    it('throws for a non-loopback endpoint without dialing', async () => {
      const config = await resolveConfig({});
      const connect = vi.fn(async () => ({ contexts: () => [], close: vi.fn() }));
      const factory = new VSCodeBrowserContextFactory(config, { chromium: { connect } } as any, 'ws://169.254.169.254/');
      await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal)).rejects.toThrow(/loopback|connectionString/i);
      expect(connect).not.toHaveBeenCalled();
    });
  });
});
