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
      createMockPage('https://app.example/a'),
      createMockPage('https://app.example/b'),
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

  it('mirrors the configured network policy around the reloads of reused pages', async () => {
    // The reloads run inside the factory, before Context installs the origin
    // allowlist/blocklist — with the recorded credentials already applied, the
    // first navigation must not be able to reach a blocked origin.
    const pages = [createMockPage('https://app.example/a')];
    const browserContext = createMockBrowserContext();
    browserContext.pages.mockReturnValue(pages);
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: '/tmp/auth.json' },
      },
      network: { blockedOrigins: ['tracker.example'] },
    });

    const factory = contextFactory(config);
    await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    // Routes go in after the state is applied (so they cannot interfere with
    // the temporary page Playwright drives) and before the reloads — and they
    // STAY: page scripts can queue requests that fire after the reload
    // settles, so removing the handlers before Context re-ensures the same
    // policy would open a window to a blocked origin.
    expect(browserContext.route).toHaveBeenCalledWith('*://tracker.example/**', expect.any(Function));
    expect(browserContext.route.mock.invocationCallOrder[0]).toBeGreaterThan(browserContext.setStorageState.mock.invocationCallOrder[0]);
    expect(browserContext.route.mock.invocationCallOrder[0]).toBeLessThan(pages[0].reload.mock.invocationCallOrder[0]);
    expect(browserContext.unroute).not.toHaveBeenCalled();
    expect(browserContext.unrouteAll).not.toHaveBeenCalled();
  });

  it('leaves routing untouched around the reloads when no network policy is configured', async () => {
    const pages = [createMockPage('https://app.example/a')];
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

    expect(pages[0].reload).toHaveBeenCalledTimes(1);
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
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow(/origins this connection has already visited.*Nothing was changed/);
    expect(browserContext.setStorageState).not.toHaveBeenCalled();
    expect(browserContext.clearCookies).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('clears sessionStorage in every frame before reloading a reused page', async () => {
    // Per-tab sessionStorage sits outside Playwright storage states and
    // survives a reload; an application can rebuild the previous identity's
    // UI from it, so it must be gone before the page comes back up.
    const frames = [
      { evaluate: vi.fn().mockResolvedValue(undefined) },
      { evaluate: vi.fn().mockResolvedValue(undefined) },
    ];
    const pages = [{ url: () => 'https://app.example/a', frames: vi.fn().mockReturnValue(frames), reload: vi.fn().mockResolvedValue(undefined) }];
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

    for (const frame of frames) {
      expect(frame.evaluate).toHaveBeenCalledTimes(1);
      expect(frame.evaluate.mock.invocationCallOrder[0]).toBeLessThan(pages[0].reload.mock.invocationCallOrder[0]);
    }
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
    { label: 'bad sameSite', cookie: { name: 'sid', value: 'x', domain: 'app.example', path: '/', sameSite: 'Sideways' }, problem: /Strict\|Lax\|None/ },
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
        contextOptions: { storageState: '/tmp/auth.json' },
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

  it('blanks pages whose reload fails, and closes them when even that fails', async () => {
    // A page that cannot be brought onto the installed state must not stay
    // around rendering the previous identity's DOM — Context adopts every
    // remaining page and a scan would read the stale document as the new
    // session's UI.
    const pages = [
      createMockPage('https://app.example/ok'),
      createMockPage('https://blocked.example/a', { reload: vi.fn().mockRejectedValue(new Error('net::ERR_BLOCKED_BY_CLIENT')) }),
      createMockPage('https://dead.example/b', { reload: vi.fn().mockRejectedValue(new Error('Target closed')), goto: vi.fn().mockRejectedValue(new Error('Target closed')) }),
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

    // Reloaded fine: left alone. Reload failed: blanked. Blanking failed too:
    // closed, so no stale-identity page survives in any case.
    expect(pages[0].goto).not.toHaveBeenCalled();
    expect(pages[0].close).not.toHaveBeenCalled();
    expect(pages[1].goto).toHaveBeenCalledWith('about:blank');
    expect(pages[1].close).not.toHaveBeenCalled();
    expect(pages[2].goto).toHaveBeenCalledWith('about:blank');
    expect(pages[2].close).toHaveBeenCalledTimes(1);
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
        contextOptions: { storageState: '/tmp/auth.json' },
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
        .mockRejectedValueOnce(new Error('ENOENT: no such file /tmp/auth.json'))
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
        .rejects.toThrow('ENOENT');
    const result = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    // The retry must target the configured state again (the exact call count
    // is the rollback's business, not this contract's).
    expect(browserContext.setStorageState.mock.lastCall[0]).toBe('/tmp/auth.json');
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
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow(/rollback failed.*Nothing was changed/);
    expect(browserContext.setStorageState).not.toHaveBeenCalled();
    expect(browserContext.clearCookies).not.toHaveBeenCalled();
  });

  it('does not reload pages when the apply failed and the original state was rolled back', async () => {
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
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = new VSCodeBrowserContextFactory(config, vscodePlaywright, 'ws://127.0.0.1:1234/');
    const result = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal);

    expect(browser.newContext).not.toHaveBeenCalled();
    expect(browserContext.setStorageState).toHaveBeenCalledWith('/tmp/auth.json');
    expect(result.browserContext).toBe(browserContext);
  });

  it('closes the extension connection when applying the storage state fails', async () => {
    const browserContext = createMockBrowserContext();
    browserContext.setStorageState.mockRejectedValue(new Error('ENOENT: no such file /tmp/auth.json'));
    const browser = createMockBrowser(browserContext);
    const vscodePlaywright = createVSCodePlaywright(browser);
    const config = await resolveConfig({
      browser: {
        contextOptions: { storageState: '/tmp/auth.json' },
      },
    });

    const factory = new VSCodeBrowserContextFactory(config, vscodePlaywright, 'ws://127.0.0.1:1234/');

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal))
        .rejects.toThrow('ENOENT');
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});
