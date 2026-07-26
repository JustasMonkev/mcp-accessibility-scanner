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
import { assertStorageStateSupported, contextFactory } from '../src/browserContextFactory.js';
import { ExtensionContextFactory } from '../src/extension/extensionContextFactory.js';
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
    route: vi.fn().mockResolvedValue(undefined),
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
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);
    const result = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(browser.newContext).not.toHaveBeenCalled();
    expect(browserContext.setStorageState).toHaveBeenCalledWith('/tmp/auth.json');
    expect(result.browserContext).toBe(browserContext);
  });

  it('disconnects from the CDP browser when applying the storage state fails on attach', async () => {
    const browserContext = createMockBrowserContext();
    browserContext.setStorageState.mockRejectedValue(new Error('ENOENT: no such file /tmp/auth.json'));
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow('ENOENT');
    expect(browser.close).toHaveBeenCalledTimes(1);
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
        contextOptions: { storageState: '/tmp/auth.json' },
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
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow(/Nothing was changed/);
    expect(browserContext.setStorageState).not.toHaveBeenCalled();
    expect(browserContext.clearCookies).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('reloads already-open pages after installing the storage state, and only then', async () => {
    // A reused page still renders the previous identity's DOM; an immediate
    // scan would audit the wrong user unless the page is brought onto the
    // freshly installed state.
    const pages = [
      { url: () => 'https://app.example/a', reload: vi.fn().mockResolvedValue(undefined) },
      { url: () => 'https://app.example/b', reload: vi.fn().mockResolvedValue(undefined) },
    ];
    const browserContext = createMockBrowserContext();
    browserContext.pages.mockReturnValue(pages);
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);
    await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    for (const page of pages) {
      expect(page.reload).toHaveBeenCalledTimes(1);
      expect(page.reload.mock.invocationCallOrder[0]).toBeGreaterThan(browserContext.setStorageState.mock.invocationCallOrder[0]);
    }
  });

  it('does not reload pages when the apply failed and the original state was rolled back', async () => {
    const pages = [{ url: () => 'https://app.example/a', reload: vi.fn().mockResolvedValue(undefined) }];
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
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined)).rejects.toThrow();
    // The pages still match the restored original state, so no reload.
    expect(pages[0].reload).not.toHaveBeenCalled();
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
        contextOptions: { storageState: '/tmp/auth.json' },
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
        contextOptions: { storageState: '/tmp/auth.json' },
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
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);
    const result = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(browser.newContext).not.toHaveBeenCalled();
    expect(browserContext.setStorageState).toHaveBeenCalledWith('/tmp/auth.json');
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
});
