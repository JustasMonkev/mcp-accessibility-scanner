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
import { resolveConfig } from '../src/config.js';
import { SessionLog } from '../src/sessionLog.js';

describe('session log folders', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives sessions created in the same millisecond distinct folders', async () => {
    // A purely timestamp-based name made two connections arriving in the
    // same millisecond share a folder: interleaved session.md entries and
    // overwritten snapshot ordinals.
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-session-folders-'));
    vi.spyOn(Date, 'now').mockReturnValue(1735689600000);
    // SessionLog.create() announces every session folder with
    // `console.error('Session: <folder>')`; silence the five copies so the
    // test output stays clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const config = await resolveConfig({ saveSession: true, outputDir });
      await Promise.all(Array.from({ length: 5 }, () => SessionLog.create(config)));

      const folders = fs.readdirSync(outputDir);
      expect(folders).toHaveLength(5);
      for (const folder of folders)
        expect(folder).toMatch(/^session-1735689600000-[a-f0-9]{8}$/);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('scopes user-action merging per context and tags session actions with their handle', async () => {
    // One log is shared by a backend's default context and every explicit
    // session: an update matched against the globally-last pending entry
    // merged one context's action into ANOTHER context's same-named one, and
    // untagged entries made concurrent sessions' actions unattributable.
    vi.useFakeTimers();
    try {
      const storage = {
        writeFile: vi.fn().mockResolvedValue(undefined),
        appendFile: vi.fn().mockResolvedValue(undefined),
      };
      const log = new SessionLog('/unused', storage);
      const sessionContext = { options: { browserSessionId: 'bs_0a1b2c3d' } } as any;
      const defaultContext = { options: {} } as any;
      const sessionTab = { context: sessionContext, page: { url: () => 'https://session.example/' } } as any;
      const defaultTab = { context: defaultContext, page: { url: () => 'https://default.example/' } } as any;

      log.logUserAction({ name: 'fill', text: 'session-1' } as any, sessionTab, `await page.fill('#a', 'session-1');`, false);
      log.logUserAction({ name: 'fill', text: 'default-1' } as any, defaultTab, `await page.fill('#b', 'default-1');`, false);
      // The session's update must merge into ITS pending action, not into the
      // default context's more recent same-named one.
      log.logUserAction({ name: 'fill', text: 'session-2' } as any, sessionTab, `await page.fill('#a', 'session-2');`, true);

      await vi.advanceTimersByTimeAsync(1000);

      const appended = storage.appendFile.mock.calls.map(call => call[1]).join('');
      const blocks = appended.split('### User action: fill');
      // Two entries, not three: the update merged into the session's own entry.
      expect(blocks).toHaveLength(3);
      const [, sessionBlock, defaultBlock] = blocks;
      expect(sessionBlock).toContain('"text": "session-2"');
      expect(sessionBlock).toContain('"browserSessionId": "bs_0a1b2c3d"');
      expect(appended).not.toContain('session-1');
      // The default context's entry is intact and stays untagged, as before.
      expect(defaultBlock).toContain('"text": "default-1"');
      expect(defaultBlock).not.toContain('browserSessionId');
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies an action update to its original tab', async () => {
    vi.useFakeTimers();
    try {
      const storage = {
        writeFile: vi.fn().mockResolvedValue(undefined),
        appendFile: vi.fn().mockResolvedValue(undefined),
      };
      const log = new SessionLog('/unused', storage);
      const context = { options: {} } as any;
      const firstTab = { context, page: { url: () => 'https://first.example/' } } as any;
      const secondTab = { context, page: { url: () => 'https://second.example/' } } as any;

      log.logUserAction({ name: 'click' } as any, firstTab, 'first action', false);
      log.logUserAction({ name: 'click' } as any, secondTab, 'second action', false);
      log.logUserAction({ name: 'click' } as any, firstTab, 'first action with popup', true);
      await vi.advanceTimersByTimeAsync(1000);

      const appended = storage.appendFile.mock.calls.map(call => call[1]).join('');
      expect(appended).toContain('first action with popup');
      expect(appended).not.toMatch(/```js\nfirst action\n/);
      expect(appended).toContain('second action');
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces a flushed action with its late signal update', async () => {
    vi.useFakeTimers();
    try {
      let content = '';
      const storage = {
        readFile: vi.fn(async () => content),
        writeFile: vi.fn(async (filePath: string, value: string) => {
          if (filePath.endsWith('session.md'))
            content = value;
        }),
        appendFile: vi.fn(async (_filePath: string, value: string) => { content += value; }),
      };
      const log = new SessionLog('/unused', storage);
      const context = { options: {} } as any;
      const tab = { context, page: { url: () => 'https://example.com/' } } as any;
      const action = { name: 'click' } as any;

      log.logUserAction(action, tab, 'original action', false);
      await vi.advanceTimersByTimeAsync(1000);
      log.logUserAction(action, tab, 'late signal update', true);
      await (log as any)._sessionFileQueue;

      expect(content.match(/### User action: click/g)).toHaveLength(1);
      expect(content).toContain('late signal update');
      expect(content).not.toContain('original action');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a return navigation after intervening log entries', async () => {
    vi.useFakeTimers();
    try {
      const storage = {
        writeFile: vi.fn().mockResolvedValue(undefined),
        appendFile: vi.fn().mockResolvedValue(undefined),
      };
      const log = new SessionLog('/unused', storage);
      const context = { options: {} } as any;
      const tab = { context, page: { url: () => 'https://a.example/' } } as any;
      const navigate = { name: 'navigate', url: 'https://a.example/' } as any;

      log.logUserAction(navigate, tab, "await page.goto('https://a.example/');", false);
      log.logResponse({
        context,
        toolName: 'browser_navigate',
        toolArgs: { url: 'https://b.example/' },
        result: () => '',
        isError: () => false,
        code: () => "await page.goto('https://b.example/');",
        tabSnapshot: () => ({ url: 'https://b.example/' }),
      } as any);
      log.logUserAction(navigate, tab, "await page.goto('https://a.example/');", false);
      log.logUserAction({ name: 'click' } as any, tab, "await page.getByText('Ready').click();", false);
      log.logUserAction(navigate, tab, "await page.goto('https://a.example/');", false);
      await vi.advanceTimersByTimeAsync(1000);

      const appended = storage.appendFile.mock.calls.map(call => call[1]).join('');
      expect(appended.match(/### User action: navigate/g)).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
