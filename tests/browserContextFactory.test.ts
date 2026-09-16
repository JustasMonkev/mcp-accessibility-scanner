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
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connectOverCDP, spawnMock, startTraceViewerServerMock } = vi.hoisted(() => ({
  connectOverCDP: vi.fn(),
  spawnMock: vi.fn(),
  startTraceViewerServerMock: vi.fn(async () => ({ urlPrefix: () => 'http://127.0.0.1:0' })),
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

// The trace-viewer server binds a real listening socket; tests spy on the
// start instead. The registry directory (the fallback profile root when
// PWMCP_PROFILES_DIR_FOR_TEST is unset) is pointed into the temp dir so tests
// never touch the real Playwright registry.
vi.mock('playwright-core/lib/coreBundle', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    default: {
      registry: { registryDirectory: path.join(os.tmpdir(), 'mcp-a11y-test-registry'), registry: {} },
      server: { startTraceViewerServer: startTraceViewerServerMock },
      iso: { asLocator: () => '' },
    },
  };
});

import * as playwright from 'playwright';
import { assertStorageStateDoesNotResetUserProfile, assertStorageStateSupported, contextFactory } from '../src/browserContextFactory.js';
import { ExtensionContextFactory } from '../src/extension/extensionContextFactory.js';
import { VSCodeBrowserContextFactory } from '../src/vscode/browserContextFactory.js';
import { resolveConfig } from '../src/config.js';
import { createHash } from '../src/utils/guid.js';

// The stable persistent profile is discriminated per workspace by a hash of
// the server's own working directory (see _createUserDataDir).
const stableProfileName = () => `mcp-chrome-${createHash(process.cwd())}`;

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

  it.each([
    { mode: 'attach', browser: { cdpEndpoint: 'http://127.0.0.1:9222' } },
    { mode: 'launch', browser: { cdpLaunch: { command: 'open', port: 9222, startupTimeoutMs: 500 } } },
  ])('rejects storage imports into existing CDP $mode contexts before capture or mutation', async ({ browser: browserOptions }) => {
    const page = createMockPage('https://app.example');
    const browserContext = createMockBrowserContext();
    browserContext.pages.mockReturnValue([page]);
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);
    spawnMock.mockImplementation(createMockChildProcess);
    // Cookie-only states are also unsafe: capture can visit previously seen origins.
    for (const storageState of ['/missing/auth.json', { cookies: [], origins: [] }]) {
      const config = await resolveConfig({ browser: { ...browserOptions, contextOptions: { storageState } } });
      await expect(contextFactory(config).createContext({ name: 'vitest' }, new AbortController().signal, undefined))
          .rejects.toThrow(/Cannot apply --storage-state.*existing browser context.*No storage snapshot or reset/);
    }
    expect(browserContext.storageState).not.toHaveBeenCalled();
    expect(browserContext.setStorageState).not.toHaveBeenCalled();
    expect(browserContext.clearCookies).not.toHaveBeenCalled();
    expect(browserContext.newPage).not.toHaveBeenCalled();
    expect(browserContext.close).not.toHaveBeenCalled();
    expect(page.close).not.toHaveBeenCalled();
    expect(page.goto).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(2);
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

  it('never hands two concurrent --cdp-launch sessions the same endpoint', async () => {
    // findFreePort()'s probe socket closes before the launched child binds the
    // port, so the OS can offer the same port to a concurrent session's probe
    // — both connect loops would then attach to whichever child bound first,
    // sharing its context and killing the wrong child on cleanup. Simulated by
    // an OS that offers port 9400 twice: the in-process reservation must make
    // the second session retry and launch on 9401 instead.
    const probePorts = [9400, 9400, 9401];
    let probeIndex = 0;
    const probeSpy = vi.spyOn(net, 'createServer').mockImplementation((() => {
      const port = probePorts[Math.min(probeIndex++, probePorts.length - 1)];
      return {
        listen: (_port: number, callback: () => void) => callback(),
        address: () => ({ port }),
        close: (callback?: () => void) => callback?.(),
        on: () => {},
      };
    }) as any);
    try {
      const contextA = createMockBrowserContext();
      const contextB = createMockBrowserContext();
      const browserA = createMockBrowser(contextA);
      const browserB = createMockBrowser(contextB);
      spawnMock.mockImplementation(() => createMockChildProcess());
      // Session A's connect stays pending, so its port is still unbound — and
      // must still be reserved — while session B allocates its own.
      let releaseA: (browser: any) => void;
      connectOverCDP
          .mockImplementationOnce(() => new Promise(resolve => { releaseA = resolve; }))
          .mockResolvedValueOnce(browserB);

      const config = await resolveConfig({
        browser: {
          isolated: true,
          cdpLaunch: { command: 'open', args: ['--remote-debugging-port={port}'], startupTimeoutMs: 500 },
        },
      });
      const factory = contextFactory(config);
      const clientInfo = { name: 'vitest', version: '1.0.0' };
      const signal = new AbortController().signal;

      const pendingA = factory.createContext(clientInfo, signal, undefined);
      await vi.waitFor(() => expect(connectOverCDP).toHaveBeenCalledWith('http://127.0.0.1:9400', expect.anything()));

      const sessionB = await factory.createContext(clientInfo, signal, undefined);
      releaseA!(browserA);
      const sessionA = await pendingA;

      expect(spawnMock).toHaveBeenCalledWith('open', ['--remote-debugging-port=9400'], expect.anything());
      expect(spawnMock).toHaveBeenCalledWith('open', ['--remote-debugging-port=9401'], expect.anything());
      expect(connectOverCDP).toHaveBeenCalledWith('http://127.0.0.1:9401', expect.anything());

      await sessionA.close();
      await sessionB.close();
    } finally {
      probeSpy.mockRestore();
    }
  });

  it('releases an allocated --cdp-launch port for reuse once its child has bound it', async () => {
    // The reservation exists only to bridge the probe-to-bind window; once a
    // session's connect succeeded (or its launch failed), the OS itself keeps
    // the port from being re-offered while bound, and holding the number
    // reserved forever would slowly drain the pool on a long-lived server.
    const probePorts = [9400];
    const probeSpy = vi.spyOn(net, 'createServer').mockImplementation((() => ({
      listen: (_port: number, callback: () => void) => callback(),
      address: () => ({ port: probePorts[0] }),
      close: (callback?: () => void) => callback?.(),
      on: () => {},
    })) as any);
    try {
      const browserContext = createMockBrowserContext();
      const browser = createMockBrowser(browserContext);
      spawnMock.mockImplementation(() => createMockChildProcess());
      connectOverCDP.mockResolvedValue(browser);

      const config = await resolveConfig({
        browser: {
          isolated: true,
          cdpLaunch: { command: 'open', args: ['--remote-debugging-port={port}'], startupTimeoutMs: 500 },
        },
      });
      const factory = contextFactory(config);
      const clientInfo = { name: 'vitest', version: '1.0.0' };
      const signal = new AbortController().signal;

      const first = await factory.createContext(clientInfo, signal, undefined);
      await first.close();
      // The same port coming back from the OS after the first session is done
      // must be usable again, not skipped as still-reserved.
      const second = await factory.createContext(clientInfo, signal, undefined);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(spawnMock).toHaveBeenLastCalledWith('open', ['--remote-debugging-port=9400'], expect.anything());
      await second.close();
    } finally {
      probeSpy.mockRestore();
    }
  });

  it('rejects a second concurrent context on a pinned --cdp-launch-port instead of cross-attaching', async () => {
    // The sessionsUnsupportedReason veto covers browser_session_open only;
    // parallel handshake-free HTTP requests reach the launch path through
    // their per-request DEFAULT contexts. The second child could never bind
    // the busy pinned port, so its connect loop would attach to the FIRST
    // child's endpoint — its "own" context landing in a sibling's
    // application, its cleanup killing a child that owns nothing.
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    const childA = createMockChildProcess();
    const childB = createMockChildProcess();
    spawnMock.mockReturnValueOnce(childA).mockReturnValue(childB);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        isolated: true,
        cdpLaunch: { command: 'open', args: ['--remote-debugging-port={port}'], port: 9222, startupTimeoutMs: 500 },
      },
    });
    const factory = contextFactory(config);
    const clientInfo = { name: 'vitest', version: '1.0.0' };
    const signal = new AbortController().signal;

    const first = await factory.createContext(clientInfo, signal, undefined);
    await expect(factory.createContext(clientInfo, signal, undefined))
        .rejects.toThrow(/pinned --cdp-launch-port 9222 already serves a launched application/);
    // The doomed launch was refused before spawning another child.
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Once the first context is gone (mock kill emits exit), the pinned port
    // serves the next context again.
    await first.close();
    expect(childA.kill).toHaveBeenCalledWith('SIGTERM');
    const second = await factory.createContext(clientInfo, signal, undefined);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    await second.close();
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

  // Two explicit browser sessions under the default persistent config used to
  // resolve to the same `mcp-<browser>` profile: one locked it, the second
  // spun on ProcessSingleton and failed with "Browser is already in use".
  it('gives each explicit browser session its own disposable profile while the default context keeps the stable one', async () => {
    const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-profiles-'));
    process.env.PWMCP_PROFILES_DIR_FOR_TEST = profilesDir;
    try {
      const browserContext = createMockBrowserContext();
      (playwright.chromium.launchPersistentContext as any).mockResolvedValue(browserContext);
      const rmSpy = vi.spyOn(fs.promises, 'rm');

      const config = await resolveConfig({});
      const factory = contextFactory(config);
      expect(factory.sessionsUnsupportedReason).toBeUndefined();

      const clientInfo = { name: 'vitest', version: '1.0.0' };
      const signal = new AbortController().signal;
      const defaultResult = await factory.createContext(clientInfo, signal, undefined);
      const first = await factory.createContext(clientInfo, signal, undefined, { browserSession: true });
      const second = await factory.createContext(clientInfo, signal, undefined, { browserSession: true });

      const dirs = (playwright.chromium.launchPersistentContext as any).mock.calls.map((call: any[]) => call[0] as string);
      // The default context keeps the stable profile so sign-in state still
      // survives restarts; each session gets a fresh guid-suffixed one.
      expect(dirs[0]).toBe(path.join(profilesDir, stableProfileName()));
      expect(dirs[1]).toMatch(/-session-[0-9a-f]+$/);
      expect(dirs[2]).toMatch(/-session-[0-9a-f]+$/);
      expect(dirs[1]).not.toBe(dirs[2]);

      // Session profiles are removed with their contexts; the stable profile
      // is durable user data and must never be deleted.
      await first.close();
      expect(rmSpy).toHaveBeenCalledWith(dirs[1], { recursive: true, force: true });
      await second.close();
      expect(rmSpy).toHaveBeenCalledWith(dirs[2], { recursive: true, force: true });
      await defaultResult.close();
      expect(rmSpy).not.toHaveBeenCalledWith(dirs[0], expect.anything());
    } finally {
      delete process.env.PWMCP_PROFILES_DIR_FOR_TEST;
      fs.rmSync(profilesDir, { recursive: true, force: true });
    }
  });

  // Each stateful HTTP client's backend builds its own default context, and
  // they all used to resolve to the stable mcp-<browser> profile: the second
  // concurrent client spun on Chromium's ProcessSingleton lock and failed
  // with "Browser is already in use".
  it('hands the stable profile to the first default context and a disposable fallback to a concurrent second', async () => {
    const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-profiles-'));
    process.env.PWMCP_PROFILES_DIR_FOR_TEST = profilesDir;
    try {
      const launchedDirs = new Map<any, string>();
      (playwright.chromium.launchPersistentContext as any).mockImplementation(async (dir: string) => {
        const browserContext = createMockBrowserContext();
        launchedDirs.set(browserContext, dir);
        return browserContext;
      });
      const rmSpy = vi.spyOn(fs.promises, 'rm');

      const config = await resolveConfig({});
      const factory = contextFactory(config);
      const clientInfo = { name: 'vitest', version: '1.0.0' };
      const signal = new AbortController().signal;

      // Two concurrent default contexts: both must succeed instead of one
      // erroring on the profile lock.
      const [first, second] = await Promise.all([
        factory.createContext(clientInfo, signal, undefined),
        factory.createContext(clientInfo, signal, undefined),
      ]);

      const stableDir = path.join(profilesDir, stableProfileName());
      const dirs = [launchedDirs.get(first.browserContext)!, launchedDirs.get(second.browserContext)!];
      expect(dirs.filter(dir => dir === stableDir)).toHaveLength(1);
      const disposableDir = dirs.find(dir => dir !== stableDir)!;
      expect(disposableDir).toMatch(/-concurrent-[0-9a-f]+$/);

      // Closing the stable holder frees the claim: the next default context
      // gets the stable profile — and its sign-in state — back.
      const stableHolder = dirs[0] === stableDir ? first : second;
      const disposableHolder = stableHolder === first ? second : first;
      await stableHolder.close();
      const third = await factory.createContext(clientInfo, signal, undefined);
      expect(launchedDirs.get(third.browserContext)).toBe(stableDir);

      // The fallback profile is disposable and removed with its context; the
      // stable profile is durable and never deleted.
      await disposableHolder.close();
      expect(rmSpy).toHaveBeenCalledWith(disposableDir, { recursive: true, force: true });
      await third.close();
      expect(rmSpy).not.toHaveBeenCalledWith(stableDir, expect.anything());
    } finally {
      delete process.env.PWMCP_PROFILES_DIR_FOR_TEST;
      fs.rmSync(profilesDir, { recursive: true, force: true });
    }
  });

  // A --connect-tool/--vscode provider switch-away starts an async close
  // whose cleanup (the Context's bounded pending-download drain) can still be
  // running when the user switches back: the new default context used to be
  // misclassified as concurrent and silently demoted to a -concurrent-
  // disposable profile, losing the stable profile's sign-in state.
  it('hands the stable profile to a default context arriving while the previous holder is closing', async () => {
    const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-profiles-'));
    process.env.PWMCP_PROFILES_DIR_FOR_TEST = profilesDir;
    try {
      const launchedDirs = new Map<any, string>();
      (playwright.chromium.launchPersistentContext as any).mockImplementation(async (dir: string) => {
        const browserContext = createMockBrowserContext();
        launchedDirs.set(browserContext, dir);
        return browserContext;
      });

      const config = await resolveConfig({});
      const factory = contextFactory(config);
      const clientInfo = { name: 'vitest', version: '1.0.0' };
      const signal = new AbortController().signal;
      const stableDir = path.join(profilesDir, stableProfileName());

      const holder = await factory.createContext(clientInfo, signal, undefined);
      expect(launchedDirs.get(holder.browserContext)).toBe(stableDir);
      expect(holder.closeStarting).toBeDefined();

      // The holder announces its close (the Context does this ahead of the
      // download drain) and begins a shutdown that stays in flight.
      let finishShutdown = () => {};
      (holder.browserContext.close as any).mockImplementation(() => new Promise<void>(resolve => { finishShutdown = resolve; }));
      holder.closeStarting!();
      const closing = holder.close();

      // A default claimant arriving mid-close is a successor, not genuine
      // concurrency: it must wait for the release instead of launching into
      // a disposable profile...
      const pendingSuccessor = factory.createContext(clientInfo, signal, undefined);
      for (let i = 0; i < 10; i++)
        await Promise.resolve();
      expect((playwright.chromium.launchPersistentContext as any).mock.calls).toHaveLength(1);

      // ...and it gets the STABLE profile once the close completes.
      finishShutdown();
      await closing;
      const successor = await pendingSuccessor;
      expect(launchedDirs.get(successor.browserContext)).toBe(stableDir);
      await successor.close();
    } finally {
      delete process.env.PWMCP_PROFILES_DIR_FOR_TEST;
      fs.rmSync(profilesDir, { recursive: true, force: true });
    }
  });

  // _createUserDataDir's mkdir can reject (a transient volume failure) after
  // the stable-profile claim was set and the CDP port reserved but before the
  // launch loop's cleanup scope: both used to leak — every later default
  // context was misclassified as concurrent (disposable profiles, losing the
  // stable profile's sign-in state, forever) and the reserved port was never
  // returned to the pool.
  it('releases the stable-profile claim and the reserved CDP port when profile-dir creation fails', async () => {
    const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-profiles-'));
    process.env.PWMCP_PROFILES_DIR_FOR_TEST = profilesDir;
    // A deterministic port pool: every allocation is offered the same OS
    // port, so a leaked reservation makes the next allocation spin on the
    // reserved-ports check instead of completing.
    const createServerSpy = vi.spyOn(net, 'createServer').mockImplementation((() => {
      const server: any = new EventEmitter();
      server.listen = (_port: number, cb: () => void) => { setImmediate(cb); return server; };
      server.address = () => ({ port: 45678 });
      server.close = (cb?: () => void) => { cb && setImmediate(cb); return server; };
      return server;
    }) as any);
    try {
      (playwright.chromium.launchPersistentContext as any).mockImplementation(async () => createMockBrowserContext());
      const config = await resolveConfig({});
      const factory = contextFactory(config);
      const clientInfo = { name: 'vitest', version: '1.0.0' };
      const signal = new AbortController().signal;

      vi.spyOn(fs.promises, 'mkdir').mockRejectedValueOnce(new Error('EIO: volume unavailable'));
      await expect(factory.createContext(clientInfo, signal, undefined)).rejects.toThrow('EIO: volume unavailable');

      // The failed attempt released both: the next default context allocates
      // the same port again (instead of spinning on a leaked reservation) and
      // gets the stable profile (instead of a -concurrent- fallback).
      const result = await factory.createContext(clientInfo, signal, undefined);
      expect((playwright.chromium.launchPersistentContext as any).mock.calls[0][0])
          .toBe(path.join(profilesDir, stableProfileName()));
      await result.close();
    } finally {
      createServerSpy.mockRestore();
      delete process.env.PWMCP_PROFILES_DIR_FOR_TEST;
      fs.rmSync(profilesDir, { recursive: true, force: true });
    }
  });

  // Dropping the MCP Roots hash (the old per-client-root profile token) must
  // not collapse every workspace's server onto one bare `mcp-<browser>`
  // profile: separate server processes would contend on Chromium's
  // ProcessSingleton lock and sequential workspaces would inherit each
  // other's cookies and storage. The stable profile is discriminated by a
  // hash of the server's own cwd instead — deterministic across restarts of
  // the same workspace (sign-in state survives), different across workspaces.
  it('keys the stable profile on the workspace cwd: stable across restarts, distinct across workspaces', async () => {
    const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-profiles-'));
    process.env.PWMCP_PROFILES_DIR_FOR_TEST = profilesDir;
    try {
      const browserContext = createMockBrowserContext();
      (playwright.chromium.launchPersistentContext as any).mockResolvedValue(browserContext);

      const clientInfo = { name: 'vitest', version: '1.0.0' };
      const signal = new AbortController().signal;
      const launchedDir = (call: number) =>
        (playwright.chromium.launchPersistentContext as any).mock.calls[call][0] as string;

      // Restart parity: a fresh factory built from the same config in the
      // same workspace resolves to the same directory, so the profile's
      // sign-in state survives a server restart.
      const first = await contextFactory(await resolveConfig({})).createContext(clientInfo, signal, undefined);
      await first.close();
      const second = await contextFactory(await resolveConfig({})).createContext(clientInfo, signal, undefined);
      await second.close();
      expect(launchedDir(0)).toBe(path.join(profilesDir, `mcp-chrome-${createHash(process.cwd())}`));
      expect(launchedDir(1)).toBe(launchedDir(0));

      // A server launched for another workspace (different cwd) gets its own
      // profile: no ProcessSingleton contention, no inherited cookies.
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(path.join(os.tmpdir(), 'some-other-workspace'));
      try {
        const other = await contextFactory(await resolveConfig({})).createContext(clientInfo, signal, undefined);
        await other.close();
      } finally {
        cwdSpy.mockRestore();
      }
      expect(launchedDir(2)).toBe(path.join(profilesDir, `mcp-chrome-${createHash(path.join(os.tmpdir(), 'some-other-workspace'))}`));
      expect(launchedDir(2)).not.toBe(launchedDir(0));
    } finally {
      delete process.env.PWMCP_PROFILES_DIR_FOR_TEST;
      fs.rmSync(profilesDir, { recursive: true, force: true });
    }
  });

  it('starts one trace-viewer server per config and shares it across launches', async () => {
    // With --save-trace in persistent mode every launch used to call
    // startTraceViewerServer(), leaking one listening HTTP server per
    // explicit-session open/close cycle for the life of the process.
    const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-profiles-'));
    process.env.PWMCP_PROFILES_DIR_FOR_TEST = profilesDir;
    try {
      (playwright.chromium.launchPersistentContext as any).mockImplementation(async () => createMockBrowserContext());

      const config = await resolveConfig({ saveTrace: true });
      const factory = contextFactory(config);
      const clientInfo = { name: 'vitest', version: '1.0.0' };
      const signal = new AbortController().signal;

      const first = await factory.createContext(clientInfo, signal, undefined, { browserSession: true });
      await first.close();
      const second = await factory.createContext(clientInfo, signal, undefined, { browserSession: true });
      await second.close();

      expect(startTraceViewerServerMock).toHaveBeenCalledTimes(1);
      // Both launches record into the one traces directory; per-context trace
      // names keep the files apart (see acquireTrace in context.ts).
      const tracesDirs = (playwright.chromium.launchPersistentContext as any).mock.calls
          .map((call: any[]) => call[1]?.tracesDir as string | undefined);
      expect(tracesDirs[0]).toMatch(/traces-/);
      expect(tracesDirs[1]).toBe(tracesDirs[0]);
    } finally {
      delete process.env.PWMCP_PROFILES_DIR_FOR_TEST;
      fs.rmSync(profilesDir, { recursive: true, force: true });
    }
  });

  it('gives concurrent persistent launches distinct per-launch CDP ports', async () => {
    // injectCdpPort() used to write the allocated port into the SHARED
    // config.browser.launchOptions; the awaits between allocation and
    // launchPersistentContext() let a concurrent session overwrite it, so
    // both browsers raced for one port and one failed to bind. The port now
    // travels in per-launch options and the shared config stays untouched.
    const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a11y-profiles-'));
    process.env.PWMCP_PROFILES_DIR_FOR_TEST = profilesDir;
    try {
      const launchGates: Array<(context: any) => void> = [];
      (playwright.chromium.launchPersistentContext as any).mockImplementation(
          () => new Promise(resolve => launchGates.push(resolve)));

      const config = await resolveConfig({});
      const factory = contextFactory(config);
      const clientInfo = { name: 'vitest', version: '1.0.0' };
      const signal = new AbortController().signal;

      // Both sessions allocate their port and reach the (gated) launch before
      // either resolves — the overwrite window of the old shared-config path.
      const pendingA = factory.createContext(clientInfo, signal, undefined, { browserSession: true });
      const pendingB = factory.createContext(clientInfo, signal, undefined, { browserSession: true });
      await vi.waitFor(() => expect(launchGates.length).toBe(2));

      const ports = (playwright.chromium.launchPersistentContext as any).mock.calls
          .map((call: any[]) => call[1]?.cdpPort as number | undefined);
      expect(ports[0]).toEqual(expect.any(Number));
      expect(ports[1]).toEqual(expect.any(Number));
      expect(ports[0]).not.toBe(ports[1]);
      // The allocation never leaks into the shared config.
      expect((config.browser.launchOptions as any)?.cdpPort).toBeUndefined();

      launchGates.forEach(release => release(createMockBrowserContext()));
      await Promise.all([pendingA, pendingB]);
    } finally {
      delete process.env.PWMCP_PROFILES_DIR_FOR_TEST;
      fs.rmSync(profilesDir, { recursive: true, force: true });
    }
  });

  it('reports which modes cannot mint separate per-session contexts', async () => {
    // Shared-context modes must veto browser_session_open instead of handing
    // out a handle that silently routes into everyone else's context.
    const nonIsolatedCdp = contextFactory(await resolveConfig({ browser: { cdpEndpoint: 'http://127.0.0.1:9222' } }));
    expect(nonIsolatedCdp.sessionsUnsupportedReason).toContain('--isolated');

    const isolatedCdp = contextFactory(await resolveConfig({ browser: { cdpEndpoint: 'http://127.0.0.1:9222', isolated: true } }));
    expect(isolatedCdp.sessionsUnsupportedReason).toBeUndefined();

    const nonIsolatedLaunch = contextFactory(await resolveConfig({ browser: { cdpLaunch: { command: 'open' } } }));
    expect(nonIsolatedLaunch.sessionsUnsupportedReason).toContain('--isolated');

    // Even with --isolated, a pinned port launches every session's app on the
    // same endpoint — the second session would attach to the first session's
    // instance instead of its own.
    const pinnedPortLaunch = contextFactory(await resolveConfig({ browser: { cdpLaunch: { command: 'open', port: 9223 }, isolated: true } }));
    expect(pinnedPortLaunch.sessionsUnsupportedReason).toContain('--cdp-launch-port');

    const freePortLaunch = contextFactory(await resolveConfig({ browser: { cdpLaunch: { command: 'open' }, isolated: true } }));
    expect(freePortLaunch.sessionsUnsupportedReason).toBeUndefined();

    const isolated = contextFactory(await resolveConfig({ browser: { isolated: true } }));
    expect(isolated.sessionsUnsupportedReason).toBeUndefined();

    const userProfile = contextFactory(await resolveConfig({ browser: { userDataDir: '/tmp/my-profile' } }));
    expect(userProfile.sessionsUnsupportedReason).toContain('--user-data-dir');

    const extension = new ExtensionContextFactory('chrome', undefined, undefined);
    expect(extension.sessionsUnsupportedReason).toContain('--extension');

    const vscode = new VSCodeBrowserContextFactory(await resolveConfig({}), playwright as any, 'ws://127.0.0.1:1234');
    expect(vscode.sessionsUnsupportedReason).toContain('VS Code');
  });

  it('parks persistent startup pages before the storage state lands', async () => {
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
    expect(startup.close.mock.invocationCallOrder[0]).toBeLessThan(browserContext.setStorageState.mock.invocationCallOrder[0]);
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
    browser.contexts.mockReturnValueOnce([]).mockReturnValue([browserContext]);
    let releaseCreate: () => void;
    browser.newContext.mockImplementationOnce(() => new Promise(resolve => { releaseCreate = () => resolve(browserContext); }));
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        contextOptions: { storageState: writeStateFile() },
      },
    });

    const factory = contextFactory(config);
    // Session A is creating a fresh fallback context.
    const pendingA = factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);
    await vi.waitFor(() => expect(browser.newContext).toHaveBeenCalled());

    // Session B fails context creation while A is still in flight.
    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined))
        .rejects.toThrow('Cannot apply --storage-state');
    expect(browser.close).not.toHaveBeenCalled();

    releaseCreate!();
    const resultA = await pendingA;
    await resultA.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('hands a fresh CDP connection to a session arriving while the last close is in flight', async () => {
    // The closing browser stayed cached in _browserPromise until its
    // asynchronous 'disconnected' event fired, so a session starting during
    // the disconnect obtained the dying connection and failed newContext().
    // The cache is evicted before the close is awaited.
    const context1 = createMockBrowserContext();
    const context2 = createMockBrowserContext();
    const browser1 = createMockBrowser(context1);
    const browser2 = createMockBrowser(context2);
    let releaseClose: () => void;
    browser1.close.mockImplementation(() => new Promise<void>(resolve => { releaseClose = resolve; }));
    connectOverCDP.mockResolvedValueOnce(browser1).mockResolvedValueOnce(browser2);

    const config = await resolveConfig({ browser: { cdpEndpoint: 'http://127.0.0.1:9222', isolated: true } });
    const factory = contextFactory(config);
    const sessionA = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    // A is the last holder: its close starts disconnecting browser1 and
    // blocks inside browser.close().
    const closingA = sessionA.close();
    await vi.waitFor(() => expect(browser1.close).toHaveBeenCalledTimes(1));

    // A session arriving mid-disconnect must get a fresh connection, not the
    // closing one.
    const sessionB = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);
    expect(connectOverCDP).toHaveBeenCalledTimes(2);
    expect(sessionB.browserContext).toBe(context2);

    releaseClose!();
    await closingA;

    // B is its own browser's only user; its close disconnects browser2.
    await sessionB.close();
    expect(browser2.close).toHaveBeenCalledTimes(1);
  });

  it('keeps the successor browser cached when a stale disconnected event fires', async () => {
    // Session A's close evicts the cache eagerly and session B obtains a NEW
    // browser before A's close settles. When A's old browser finally fires
    // its asynchronous 'disconnected', that stale event must not wipe B's
    // cached promise — a third session would otherwise churn yet another
    // connection while B's browser is alive.
    const context1 = createMockBrowserContext();
    const context2 = createMockBrowserContext();
    const browser1 = createMockBrowser(context1);
    const browser2 = createMockBrowser(context2);
    let releaseClose: () => void;
    browser1.close.mockImplementation(() => new Promise<void>(resolve => { releaseClose = resolve; }));
    connectOverCDP.mockResolvedValueOnce(browser1).mockResolvedValueOnce(browser2);

    const config = await resolveConfig({ browser: { cdpEndpoint: 'http://127.0.0.1:9222', isolated: true } });
    const factory = contextFactory(config);
    const clientInfo = { name: 'vitest', version: '1.0.0' };
    const signal = new AbortController().signal;

    const sessionA = await factory.createContext(clientInfo, signal, undefined);
    const closingA = sessionA.close();
    await vi.waitFor(() => expect(browser1.close).toHaveBeenCalledTimes(1));

    // B arrives mid-close and obtains the fresh connection.
    const sessionB = await factory.createContext(clientInfo, signal, undefined);
    expect(sessionB.browserContext).toBe(context2);

    // A's close settles and its browser's 'disconnected' finally fires.
    releaseClose!();
    await closingA;
    const disconnected = browser1.on.mock.calls.find((call: any[]) => call[0] === 'disconnected')?.[1];
    disconnected?.();

    // The stale event must not have evicted B's browser: a third session
    // reuses it instead of opening another connection.
    const sessionC = await factory.createContext(clientInfo, signal, undefined);
    expect(connectOverCDP).toHaveBeenCalledTimes(2);
    expect(sessionC.browserContext).toBe(context2);

    await sessionC.close();
    await sessionB.close();
    expect(browser2.close).toHaveBeenCalledTimes(1);
  });

  it('does not close the shared isolated browser while a sibling context is still being created', async () => {
    // BaseContextFactory used to census browser.contexts(): session A closing
    // its only registered context while session B was still awaiting
    // newContext() saw an empty census and closed the shared browser out from
    // under B. The handout count is claimed before the await, so B holds the
    // browser open.
    const contextA = createMockBrowserContext();
    const contextB = createMockBrowserContext();
    const browser = {
      close: vi.fn().mockResolvedValue(undefined),
      contexts: vi.fn().mockReturnValue([]),
      newContext: vi.fn(),
      on: vi.fn(),
    } as any;
    let releaseB: (context: any) => void;
    browser.newContext
        .mockResolvedValueOnce(contextA)
        .mockImplementationOnce(() => new Promise(resolve => { releaseB = resolve; }));
    (playwright.chromium.launch as any).mockResolvedValue(browser);

    const config = await resolveConfig({ browser: { isolated: true } });
    const factory = contextFactory(config);
    const sessionA = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);
    const pendingB = factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);
    await vi.waitFor(() => expect(browser.newContext).toHaveBeenCalledTimes(2));

    // A closes while B's newContext() is still in flight: the shared browser
    // must survive for B.
    await sessionA.close();
    expect(contextA.close).toHaveBeenCalledTimes(1);
    expect(browser.close).not.toHaveBeenCalled();

    releaseB!(contextB);
    const sessionB = await pendingB;
    expect(sessionB.browserContext).toBe(contextB);

    // B is the last holder — its close shuts the browser down.
    await sessionB.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('defers the shutdown to a sibling createContext that has not resumed from the cached browser promise', async () => {
    // `await _obtainBrowser()` yields to the microtask queue even when the
    // cached promise is already resolved, and the handout count used to be
    // claimed only after resumption. Session B entering createContext()
    // synchronously (no awaits completed) was therefore invisible to session
    // A's close, which saw zero remaining handouts and shut the shared
    // browser down under B. The acquisition is now registered synchronously,
    // so A defers the shutdown to B.
    const contextA = createMockBrowserContext();
    const contextB = createMockBrowserContext();
    const browser = {
      close: vi.fn().mockResolvedValue(undefined),
      contexts: vi.fn().mockReturnValue([]),
      newContext: vi.fn().mockResolvedValueOnce(contextA).mockResolvedValueOnce(contextB),
      on: vi.fn(),
    } as any;
    (playwright.chromium.launch as any).mockResolvedValue(browser);

    const config = await resolveConfig({ browser: { isolated: true } });
    const factory = contextFactory(config);
    const clientInfo = { name: 'vitest', version: '1.0.0' };
    const signal = new AbortController().signal;

    const sessionA = await factory.createContext(clientInfo, signal, undefined);
    // B starts createContext and A closes within the same synchronous
    // continuation — B has completed no awaits yet.
    const pendingB = factory.createContext(clientInfo, signal, undefined);
    await sessionA.close();
    expect(contextA.close).toHaveBeenCalledTimes(1);
    expect(browser.close).not.toHaveBeenCalled();

    // B resumes onto the same live browser instead of failing.
    const sessionB = await pendingB;
    expect(sessionB.browserContext).toBe(contextB);
    expect(playwright.chromium.launch).toHaveBeenCalledTimes(1);

    // B inherited the last handout — its close shuts the browser down.
    await sessionB.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('defers the CDP disconnect to a sibling createContext that has not resumed from the cached browser promise', async () => {
    // Same window as the isolated variant, on CdpContextFactory's override:
    // session B's session count is claimed atomically with the cached
    // browser's delivery, so session A closing inside B's await window must
    // not disconnect the shared connection.
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({ browser: { cdpEndpoint: 'http://127.0.0.1:9222' } });
    const factory = contextFactory(config);
    const clientInfo = { name: 'vitest', version: '1.0.0' };
    const signal = new AbortController().signal;

    const sessionA = await factory.createContext(clientInfo, signal, undefined);
    const pendingB = factory.createContext(clientInfo, signal, undefined);
    await sessionA.close();
    expect(browser.close).not.toHaveBeenCalled();

    const sessionB = await pendingB;
    expect(sessionB.browserContext).toBe(browserContext);
    expect(connectOverCDP).toHaveBeenCalledTimes(1);

    await sessionB.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('closes the deferred shared browser when the last in-flight creation fails', async () => {
    // Session A's close deferred the browser shutdown to B's in-flight
    // handout; if B's creation then fails, B must close the browser instead
    // of leaving it running with no owner.
    const contextA = createMockBrowserContext();
    const browser = {
      close: vi.fn().mockResolvedValue(undefined),
      contexts: vi.fn().mockReturnValue([]),
      newContext: vi.fn(),
      on: vi.fn(),
    } as any;
    let rejectB: (error: Error) => void;
    browser.newContext
        .mockResolvedValueOnce(contextA)
        .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectB = reject; }));
    (playwright.chromium.launch as any).mockResolvedValue(browser);

    const config = await resolveConfig({ browser: { isolated: true } });
    const factory = contextFactory(config);
    const sessionA = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);
    const pendingB = factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);
    await vi.waitFor(() => expect(browser.newContext).toHaveBeenCalledTimes(2));

    await sessionA.close();
    expect(browser.close).not.toHaveBeenCalled();

    rejectB!(new Error('Target crashed'));
    await expect(pendingB).rejects.toThrow('Target crashed');
    expect(browser.close).toHaveBeenCalledTimes(1);
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

  it.each([false, true])('imports storage only when the VS Code provider creates a fresh context (existing: %s)', async existing => {
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    browser.contexts.mockReturnValue(existing ? [browserContext] : []);
    const config = await resolveConfig({ browser: { contextOptions: { storageState: { cookies: [], origins: [] } } } });
    const factory = new VSCodeBrowserContextFactory(config, createVSCodePlaywright(browser), 'ws://127.0.0.1:1234/');
    const result = factory.createContext({ name: 'vitest' }, new AbortController().signal);
    if (existing) {
      await expect(result).rejects.toThrow('Cannot apply --storage-state');
      expect(browser.close).toHaveBeenCalledTimes(1);
      expect(browser.newContext).not.toHaveBeenCalled();
    } else {
      expect((await result).browserContext).toBe(browserContext);
      expect(browser.newContext).toHaveBeenCalledWith(config.browser.contextOptions);
    }
    expect(browserContext.storageState).not.toHaveBeenCalled();
    expect(browserContext.setStorageState).not.toHaveBeenCalled();
    expect(browserContext.newPage).not.toHaveBeenCalled();
    expect(browserContext.close).not.toHaveBeenCalled();
  });

  it('lets the VS Code endpoint choose the sandbox default but forwards explicit values', async () => {
    const browser = createMockBrowser(createMockBrowserContext());
    const vscodePlaywright = createVSCodePlaywright(browser);

    for (const [config, expected] of [
      [await resolveConfig({}), undefined],
      [await resolveConfig({ browser: { launchOptions: { chromiumSandbox: false } } }), false],
      [await resolveConfig({ browser: { launchOptions: { chromiumSandbox: true } } }), true],
    ] as const) {
      const factory = new VSCodeBrowserContextFactory(config, vscodePlaywright, 'ws://127.0.0.1:1234/');
      await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal);
      const endpoint = new URL(vscodePlaywright.chromium.connect.mock.calls.at(-1)[0]);
      const launchOptions = JSON.parse(endpoint.searchParams.get('launch-options')!);
      expect(launchOptions.chromiumSandbox).toBe(expected);
    }
  });

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

});
