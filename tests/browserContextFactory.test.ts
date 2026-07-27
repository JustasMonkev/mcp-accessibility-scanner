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

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connectOverCDP, spawnMock } = vi.hoisted(() => ({
  connectOverCDP: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('playwright', () => ({
  chromium: {
    connect: vi.fn(),
    connectOverCDP,
    launch: vi.fn(),
    launchPersistentContext: vi.fn(),
  },
  firefox: {
    connect: vi.fn(),
    launch: vi.fn(),
    launchPersistentContext: vi.fn(),
  },
  webkit: {
    connect: vi.fn(),
    launch: vi.fn(),
    launchPersistentContext: vi.fn(),
  },
  devices: {},
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import * as playwright from 'playwright';
import { assertStorageStateDoesNotResetUserProfile, assertStorageStateSupported, contextFactory } from '../src/browserContextFactory.js';
import { ExtensionContextFactory } from '../src/extension/extensionContextFactory.js';
import { VSCodeBrowserContextFactory } from '../src/vscode/browserContextFactory.js';
import { resolveConfig } from '../src/config.js';

function createMockBrowserContext() {
  return {
    addCookies: vi.fn().mockResolvedValue(undefined),
    clearCookies: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    cookies: vi.fn().mockResolvedValue([]),
    newPage: vi.fn().mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) }),
    pages: vi.fn().mockReturnValue([]),
    on: vi.fn(),
    off: vi.fn(),
    route: vi.fn().mockResolvedValue(undefined),
    unroute: vi.fn().mockResolvedValue(undefined),
    unrouteAll: vi.fn().mockResolvedValue(undefined),
    setStorageState: vi.fn().mockResolvedValue(undefined),
    storageState: vi.fn().mockResolvedValue({ cookies: [], origins: [] }),
    tracing: {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    },
  } as any;
}

function createMockBrowser(browserContext: any) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    contexts: vi.fn().mockReturnValue([browserContext]),
    newContext: vi.fn().mockResolvedValue(browserContext),
    on: vi.fn(),
  } as any;
}

function createMockPage(url: string, overrides: Record<string, any> = {}) {
  return {
    url: () => url,
    frames: vi.fn().mockReturnValue([]),
    reload: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// The reused-context apply reads and validates the state file before touching
// the browser, so tests exercising that path need a real, readable file.
const recordedState = { cookies: [{ name: 'app_session', value: 'recorded', domain: 'app.example', path: '/' }], origins: [] };

function writeStateFile(state: any = recordedState) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-state-')), 'auth.json');
  fs.writeFileSync(file, JSON.stringify(state));
  return file;
}

// Captures the fresh tabs the page-replacement sweep creates. When the
// attached context has a loaded page, the first newPage() call is the
// mutation-probe page (closed immediately, never navigated); replacements
// follow it.
function collectFreshPages(browserContext: any) {
  const created: any[] = [];
  browserContext.newPage.mockImplementation(async () => {
    const fresh = createMockPage('about:blank');
    created.push(fresh);
    return fresh;
  });
  return created;
}

function createMockChildProcess() {
  const childProcess = new EventEmitter() as any;
  childProcess.stderr = new EventEmitter();
  childProcess.exitCode = null;
  childProcess.kill = vi.fn().mockImplementation(() => {
    childProcess.exitCode = 0;
    childProcess.emit('exit', 0);
    return true;
  });
  return childProcess;
}

describe('browserContextFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disconnects from attach-only CDP sessions without closing the external context', async () => {
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
      },
    });

    const factory = contextFactory(config);
    const result = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    await result.close();

    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browserContext.close).not.toHaveBeenCalled();
  });

  it('forwards configured CDP headers and timeout when attaching to an endpoint', async () => {
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        cdpHeaders: { Authorization: 'Bearer token:with:colons' },
        cdpTimeout: 1234,
      },
    });

    const factory = contextFactory(config);
    await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(connectOverCDP).toHaveBeenCalledWith('http://127.0.0.1:9222', {
      headers: {
        'User-Agent': 'vitest/1.0.0',
        'Authorization': 'Bearer token:with:colons',
      },
      timeout: 1234,
      noDefaults: true,
    });
  });

  it('forwards the configured CDP timeout on the launch path', async () => {
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    const childProcess = createMockChildProcess();

    spawnMock.mockReturnValue(childProcess);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpTimeout: 4321,
        cdpHeaders: { Authorization: 'Bearer abc' },
        cdpLaunch: {
          command: 'open',
          port: 9222,
          startupTimeoutMs: 500,
        },
      },
    });

    const factory = contextFactory(config);
    await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(connectOverCDP).toHaveBeenLastCalledWith('http://127.0.0.1:9222', {
      headers: {
        'User-Agent': 'vitest/1.0.0',
        'Authorization': 'Bearer abc',
      },
      timeout: 4321,
      noDefaults: true,
    });
  });

  it('launches a desktop app, retries CDP attach, and terminates the child on close', async () => {
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    const childProcess = createMockChildProcess();

    spawnMock.mockReturnValue(childProcess);
    connectOverCDP
        .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:9222'))
        .mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpLaunch: {
          command: 'open',
          args: ['-a', 'Slack', '--args', '--remote-debugging-port={port}'],
          cwd: '/tmp/slack',
          env: {
            SLACK_ENV: 'test',
          },
          port: 9222,
          startupTimeoutMs: 500,
        },
      },
    });

    const factory = contextFactory(config);
    const result = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(spawnMock).toHaveBeenCalledWith('open', ['-a', 'Slack', '--args', '--remote-debugging-port=9222'], expect.objectContaining({
      cwd: '/tmp/slack',
      env: expect.objectContaining({
        SLACK_ENV: 'test',
      }),
      stdio: ['ignore', 'ignore', 'pipe'],
    }));
    expect(connectOverCDP).toHaveBeenCalledTimes(2);
    expect(connectOverCDP).toHaveBeenLastCalledWith('http://127.0.0.1:9222', {
      headers: {
        'User-Agent': 'vitest/1.0.0',
      },
      noDefaults: true,
    });

    await result.close();

    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(childProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('fails with a timeout when the launched CDP endpoint never becomes available', async () => {
    const childProcess = createMockChildProcess();
    spawnMock.mockReturnValue(childProcess);
    connectOverCDP.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const config = await resolveConfig({
      browser: {
        cdpLaunch: {
          command: 'open',
          port: 9222,
          startupTimeoutMs: 10,
        },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined)).rejects.toThrow('Timed out waiting for CDP endpoint http://127.0.0.1:9222.');
    expect(childProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('surfaces the missing browser executable path on the isolated launch path', async () => {
    (playwright.chromium.launch as any).mockRejectedValue(new Error(`Executable doesn't exist at /ms-playwright/chromium-1234/chrome-linux/chrome`));

    const config = await resolveConfig({
      browser: {
        isolated: true,
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow('Browser specified in your config is not installed; expected executable at /ms-playwright/chromium-1234/chrome-linux/chrome. Either install it (likely) or change the config.');
  });

  it('surfaces the missing browser executable path on the persistent launch path', async () => {
    (playwright.chromium.launchPersistentContext as any).mockRejectedValue(new Error(`Executable doesn't exist at /ms-playwright/chromium-1234/chrome-linux/chrome`));

    const config = await resolveConfig({});

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow('Browser specified in your config is not installed; expected executable at /ms-playwright/chromium-1234/chrome-linux/chrome. Either install it (likely) or change the config.');
  });

  it('falls back to the generic not-installed message when no executable path is present', async () => {
    (playwright.chromium.launchPersistentContext as any).mockRejectedValue(new Error(`Executable doesn't exist`));

    const config = await resolveConfig({});

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow('Browser specified in your config is not installed. Either install it (likely) or change the config.');
  });

  // launchPersistentContext() accepts a storageState option and silently ignores
  // it, so the factory must strip it and apply it to the launched context itself.
  it('applies the storage state to a fresh, per-context disposable profile', async () => {
    const browserContext = createMockBrowserContext();
    (playwright.chromium.launchPersistentContext as any).mockResolvedValue(browserContext);
    const rmSpy = vi.spyOn(fs.promises, 'rm');

    const config = await resolveConfig({
      browser: {
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);
    const result = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect((playwright.chromium.launchPersistentContext as any).mock.calls[0][1]).not.toHaveProperty('storageState');
    expect(browserContext.setStorageState).toHaveBeenCalledWith('/tmp/auth.json');
    expect(result.browserContext).toBe(browserContext);
    // setStorageState resets origin storage only for origins in the state, so a
    // previously used profile could leak a stale signed-in identity into the
    // audit; the state must land in its own fresh profile.
    const userDataDir = (playwright.chromium.launchPersistentContext as any).mock.calls[0][0] as string;
    expect(userDataDir).toMatch(/-storage-state-[0-9a-f]+$/);

    // One server can hold several live sessions: a second context must get its
    // own profile, or its setup would destroy the first one's running browser.
    const second = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);
    const secondDir = (playwright.chromium.launchPersistentContext as any).mock.calls[1][0] as string;
    expect(secondDir).not.toBe(userDataDir);

    // The disposable profile is removed with its context; the state file is the
    // durable copy.
    await result.close();
    expect(rmSpy).toHaveBeenCalledWith(userDataDir, { recursive: true, force: true });
    await second.close();
    expect(rmSpy).toHaveBeenCalledWith(secondDir, { recursive: true, force: true });
  });

  it('replaces persistent startup pages after the storage state lands', async () => {
    // browser.launchOptions.args can carry a URL, so a page may load before
    // setStorageState() runs and render the anonymous identity — Context
    // would adopt that DOM and a scan could audit the wrong user despite
    // --storage-state.
    const startup = createMockPage('https://app.example/dashboard');
    const browserContext = createMockBrowserContext();
    browserContext.pages.mockReturnValue([startup]);
    const fresh = collectFreshPages(browserContext);
    (playwright.chromium.launchPersistentContext as any).mockResolvedValue(browserContext);

    const config = await resolveConfig({
      browser: {
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);
    await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(startup.close).toHaveBeenCalledTimes(1);
    const replacement = fresh.find(page => page.goto.mock.calls.length)!;
    expect(replacement.goto).toHaveBeenCalledWith('https://app.example/dashboard');
    expect(replacement.goto.mock.invocationCallOrder[0]).toBeGreaterThan(browserContext.setStorageState.mock.invocationCallOrder[0]);
  });

  it('removes the disposable profile when the browser launch itself fails', async () => {
    // The guid-suffixed directory is created before launch; a start that never
    // produces a context must not leave it behind, or every failed start piles
    // another stray profile into the registry directory.
    (playwright.chromium.launchPersistentContext as any).mockRejectedValue(new Error(`Executable doesn't exist at /ms-playwright/chromium-1234/chrome-linux/chrome`));
    const rmSpy = vi.spyOn(fs.promises, 'rm');

    const config = await resolveConfig({
      browser: {
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow('Browser specified in your config is not installed');
    const userDataDir = (playwright.chromium.launchPersistentContext as any).mock.calls[0][0] as string;
    expect(userDataDir).toMatch(/-storage-state-[0-9a-f]+$/);
    expect(rmSpy).toHaveBeenCalledWith(userDataDir, { recursive: true, force: true });
  });

  it('keeps the regular persistent profile when a launch without storage state fails', async () => {
    // The shared interactive profile is durable user data; launch failures must
    // never delete it — only the disposable storage-state profiles are removed.
    (playwright.chromium.launchPersistentContext as any).mockRejectedValue(new Error(`Executable doesn't exist at /ms-playwright/chromium-1234/chrome-linux/chrome`));
    const rmSpy = vi.spyOn(fs.promises, 'rm');

    const config = await resolveConfig({});
    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow('Browser specified in your config is not installed');
    expect(rmSpy).not.toHaveBeenCalled();
  });

  it('rejects the contradictory --user-data-dir plus --storage-state combination', async () => {
    // A user-supplied profile carries its own session data and cannot be wiped;
    // silently keeping it would let its stale origin storage outvote the state.
    const config = await resolveConfig({
      browser: {
        userDataDir: '/home/user/my-profile',
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow('--storage-state and --user-data-dir contradict each other');
    expect(playwright.chromium.launchPersistentContext).not.toHaveBeenCalled();
  });

  it('closes the launched persistent browser when applying the storage state fails', async () => {
    const browserContext = createMockBrowserContext();
    browserContext.setStorageState.mockRejectedValue(new Error('ENOENT: no such file /tmp/auth.json'));
    (playwright.chromium.launchPersistentContext as any).mockResolvedValue(browserContext);

    const config = await resolveConfig({
      browser: {
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow('ENOENT');
    expect(browserContext.close).toHaveBeenCalledTimes(1);
  });

  it('applies the storage state to the reused context when attaching over CDP without isolation', async () => {
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);
    const result = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(browser.newContext).not.toHaveBeenCalled();
    expect(browserContext.setStorageState).toHaveBeenCalledWith(recordedState);
    expect(result.browserContext).toBe(browserContext);
  });

  it('disconnects from the CDP browser when applying the storage state fails on attach', async () => {
    const browserContext = createMockBrowserContext();
    browserContext.setStorageState.mockRejectedValueOnce(new Error('Error setting storage state:\nnavigation failed'));
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow('navigation failed');
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('rejects an unreadable storage state file before touching the browser', async () => {
    // Discovered inside the apply, a bad file would land in the catch that
    // answers every apply failure with a rollback — and the rollback's own
    // setStorageState() clears the attached context's HTTP cache. A config
    // error that changed nothing must not cost the running app its cache.
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: '/tmp/definitely-missing-auth.json' },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow(/could not be read or parsed.*Nothing was changed/);
    expect(browserContext.setStorageState).not.toHaveBeenCalled();
    expect(browserContext.storageState).not.toHaveBeenCalled();
    expect(browserContext.cookies).not.toHaveBeenCalled();
    expect(browserContext.clearCookies).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed storage state file before touching the browser', async () => {
    const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-state-')), 'auth.json');
    fs.writeFileSync(stateFile, 'not json {');
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: stateFile },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow(/could not be read or parsed.*Nothing was changed/);
    expect(browserContext.setStorageState).not.toHaveBeenCalled();
    expect(browserContext.cookies).not.toHaveBeenCalled();
  });

  it('explains the Electron limitation when restoring origin storage needs a page the target cannot create', async () => {
    // Playwright restores localStorage/IndexedDB by opening a temporary page;
    // Electron CDP targets have no Target.createTarget, so that fails after the
    // cookies were already applied. The raw protocol error says none of this.
    const browserContext = createMockBrowserContext();
    browserContext.setStorageState.mockRejectedValue(new Error('Error setting storage state:\nTarget.createTarget: Not supported'));
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow(/Drop the storage state and sign in inside the app instead/);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('rejects the storage state before mutating anything when the needed page cannot be created', async () => {
    // setStorageState clears the HTTP cache before the page creation that fails
    // on Electron, and a cache cannot be restored. With a loaded page in the
    // attached browser (so a temporary page will be needed), the probe must
    // fail the operation while nothing has been touched yet.
    const browserContext = createMockBrowserContext();
    browserContext.pages.mockReturnValue([{ url: () => 'https://app.example/dashboard' }]);
    browserContext.newPage.mockRejectedValue(new Error('Target.createTarget: Not supported'));
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow(/Nothing was changed/);
    expect(browserContext.setStorageState).not.toHaveBeenCalled();
    expect(browserContext.clearCookies).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('replaces already-open pages after installing the storage state, and only then', async () => {
    // A reused page still renders the previous identity's DOM; an immediate
    // scan would audit the wrong user unless the page is brought onto the
    // freshly installed state — and the old document must close, not reload
    // in place, so its scripts cannot write the previous identity back into
    // sessionStorage between a clear and the navigation.
    const pages = [
      createMockPage('https://app.example/a'),
      createMockPage('https://app.example/b'),
    ];
    const browserContext = createMockBrowserContext();
    browserContext.pages.mockReturnValue(pages);
    const fresh = collectFreshPages(browserContext);
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);
    await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    for (const page of pages) {
      expect(page.close).toHaveBeenCalledTimes(1);
      expect(page.reload).not.toHaveBeenCalled();
    }
    const replacements = fresh.filter(page => page.goto.mock.calls.length);
    expect(replacements.flatMap(page => page.goto.mock.calls.map((call: any[]) => call[0])).sort()).toEqual(['https://app.example/a', 'https://app.example/b']);
    for (const replacement of replacements)
      expect(replacement.goto.mock.invocationCallOrder[0]).toBeGreaterThan(browserContext.setStorageState.mock.invocationCallOrder[0]);
  });

  it('applies the validated parse of a storage-state file, not a re-read of the path', async () => {
    // Handing the path to setStorageState() would make Playwright read the
    // file a second time — a file replaced between the validating read and the
    // apply would skip the cookie/origin validation and the page-creation
    // probe, then fail after the unrestorable cache clear.
    const state = { cookies: [{ name: 'app_session', value: 'recorded', domain: 'app.example', path: '/' }], origins: [] };
    const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-state-')), 'auth.json');
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: stateFile },
      },
    });

    const factory = contextFactory(config);
    await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(browserContext.setStorageState).toHaveBeenCalledWith(state);
    expect(browserContext.setStorageState).not.toHaveBeenCalledWith(stateFile);
  });

  it('resets a page that opens while the existing pages are being replaced', async () => {
    // A still-old document can open a popup from a timer during the refresh
    // window, and a same-origin popup clones its opener's previous-identity
    // sessionStorage at creation — a single pages() snapshot would hand it to
    // Context unreset.
    const popup = createMockPage('https://app.example/popup');
    const opener = createMockPage('https://app.example/a');
    const pagesList: any[] = [opener];
    opener.close.mockImplementation(async () => {
      if (!pagesList.includes(popup))
        pagesList.push(popup);
    });
    const browserContext = createMockBrowserContext();
    browserContext.pages.mockImplementation(() => [...pagesList]);
    const fresh = collectFreshPages(browserContext);
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);
    await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(opener.close).toHaveBeenCalledTimes(1);
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(fresh.flatMap(page => page.goto.mock.calls.map((call: any[]) => call[0]))).toContain('https://app.example/popup');
  });

  it('resets a page the sweep only learns about from the page event', async () => {
    // Playwright surfaces a new page in pages() asynchronously; a popup whose
    // creation raced the sweep's last pages() call is only visible through the
    // temporary 'page' listener — and the listener comes off before handoff.
    const popup = createMockPage('https://app.example/popup');
    const opener = createMockPage('https://app.example/a');
    const listeners = new Map<string, (page: any) => void>();
    const browserContext = createMockBrowserContext();
    browserContext.on.mockImplementation((event: string, listener: (page: any) => void) => listeners.set(event, listener));
    browserContext.pages.mockReturnValue([opener]);
    opener.close.mockImplementation(async () => listeners.get('page')?.(popup));
    const fresh = collectFreshPages(browserContext);
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);
    await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(fresh.flatMap(page => page.goto.mock.calls.map((call: any[]) => call[0]))).toContain('https://app.example/popup');
    expect(browserContext.off).toHaveBeenCalledWith('page', listeners.get('page'));
  });

  it('replaces a page arriving through both the page event and pages() exactly once', async () => {
    // The same Page object can surface through the temporary listener and the
    // next pages() call; two concurrent replacements would race each other's
    // close and navigation and could blank or close a valid replacement.
    const popup = createMockPage('https://app.example/popup');
    const opener = createMockPage('https://app.example/a');
    const pagesList: any[] = [opener];
    const listeners = new Map<string, (page: any) => void>();
    const browserContext = createMockBrowserContext();
    browserContext.on.mockImplementation((event: string, listener: (page: any) => void) => listeners.set(event, listener));
    browserContext.pages.mockImplementation(() => [...pagesList]);
    opener.close.mockImplementation(async () => {
      pagesList.push(popup);
      listeners.get('page')?.(popup);
    });
    const fresh = collectFreshPages(browserContext);
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);
    await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(popup.close).toHaveBeenCalledTimes(1);
    // One probe page, one replacement for the opener, one for the popup — a
    // duplicate in the pending batch would create a fourth.
    expect(browserContext.newPage).toHaveBeenCalledTimes(3);
    expect(fresh.flatMap(page => page.goto.mock.calls.map((call: any[]) => call[0])).filter(url => url === 'https://app.example/popup')).toHaveLength(1);
  });

  it('mirrors the configured network policy around the replacement navigations', async () => {
    // The replacement navigations run inside the factory, before Context
    // installs the origin allowlist/blocklist — with the recorded credentials
    // already applied, the first navigation must not be able to reach a
    // blocked origin.
    const pages = [createMockPage('https://app.example/a')];
    const browserContext = createMockBrowserContext();
    browserContext.pages.mockReturnValue(pages);
    const fresh = collectFreshPages(browserContext);
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
      network: { blockedOrigins: ['tracker.example'] },
    });

    const factory = contextFactory(config);
    await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    // Routes go in after the state is applied (so they cannot interfere with
    // the temporary page Playwright drives) and before the replacement
    // navigations — and they STAY: page scripts can queue requests that fire
    // after the navigation settles, so removing the handlers before Context
    // re-ensures the same policy would open a window to a blocked origin.
    const replacement = fresh.find(page => page.goto.mock.calls.length)!;
    expect(browserContext.route).toHaveBeenCalledWith('*://tracker.example/**', expect.any(Function));
    expect(browserContext.route.mock.invocationCallOrder[0]).toBeGreaterThan(browserContext.setStorageState.mock.invocationCallOrder[0]);
    expect(browserContext.route.mock.invocationCallOrder[0]).toBeLessThan(replacement.goto.mock.invocationCallOrder[0]);
    expect(browserContext.unroute).not.toHaveBeenCalled();
    expect(browserContext.unrouteAll).not.toHaveBeenCalled();
  });

  it('leaves routing untouched around the replacements when no network policy is configured', async () => {
    const pages = [createMockPage('https://app.example/a')];
    const browserContext = createMockBrowserContext();
    browserContext.pages.mockReturnValue(pages);
    const fresh = collectFreshPages(browserContext);
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);
    await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(pages[0].close).toHaveBeenCalledTimes(1);
    expect(fresh.some(page => page.goto.mock.calls.length)).toBe(true);
    expect(browserContext.route).not.toHaveBeenCalled();
    expect(browserContext.unroute).not.toHaveBeenCalled();
    expect(browserContext.unrouteAll).not.toHaveBeenCalled();
  });

  it('rejects the storage state when snapshotting retained origins needs a page the target cannot create', async () => {
    // A connection can retain visited origins whose pages have since closed:
    // pages() shows nothing, yet setStorageState() still unions those origins
    // into its work and would clear the HTTP cache before failing to create
    // its temporary page on Electron. The origin snapshot needs the same page
    // and mutates nothing, so its failure must reject the operation while
    // everything is intact.
    const browserContext = createMockBrowserContext();
    browserContext.pages.mockReturnValue([]);
    browserContext.storageState.mockRejectedValue(new Error('Target.createTarget: Not supported'));
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow(/origins this connection has already visited.*Nothing was changed/);
    expect(browserContext.setStorageState).not.toHaveBeenCalled();
    expect(browserContext.clearCookies).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('closes the old document before its replacement navigates, and never scripts into it', async () => {
    // An in-page sessionStorage clear leaves the old document's scripts
    // running until the reload commits — a timer can write the previous
    // identity back into that window, and sessionStorage survives the reload.
    // Replacement closes the old document first, so nothing can be written
    // back, and never needs to evaluate into its frames at all.
    const frames = [{ evaluate: vi.fn().mockResolvedValue(undefined) }];
    const pages = [createMockPage('https://app.example/a', { frames: vi.fn().mockReturnValue(frames) })];
    const browserContext = createMockBrowserContext();
    browserContext.pages.mockReturnValue(pages);
    const fresh = collectFreshPages(browserContext);
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);
    await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(frames[0].evaluate).not.toHaveBeenCalled();
    expect(pages[0].reload).not.toHaveBeenCalled();
    const replacement = fresh.find(page => page.goto.mock.calls.length)!;
    expect(pages[0].close.mock.invocationCallOrder[0]).toBeLessThan(replacement.goto.mock.invocationCallOrder[0]);
  });

  it('keeps the shared CDP connection open until the last session releases it', async () => {
    // Every session of a non-isolated CDP factory shares one connection; a
    // sibling closing must not tear down a live audit.
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: { cdpEndpoint: 'http://127.0.0.1:9222' },
    });

    const factory = contextFactory(config);
    const first = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);
    const second = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    await second.close();
    expect(browser.close).not.toHaveBeenCalled();
    // A double release must not steal the remaining session's reference.
    await second.close();
    expect(browser.close).not.toHaveBeenCalled();
    await first.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('does not close the shared CDP connection when a later session fails setup', async () => {
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    browser.contexts.mockReturnValueOnce([browserContext]).mockReturnValue([]);
    browser.newContext.mockRejectedValue(new Error('Target.createBrowserContext: Not supported'));
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: { cdpEndpoint: 'http://127.0.0.1:9222' },
    });

    const factory = contextFactory(config);
    await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    // The second session's context creation fails; the first session's live
    // connection must survive that cleanup.
    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow('Target.createBrowserContext');
    expect(browser.close).not.toHaveBeenCalled();
  });

  // Playwright validates cookies only while installing them — after the
  // attached context's HTTP cache and cookie jar are already cleared — and
  // the cache cannot be restored by the rollback.
  it.each([
    { label: 'empty domain', cookie: { name: 'sid', value: 'x', domain: '', path: '/' }, problem: /url or a domain\/path pair/ },
    { label: 'url with domain', cookie: { name: 'sid', value: 'x', url: 'https://app.example/', domain: 'app.example' }, problem: /either a url or a domain/ },
    { label: 'url with path', cookie: { name: 'sid', value: 'x', url: 'https://app.example/', path: '/' }, problem: /either a url or a path/ },
    { label: 'expires -2', cookie: { name: 'sid', value: 'x', domain: 'app.example', path: '/', expires: -2 }, problem: /valid expires/ },
    { label: 'expires past the ceiling', cookie: { name: 'sid', value: 'x', domain: 'app.example', path: '/', expires: 253402300800 }, problem: /valid expires/ },
    { label: 'bad sameSite', cookie: { name: 'sid', value: 'x', domain: 'app.example', path: '/', sameSite: 'Sideways' }, problem: /Strict\|Lax\|None/ },
    { label: 'url about:blank', cookie: { name: 'sid', value: 'x', url: 'about:blank' }, problem: /cannot be about:blank/ },
    { label: 'data: url', cookie: { name: 'sid', value: 'x', url: 'data:text/html,x' }, problem: /cannot be a data: URL/ },
    { label: 'unparseable url', cookie: { name: 'sid', value: 'x', url: 'not a url' }, problem: /not a valid absolute URL/ },
    { label: 'non-http url', cookie: { name: 'sid', value: 'x', url: 'ws://app.example/' }, problem: /must be an http\(s\) URL/ },
  ])('rejects a storage state with a $label cookie before touching the browser', async ({ cookie, problem }) => {
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: { cookies: [cookie], origins: [] } as any },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow(problem);
    expect(browserContext.setStorageState).not.toHaveBeenCalled();
    expect(browserContext.clearCookies).not.toHaveBeenCalled();
  });

  it('rejects a storage state whose origins entry is not an http(s) URL, before touching the browser', async () => {
    // Restoring an origin's storage navigates Playwright's temporary page to
    // it — a malformed origin fails that navigation after the cache clear.
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: { cookies: [], origins: [{ origin: 'not a url', localStorage: [] }] } as any },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow(/origins entry .* is not an absolute http\(s\) URL/);
    expect(browserContext.setStorageState).not.toHaveBeenCalled();
    expect(browserContext.newPage).not.toHaveBeenCalled();
  });

  it('closes a page outright when no replacement tab can be created', async () => {
    // Electron targets cannot create pages; without a replacement, closing is
    // the only way to keep the previous identity's DOM and sessionStorage out
    // of the audit. (Reachable only with blank pages open — a loaded page
    // makes the earlier newPage probe reject the whole apply first.)
    const pages = [createMockPage('about:blank')];
    const browserContext = createMockBrowserContext();
    browserContext.pages.mockReturnValue(pages);
    browserContext.newPage.mockRejectedValue(new Error('Target.createTarget: Not supported'));
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);
    await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(pages[0].close).toHaveBeenCalledTimes(1);
    expect(pages[0].reload).not.toHaveBeenCalled();
    expect(pages[0].goto).not.toHaveBeenCalled();
  });

  it('evicts a fallback context from the memo when it closes', async () => {
    // A context closed externally (while the connection lives on) no longer
    // appears in contexts(); only the memo would remember it, and every later
    // session would receive the dead context.
    const context1 = createMockBrowserContext();
    const context2 = createMockBrowserContext();
    const browser = createMockBrowser(context1);
    browser.contexts.mockReturnValue([]);
    browser.newContext.mockResolvedValueOnce(context1).mockResolvedValueOnce(context2);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: { cdpEndpoint: 'http://127.0.0.1:9222' },
    });

    const factory = contextFactory(config);
    const first = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);
    expect(first.browserContext).toBe(context1);

    // The created context closes externally; the memo must let go of it.
    const onClose = context1.on.mock.calls.find((call: any[]) => call[0] === 'close')?.[1];
    onClose?.();

    const second = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);
    expect(browser.newContext).toHaveBeenCalledTimes(2);
    expect(second.browserContext).toBe(context2);
  });

  it('closes an isolated session\'s own context on release, keeping the shared connection', async () => {
    // Each isolated session gets a distinct context on the shared connection;
    // releasing a session must reclaim its context (pages, routes, listeners)
    // instead of letting abandoned contexts pile up until the last session
    // exits — while the connection itself stays for the remaining sibling.
    const context1 = createMockBrowserContext();
    const context2 = createMockBrowserContext();
    const browser = createMockBrowser(context1);
    browser.newContext.mockResolvedValueOnce(context1).mockResolvedValueOnce(context2);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: { cdpEndpoint: 'http://127.0.0.1:9222', isolated: true },
    });

    const factory = contextFactory(config);
    const first = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);
    const second = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    await first.close();
    expect(context1.close).toHaveBeenCalledTimes(1);
    expect(browser.close).not.toHaveBeenCalled();
    await second.close();
    expect(context2.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('counts CDP session references per browser generation', async () => {
    // An external disconnect makes the factory hand out a fresh connection
    // while a stale session still holds the old one. With one shared counter
    // the stale release would keep the new connection open forever; counted
    // per browser object, the new connection closes when its own last user
    // exits.
    const context1 = createMockBrowserContext();
    const browser1 = createMockBrowser(context1);
    const context2 = createMockBrowserContext();
    const browser2 = createMockBrowser(context2);
    connectOverCDP.mockResolvedValueOnce(browser1).mockResolvedValueOnce(browser2);

    const config = await resolveConfig({
      browser: { cdpEndpoint: 'http://127.0.0.1:9222' },
    });

    const factory = contextFactory(config);
    const stale = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    // The connection drops externally; the factory's cached browser resets.
    const disconnected = browser1.on.mock.calls.find((call: any[]) => call[0] === 'disconnected')?.[1];
    disconnected?.();

    const fresh = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);
    expect(fresh.browserContext).toBe(context2);

    // The fresh session is the new browser's only user — closing it must
    // close that browser even though the stale session is still around.
    await fresh.close();
    expect(browser2.close).toHaveBeenCalledTimes(1);
    // And the stale release closes its own dead browser, not the new one.
    await stale.close();
    expect(browser1.close).toHaveBeenCalledTimes(1);
    expect(browser2.close).toHaveBeenCalledTimes(1);
  });

  it('keeps the connection open when a session fails while a sibling is still creating', async () => {
    // The reference is claimed before context creation: a sibling still
    // inside _doCreateContext() must count, or a concurrent failure would
    // see zero holders and close the shared connection out from under it.
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    let releaseApply: () => void;
    browserContext.setStorageState.mockImplementationOnce(() => new Promise<void>(resolve => { releaseApply = resolve; }));
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);
    // Session A blocks inside the storage-state apply.
    const pendingA = factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);
    await vi.waitFor(() => expect(browserContext.setStorageState).toHaveBeenCalled());

    // Session B fails context creation while A is still in flight.
    browser.contexts.mockReturnValueOnce([]);
    browser.newContext.mockRejectedValueOnce(new Error('Target.createBrowserContext: Not supported'));
    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow('Target.createBrowserContext');
    expect(browser.close).not.toHaveBeenCalled();

    releaseApply!();
    const resultA = await pendingA;
    await resultA.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('blanks a replacement whose navigation fails, and closes it when even that fails', async () => {
    // The origin may be blocked by the just-installed policy, or the load may
    // simply fail. The fresh tab carries no old identity, so a blank
    // replacement is safe to hand to Context; it is closed only when even
    // blanking fails.
    const pages = [
      createMockPage('https://app.example/ok'),
      createMockPage('https://blocked.example/a'),
      createMockPage('https://dead.example/b'),
    ];
    const browserContext = createMockBrowserContext();
    browserContext.pages.mockReturnValue(pages);
    const fresh: any[] = [];
    browserContext.newPage.mockImplementation(async () => {
      const page = createMockPage('about:blank');
      // Call 0 is the probe; replacements follow in page order.
      const index = fresh.length;
      fresh.push(page);
      if (index === 2)
        page.goto.mockRejectedValueOnce(new Error('net::ERR_BLOCKED_BY_CLIENT')).mockResolvedValueOnce(undefined);
      if (index === 3)
        page.goto.mockRejectedValue(new Error('Target closed'));
      return page;
    });
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);
    await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    // Every old page goes away; the replacement that navigated fine is left
    // alone, the one whose navigation failed is blanked, and the one that
    // could not even blank is closed, so no stale or broken page survives.
    for (const page of pages)
      expect(page.close).toHaveBeenCalledTimes(1);
    expect(fresh[1].goto).toHaveBeenCalledWith('https://app.example/ok');
    expect(fresh[1].close).not.toHaveBeenCalled();
    expect(fresh[2].goto).toHaveBeenCalledWith('about:blank');
    expect(fresh[2].close).not.toHaveBeenCalled();
    expect(fresh[3].goto).toHaveBeenCalledWith('about:blank');
    expect(fresh[3].close).toHaveBeenCalledTimes(1);
  });

  it('applies the storage state once per shared attached context, not once per session', async () => {
    // One attached browser serves every session of a non-isolated CDP factory;
    // a second session re-running the global setStorageState() would wipe the
    // first session's live cookies and origin storage mid-audit.
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);
    const first = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);
    const second = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(first.browserContext).toBe(second.browserContext);
    expect(browserContext.setStorageState).toHaveBeenCalledTimes(1);
  });

  it('lets a later session join the context the fallback created, without resetting it', async () => {
    // The context created for a contextless target already carries the state;
    // a second session finds it as the browser's existing context and must
    // not run the global reset over the first session's live state.
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    browser.contexts.mockReturnValueOnce([]).mockReturnValue([browserContext]);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);
    const first = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);
    const second = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(browser.newContext).toHaveBeenCalledTimes(1);
    expect(first.browserContext).toBe(second.browserContext);
    expect(browserContext.setStorageState).not.toHaveBeenCalled();
  });

  it('shares one fallback context between sessions arriving at a contextless target', async () => {
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    browser.contexts.mockReturnValue([]);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);
    const [first, second] = await Promise.all([
      factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined),
      factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined),
    ]);

    expect(browser.newContext).toHaveBeenCalledTimes(1);
    expect(first.browserContext).toBe(second.browserContext);
  });

  it('retries the shared-context apply for the next session when it failed', async () => {
    // A failed apply must not poison the shared context forever — the memo is
    // dropped so the next session gets a fresh attempt.
    const browserContext = createMockBrowserContext();
    browserContext.setStorageState
        .mockRejectedValueOnce(new Error('Error setting storage state:\nnavigation failed'))
        .mockResolvedValue(undefined);
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);
    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow('navigation failed');
    const result = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    // The retry must target the configured state again (the exact call count
    // is the rollback's business, not this contract's).
    expect(browserContext.setStorageState.mock.lastCall[0]).toEqual(recordedState);
    expect(result.browserContext).toBe(browserContext);
  });

  it('rejects the storage state when the rollback snapshot fails for any other reason', async () => {
    // Without the full snapshot, a partial forward apply could only be rolled
    // back to cookies, leaving origin storage part old, part recorded — so a
    // snapshot failure aborts before anything is mutated.
    const browserContext = createMockBrowserContext();
    browserContext.pages.mockReturnValue([]);
    browserContext.storageState.mockRejectedValue(new Error('Error serializing IndexedDB'));
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow(/rollback failed.*Nothing was changed/);
    expect(browserContext.setStorageState).not.toHaveBeenCalled();
    expect(browserContext.clearCookies).not.toHaveBeenCalled();
  });

  it('does not replace pages when the apply failed and the original state was rolled back', async () => {
    const pages = [createMockPage('https://app.example/a')];
    const browserContext = createMockBrowserContext();
    browserContext.pages.mockReturnValue(pages);
    // Probe page succeeds; the apply itself fails and the rollback runs.
    browserContext.setStorageState
        .mockRejectedValueOnce(new Error('Error setting storage state:\nnavigation failed'))
        .mockResolvedValueOnce(undefined);
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined)).rejects.toThrow();
    // The pages still match the restored original state, so they stay: no
    // close, no replacement (the single newPage call is the probe).
    expect(pages[0].close).not.toHaveBeenCalled();
    expect(browserContext.newPage).toHaveBeenCalledTimes(1);
  });

  it('restores the full original storage state when a partial apply fails', async () => {
    // A multi-origin apply can fail after earlier origins were already
    // overwritten; the cookie jar alone is not enough to undo that. The
    // pre-apply snapshot is replayed through setStorageState itself.
    const originalState = { cookies: [{ name: 'app_session', value: 'original', domain: 'app.example', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [{ origin: 'https://app.example', localStorage: [{ name: 'token', value: 'original' }] }] };
    const browserContext = createMockBrowserContext();
    browserContext.storageState.mockResolvedValue(originalState);
    browserContext.setStorageState
        .mockRejectedValueOnce(new Error('Error setting storage state:\nTarget.createTarget: Not supported'))
        .mockResolvedValueOnce(undefined);
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow(/original storage state was restored/);
    expect(browserContext.setStorageState).toHaveBeenNthCalledWith(2, originalState);
    // The full-state rollback covered the cookies too.
    expect(browserContext.clearCookies).not.toHaveBeenCalled();
  });

  it('rolls the attached cookie jar back when applying the storage state fails midway', async () => {
    // setStorageState replaces the cookies before the origin-restore step that
    // fails on Electron; without a rollback the running app keeps the recorded
    // cookies even though the operation reported failure.
    const originalCookies = [{ name: 'app_session', value: 'original', domain: 'app.example', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }];
    const browserContext = createMockBrowserContext();
    browserContext.cookies.mockResolvedValue(originalCookies);
    browserContext.setStorageState.mockRejectedValue(new Error('Error setting storage state:\nTarget.createTarget: Not supported'));
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow(/original cookies were restored/);
    // Snapshot was taken before the apply, and put back afterwards.
    expect(browserContext.cookies.mock.invocationCallOrder[0]).toBeLessThan(browserContext.setStorageState.mock.invocationCallOrder[0]);
    expect(browserContext.clearCookies).toHaveBeenCalledTimes(1);
    expect(browserContext.addCookies).toHaveBeenCalledWith(originalCookies);
  });

  it('applies the storage state to the reused context when launching over CDP without isolation', async () => {
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    spawnMock.mockReturnValue(createMockChildProcess());
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpLaunch: { command: 'open', port: 9222, startupTimeoutMs: 500 },
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);
    const result = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(browser.newContext).not.toHaveBeenCalled();
    expect(browserContext.setStorageState).toHaveBeenCalledWith(recordedState);
    expect(result.browserContext).toBe(browserContext);
  });

  it('creates a fresh context when the attached CDP browser exposes none', async () => {
    // An attached target can expose zero contexts; dereferencing contexts()[0]
    // unguarded would hand an undefined context to the caller (or TypeError
    // inside the storage-state apply). The VS Code path already falls back to
    // newContext(); the CDP paths do the same.
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    browser.contexts.mockReturnValue([]);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);
    const result = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    // The fresh context receives the configured options — storage state
    // included — directly; the reuse-path apply has nothing to run on.
    expect(browser.newContext).toHaveBeenCalledWith(expect.objectContaining({ storageState: '/tmp/auth.json' }));
    expect(browserContext.setStorageState).not.toHaveBeenCalled();
    expect(result.browserContext).toBe(browserContext);
  });

  it('creates a fresh context when the launched CDP app exposes none', async () => {
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    browser.contexts.mockReturnValue([]);
    spawnMock.mockReturnValue(createMockChildProcess());
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpLaunch: { command: 'open', port: 9222, startupTimeoutMs: 500 },
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);
    const result = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(browser.newContext).toHaveBeenCalledWith(expect.objectContaining({ storageState: '/tmp/auth.json' }));
    expect(browserContext.setStorageState).not.toHaveBeenCalled();
    expect(result.browserContext).toBe(browserContext);
  });

  it('terminates the launched CDP child when obtaining a context fails', async () => {
    // The desktop process is already running once the CDP connection is up; a
    // context-creation failure must not leave it running with no close() holder.
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    browser.newContext.mockRejectedValue(new Error('ENOENT: no such file /tmp/auth.json'));
    const childProcess = createMockChildProcess();
    spawnMock.mockReturnValue(childProcess);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        isolated: true,
        cdpLaunch: { command: 'open', port: 9222, startupTimeoutMs: 500 },
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow('ENOENT');
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(childProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('applies the storage state to isolated CDP attach sessions', async () => {
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        isolated: true,
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);
    await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(browser.newContext).toHaveBeenCalledWith(expect.objectContaining({ storageState: '/tmp/auth.json' }));
  });

  it('applies the storage state to isolated CDP launch sessions', async () => {
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    spawnMock.mockReturnValue(createMockChildProcess());
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        isolated: true,
        cdpLaunch: { command: 'open', port: 9222, startupTimeoutMs: 500 },
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);
    await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(browser.newContext).toHaveBeenCalledWith(expect.objectContaining({ storageState: '/tmp/auth.json' }));
  });

  it('applies the storage state to remote browser sessions', async () => {
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    (playwright.chromium.connect as any).mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        remoteEndpoint: 'ws://127.0.0.1:3000/',
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);
    await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(browser.newContext).toHaveBeenCalledWith(expect.objectContaining({ storageState: '/tmp/auth.json' }));
  });

  it('applies the storage state to isolated browser contexts', async () => {
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    (playwright.chromium.launch as any).mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        isolated: true,
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);
    await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(browser.newContext).toHaveBeenCalledWith(expect.objectContaining({ storageState: '/tmp/auth.json' }));
  });

  // --extension runs every tool through ExtensionContextFactory whatever
  // contextFactory() built, so --isolated must not talk it past the guard.
  it('rejects a storage state the extension factory would silently drop, even with --isolated', async () => {
    const config = await resolveConfig({
      browser: {
        isolated: true,
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });
    const extensionFactory = new ExtensionContextFactory('chrome', undefined, undefined);

    expect(() => contextFactory(config)).not.toThrow();
    expect(() => assertStorageStateSupported(config, extensionFactory, 'remedy'))
        .toThrow('Storage state cannot be applied in this mode');
  });

  it('flags the profile conflict only when both a storage state and a user profile are set', async () => {
    const both = await resolveConfig({
      browser: { userDataDir: '/home/user/my-profile', contextOptions: { storageState: '/tmp/auth.json' } },
    });
    const stateOnly = await resolveConfig({
      browser: { contextOptions: { storageState: '/tmp/auth.json' } },
    });
    const profileOnly = await resolveConfig({
      browser: { userDataDir: '/home/user/my-profile' },
    });

    expect(() => assertStorageStateDoesNotResetUserProfile(both, 'Drop one of them.'))
        .toThrow(/--storage-state and --user-data-dir contradict each other.*Drop one of them\./);
    expect(() => assertStorageStateDoesNotResetUserProfile(stateOnly, 'remedy')).not.toThrow();
    expect(() => assertStorageStateDoesNotResetUserProfile(profileOnly, 'remedy')).not.toThrow();
  });
});

describe('VSCodeBrowserContextFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createVSCodePlaywright(browser: any) {
    return { chromium: { connect: vi.fn().mockResolvedValue(browser) } } as any;
  }

  it('rejects a storage state aimed at a user-supplied profile before connecting', async () => {
    // The configured --user-data-dir is forwarded to the extension's launch,
    // so the reused context lives inside the user's own profile — the same
    // profile the persistent factory refuses to reset to a recorded state.
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    const vscodePlaywright = createVSCodePlaywright(browser);
    const config = await resolveConfig({
      browser: {
        userDataDir: '/home/user/my-profile',
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = new VSCodeBrowserContextFactory(config, vscodePlaywright, 'ws://127.0.0.1:1234/');

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal))
        .rejects.toThrow('--storage-state and --user-data-dir contradict each other');
    expect(vscodePlaywright.chromium.connect).not.toHaveBeenCalled();
    expect(browserContext.setStorageState).not.toHaveBeenCalled();
  });

  it('applies the storage state to the context the extension already holds', async () => {
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    const vscodePlaywright = createVSCodePlaywright(browser);
    const config = await resolveConfig({
      browser: {
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = new VSCodeBrowserContextFactory(config, vscodePlaywright, 'ws://127.0.0.1:1234/');
    const result = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal);

    expect(browser.newContext).not.toHaveBeenCalled();
    expect(browserContext.setStorageState).toHaveBeenCalledWith(recordedState);
    expect(result.browserContext).toBe(browserContext);
  });

  it('closes the extension connection when applying the storage state fails', async () => {
    const browserContext = createMockBrowserContext();
    browserContext.setStorageState.mockRejectedValueOnce(new Error('Error setting storage state:\nnavigation failed'));
    const browser = createMockBrowser(browserContext);
    const vscodePlaywright = createVSCodePlaywright(browser);
    const config = await resolveConfig({
      browser: {
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = new VSCodeBrowserContextFactory(config, vscodePlaywright, 'ws://127.0.0.1:1234/');

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal))
        .rejects.toThrow('navigation failed');
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});
