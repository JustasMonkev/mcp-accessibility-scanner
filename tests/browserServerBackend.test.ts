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
import { ProtocolErrorCode } from '@modelcontextprotocol/server';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { BrowserSessionRegistry } from '../src/browserSessions.js';
import { resolveConfig } from '../src/config.js';

const unusedFactory = {
  createContext: async () => {
    throw new Error('browser should not be launched in this test');
  },
} as any;

describe('BrowserServerBackend.callTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects unknown tools with an InvalidParams protocol error', async () => {
    const config = await resolveConfig({});
    const backend = new BrowserServerBackend(config, unusedFactory);
    await expect(backend.callTool('does_not_exist', {}))
        .rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
  });

  it('reports invalid tool input as a readable execution error', async () => {
    const config = await resolveConfig({});
    const backend = new BrowserServerBackend(config, unusedFactory);
    await expect(backend.callTool('browser_navigate', { url: 123 }))
        .rejects.toThrow(/Invalid input for tool "browser_navigate"/);
  });

  it('registers no session when the --save-session log cannot be created', async () => {
    // The session log used to be awaited only AFTER browser_session_open had
    // registered its Context: the rejection became an isError result carrying
    // no handle to close, so every retry accumulated another live session
    // until TTL reaping. The log must resolve before the handle is minted.
    const blockingFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-log-')), 'not-a-dir');
    fs.writeFileSync(blockingFile, '');
    const config = await resolveConfig({
      saveSession: true,
      // mkdir of the output directory fails with ENOTDIR under a plain file.
      outputDir: path.join(blockingFile, 'session-output'),
    });
    const registry = new BrowserSessionRegistry();
    const backend = new BrowserServerBackend(config, unusedFactory, registry);
    await backend.initialize({} as any, { name: 'vitest', version: '1.0.0' });

    const result = await backend.callTool('browser_session_open', {});
    expect(result.isError).toBe(true);
    expect((registry as any)._sessions.size).toBe(0);
  });

  it('logs a routed no-browser call made before the session launches a browser', async () => {
    // With --save-session, a routed call used to read context.sessionLog,
    // which is populated only when the session launches its browser. A
    // no-browser tool (browser_default_timeout) as the FIRST call in a fresh
    // explicit session therefore returned fine but never reached session.md.
    // The routed branch must resolve the session's log supplier — the opener
    // backend's async-once log — instead of reading the possibly-unset field.
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-routed-log-'));
    // Silence SessionLog.create()'s `Session: <folder>` announcement.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const config = await resolveConfig({ saveSession: true, outputDir });
      const registry = new BrowserSessionRegistry();
      const opener = new BrowserServerBackend(config, unusedFactory, registry);
      await opener.initialize({} as any, { name: 'vitest', version: '1.0.0' });
      const openResult = await opener.callTool('browser_session_open', {});
      expect(openResult.isError).not.toBe(true);
      const browserSessionId = (openResult.structuredContent as any).browserSessionId as string;

      // Route through a SECOND backend sharing the registry, as stateless
      // HTTP does: the call must land in the OPENER backend's log, not mint
      // one for the router.
      const router = new BrowserServerBackend(config, unusedFactory, registry);
      await router.initialize({} as any, { name: 'vitest', version: '1.0.0' });
      const result = await router.callTool('browser_default_timeout', { timeout: 30000, browserSessionId });
      expect(result.isError).not.toBe(true);

      // Flush the log's debounced buffer deterministically.
      const sessionLog = await (opener as any)._sessionLog;
      expect(sessionLog).toBeDefined();
      await (sessionLog as any)._flushEntries();
      await (sessionLog as any)._sessionFileQueue;

      const sessionFolders = fs.readdirSync(outputDir).filter(name => name.startsWith('session-'));
      // The routing backend minted no log of its own.
      expect(sessionFolders).toHaveLength(1);
      const sessionMd = fs.readFileSync(path.join(outputDir, sessionFolders[0], 'session.md'), 'utf-8');
      expect(sessionMd).toContain('browser_default_timeout');
      expect(sessionMd).toContain(browserSessionId);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
