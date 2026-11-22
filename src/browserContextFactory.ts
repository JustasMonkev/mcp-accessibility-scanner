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
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

import * as playwright from 'playwright';
import coreBundle from 'playwright-core/lib/coreBundle';

import { logUnhandledError, testDebug } from './utils/log.js';
import { errorMessage } from './utils/errors.js';
import { createGuid, createHash, createShortGuid } from './utils/guid.js';
import { outputFile } from './config.js';
import { ensureNetworkPolicyRoutes } from './networkPolicy.js';
import { connectOverCDP } from './utils/cdpConnection.js';
import { rejectOnAbort, settleWithin } from './utils/timeout.js';
import { printToStderr } from './utils/terminal.js';

import type { FullConfig } from './config.js';

const { registryDirectory } = coreBundle.registry;
const { startTraceViewerServer } = coreBundle.server;
const defaultCdpTimeoutMs = 30_000;

export function assertStorageStateSupported(config: FullConfig, factory: BrowserContextFactory, remedy: string): void {
  if (config.browser.contextOptions?.storageState && !factory.appliesStorageState)
    throw new Error(`Storage state cannot be applied in this mode. ${remedy}`);
}

export function assertStorageStateDoesNotResetUserProfile(config: FullConfig, remedy: string): void {
  if (config.browser.contextOptions?.storageState && config.browser.userDataDir)
    throw new Error(`--storage-state and --user-data-dir contradict each other: the profile carries its own session data, and resetting a user-supplied profile to match the recorded state would destroy it. ${remedy}`);
}

export function contextFactory(config: FullConfig): BrowserContextFactory {
  const factory = createContextFactory(config);
  assertStorageStateSupported(config, factory, 'Drop the storage state and sign in interactively before auditing.');
  return factory;
}

const pageReplacementTimeoutMs = 30_000;

type ReplacedPage = { page: playwright.Page, url: string };

/**
 * Replaces every open page with a blank tab before a storage state lands.
 * Pages that keep arriving while earlier ones are replaced are swept in
 * further batches, all within one deadline: a context that never stops
 * opening tabs fails the phase instead of stalling the first tool call.
 */
class OpenPageReplacement {
  private readonly _browserContext: playwright.BrowserContext;
  private readonly _inFlight = new Set<Promise<void>>();
  private _closed = false;

  constructor(browserContext: playwright.BrowserContext) {
    this._browserContext = browserContext;
  }

  async run(timeoutMs = pageReplacementTimeoutMs): Promise<ReplacedPage[]> {
    const seen = new Set<playwright.Page>();
    const arrivals: playwright.Page[] = [];
    const onPage = (page: playwright.Page) => arrivals.push(page);
    const replaced: ReplacedPage[] = [];
    const deadline = Date.now() + timeoutMs;
    const { promise: expired, resolve: expire } = Promise.withResolvers<'expired'>();
    const timer = setTimeout(() => expire('expired'), timeoutMs);
    const timeoutError = () => new Error(`Timed out after ${timeoutMs}ms replacing the pages open in the browser profile before applying the storage state: new pages kept opening. Close the pages the profile restores or opens on startup, then retry.`);
    this._browserContext.on('page', onPage);
    try {
      for (;;) {
        const pending = [...new Set([...this._browserContext.pages(), ...arrivals.splice(0)])].filter(page => !seen.has(page));
        if (!pending.length)
          return replaced;
        if (Date.now() >= deadline)
          throw timeoutError();
        for (const page of pending)
          seen.add(page);
        const batch = Promise.all(pending.map(page => this._track(this._replacePage(page, seen, replaced))));
        if (await Promise.race([batch, expired]) === 'expired')
          throw timeoutError();
      }
    } catch (error) {
      // Stop admitting work; the caller cancels what is in flight by closing
      // the context and then waits for settled().
      this._closed = true;
      throw error;
    } finally {
      clearTimeout(timer);
      this._browserContext.off('page', onPage);
    }
  }

  /** Resolves once no replacement started by run() is still in flight. */
  async settled(): Promise<void> {
    while (this._inFlight.size)
      await Promise.allSettled(this._inFlight);
  }

  private _track(work: Promise<void>): Promise<void> {
    this._inFlight.add(work);
    void work.catch(() => {}).finally(() => this._inFlight.delete(work));
    return work;
  }

  private async _replacePage(page: playwright.Page, seen: Set<playwright.Page>, replaced: ReplacedPage[]): Promise<void> {
    const url = page.url();
    let fresh: playwright.Page;
    try {
      fresh = await this._browserContext.newPage();
    } catch {
      await page.close();
      return;
    }
    seen.add(fresh);
    if (this._closed) {
      await fresh.close().catch(() => {});
      return;
    }
    try {
      await page.close();
    } catch (error) {
      await fresh.close().catch(() => {});
      throw error;
    }
    replaced.push({ page: fresh, url });
  }
}

async function navigateReplacementPages(replaced: ReplacedPage[]): Promise<void> {
  await Promise.all(replaced.map(async ({ page, url }) => {
    if (!url || url === 'about:blank')
      return;
    try {
      await page.goto(url);
    } catch {
      try {
        await page.goto('about:blank');
      } catch {
        await page.close().catch(() => {});
      }
    }
  }));
}

export function assertReusedContextStorageStateSupported(config: FullConfig): void {
  if (config.browser.contextOptions?.storageState)
    throw new Error('Cannot apply --storage-state to an existing browser context: on Playwright 1.63.0 its rollback snapshot ran service-worker-served scripts and altered storage, and imports into existing contexts stay disabled until revalidated. Use a fresh context (for CDP, add --isolated), or omit --storage-state and sign in interactively. No storage snapshot or reset was attempted.');
}

function createContextFactory(config: FullConfig): BrowserContextFactory {
  if (config.browser.remoteEndpoint)
    return new RemoteContextFactory(config);
  if (config.browser.cdpLaunch)
    return new CdpLaunchContextFactory(config);
  if (config.browser.cdpEndpoint)
    return new CdpContextFactory(config);
  const { isMobile, screen, viewport } = config.browser.contextOptions;
  if (config.browser.browserName === 'firefox' && isMobile && screen && viewport
      && (screen.width !== viewport.width || screen.height !== viewport.height))
    throw new Error('Firefox 159 mobile emulation cannot honor screen dimensions that differ from the viewport (Playwright 1.65.0). Choose Chromium or WebKit, or explicitly configure equal screen and viewport dimensions. No browser was started.');
  if (config.browser.isolated)
    return new IsolatedContextFactory(config);
  if (config.browser.browserName === 'firefox' && config.browser.contextOptions.clientCertificates?.length
      && (config.browser.contextOptions.proxy ?? config.browser.launchOptions.proxy))
    throw new Error('Persistent Firefox does not support clientCertificates together with a proxy: Playwright bypasses the certificate interceptor and omits the client certificate. Use --isolated with Firefox, select Chromium explicitly, or remove the proxy. No browser was started.');
  return new PersistentContextFactory(config);
}

export type ClientInfo = { name?: string, version?: string };

export type ContextHandle = {
  browserContext: playwright.BrowserContext;
  close: () => Promise<void>;
  closeStarting?: () => void;
};

export type CreateContextOptions = {
  browserSession?: boolean;
};

export interface BrowserContextFactory {
  readonly ownsBrowser?: boolean;
  readonly sharedContext?: boolean;
  readonly attachNeedsUser?: boolean;
  readonly appliesStorageState?: boolean;
  readonly sessionsUnsupportedReason?: string;
  createContext(clientInfo: ClientInfo, abortSignal: AbortSignal, options?: CreateContextOptions): Promise<ContextHandle>;
}

abstract class BaseContextFactory implements BrowserContextFactory {
  abstract readonly appliesStorageState: boolean;
  readonly config: FullConfig;
  private _logName: string;
  private _browserPromise: Promise<playwright.Browser> | undefined;

  private _handoutCounts = new WeakMap<playwright.Browser, number>();

  private _pendingAcquisitions = new Map<Promise<playwright.Browser>, number>();

  constructor(name: string, config: FullConfig) {
    this._logName = name;
    this.config = config;
  }

  private _obtainBrowser(clientInfo: ClientInfo): Promise<playwright.Browser> {
    if (this._browserPromise)
      return this._browserPromise;
    testDebug(`obtain browser (${this._logName})`);
    const promise = this._doObtainBrowser(clientInfo);
    this._browserPromise = promise;
    void promise.then(browser => {
      browser.on('disconnected', () => this._evictBrowser(promise));
    }).catch(() => this._evictBrowser(promise));
    return promise;
  }

  protected abstract _doObtainBrowser(clientInfo: ClientInfo): Promise<playwright.Browser>;

  private async _acquireBrowser(clientInfo: ClientInfo): Promise<{ browser: playwright.Browser, release: (context?: playwright.BrowserContext) => Promise<void> }> {
    const obtainedPromise = this._obtainBrowser(clientInfo);
    this._pendingAcquisitions.set(obtainedPromise, (this._pendingAcquisitions.get(obtainedPromise) ?? 0) + 1);
    try {
      const browser = await obtainedPromise;
      this._handoutCounts.set(browser, (this._handoutCounts.get(browser) ?? 0) + 1);
      let released = false;
      return {
        browser,
        release: async context => {
          if (released)
            return;
          released = true;
          if (this._handoutCounts.get(browser) === 1 && !this._pendingAcquisitions.has(obtainedPromise))
            this._evictBrowser(obtainedPromise);
          if (context && this._ownsContext) {
            testDebug(`close browser context (${this._logName})`);
            await context.close().catch(logUnhandledError);
          }
          const remaining = (this._handoutCounts.get(browser) ?? 0) - 1;
          this._handoutCounts.set(browser, remaining);
          if (remaining === 0 && !this._pendingAcquisitions.has(obtainedPromise)) {
            this._evictBrowser(obtainedPromise);
            testDebug(`close browser (${this._logName})`);
            await browser.close().catch(logUnhandledError);
          }
        },
      };
    } finally {
      const pending = (this._pendingAcquisitions.get(obtainedPromise) ?? 0) - 1;
      if (pending > 0)
        this._pendingAcquisitions.set(obtainedPromise, pending);
      else
        this._pendingAcquisitions.delete(obtainedPromise);
    }
  }

  private _evictBrowser(obtainedPromise: Promise<playwright.Browser>): void {
    if (this._browserPromise === obtainedPromise)
      this._browserPromise = undefined;
  }

  protected get _ownsContext(): boolean {
    return true;
  }

  async createContext(clientInfo: ClientInfo): Promise<ContextHandle> {
    testDebug(`create browser context (${this._logName})`);
    const { browser, release } = await this._acquireBrowser(clientInfo);
    let browserContext: playwright.BrowserContext;
    try {
      browserContext = await this._doCreateContext(browser);
    } catch (error) {
      await release();
      throw error;
    }
    return { browserContext, close: () => release(browserContext) };
  }

  protected abstract _doCreateContext(browser: playwright.Browser): Promise<playwright.BrowserContext>;
}

class IsolatedContextFactory extends BaseContextFactory {
  readonly ownsBrowser = true;
  readonly appliesStorageState = true;

  constructor(config: FullConfig) {
    super('isolated', config);
  }

  protected override async _doObtainBrowser(clientInfo: ClientInfo): Promise<playwright.Browser> {
    const { cdpPortOptions, releaseCdpPort } = await allocateCdpPort(this.config.browser);
    const browserType = playwright[this.config.browser.browserName];
    try {
      return await browserType.launch({
        tracesDir: await startTraceServer(this.config),
        ...this.config.browser.launchOptions,
        ...cdpPortOptions,
        handleSIGINT: false,
        handleSIGTERM: false,
      }).catch(error => {
        if (errorMessage(error).includes('Executable doesn\'t exist'))
          throw browserNotInstalledError(errorMessage(error));
        throw error;
      });
    } finally {
      releaseCdpPort();
    }
  }

  protected override async _doCreateContext(browser: playwright.Browser): Promise<playwright.BrowserContext> {
    return browser.newContext(this.config.browser.contextOptions);
  }
}

class CdpContextFactory extends BaseContextFactory {
  get sharedContext(): boolean {
    return !this.config.browser.isolated;
  }

  readonly appliesStorageState = true;

  private _createdContexts = new WeakSet<playwright.BrowserContext>();
  private _fallbackContext = new WeakMap<playwright.Browser, Promise<playwright.BrowserContext>>();

  constructor(config: FullConfig) {
    super('cdp', config);
  }

  get sessionsUnsupportedReason(): string | undefined {
    if (this.config.browser.isolated)
      return undefined;
    return 'this connection attaches to the browser\'s existing context, which every session would share (same tabs, cookies and storage). Add --isolated to give each session its own browser context.';
  }

  protected override get _ownsContext(): boolean {
    return !!this.config.browser.isolated;
  }

  protected override async _doObtainBrowser(clientInfo: ClientInfo): Promise<playwright.Browser> {
    const { cdpEndpoint } = this.config.browser;
    if (!cdpEndpoint)
      throw new Error('CDP connection requires browser.cdpEndpoint.');
    return connectOverCDP(cdpEndpoint, {
      headers: cdpConnectHeaders(clientInfo, this.config.browser),
      timeout: this.config.browser.cdpTimeout,
      noDefaults: true,
    }).catch(error => {
      if (isCdpAttachTimeout(error))
        error.message += `\n${cdpAttachTimeoutHint}`;
      throw error;
    });
  }

  protected override async _doCreateContext(browser: playwright.Browser): Promise<playwright.BrowserContext> {
    if (this.config.browser.isolated)
      return await browser.newContext(this.config.browser.contextOptions);
    const existing = browser.contexts()[0];
    if (!existing) {
      let creating = this._fallbackContext.get(browser);
      if (!creating) {
        creating = browser.newContext(this.config.browser.contextOptions).then(created => {
          this._createdContexts.add(created);
          created.on('close', () => this._fallbackContext.delete(browser));
          return created;
        });
        this._fallbackContext.set(browser, creating);
        creating.catch(() => this._fallbackContext.delete(browser));
      }
      return await creating;
    }
    if (!this._createdContexts.has(existing))
      assertReusedContextStorageStateSupported(this.config);
    return existing;
  }
}

class RemoteContextFactory extends BaseContextFactory {
  readonly appliesStorageState = true;

  constructor(config: FullConfig) {
    super('remote', config);
  }

  protected override async _doObtainBrowser(): Promise<playwright.Browser> {
    const { remoteEndpoint } = this.config.browser;
    if (!remoteEndpoint)
      throw new Error('Remote connection requires browser.remoteEndpoint.');
    const url = new URL(remoteEndpoint);
    url.searchParams.set('browser', this.config.browser.browserName);
    if (this.config.browser.launchOptions)
      url.searchParams.set('launch-options', JSON.stringify(this.config.browser.launchOptions));
    return playwright[this.config.browser.browserName].connect(String(url));
  }

  protected override async _doCreateContext(browser: playwright.Browser): Promise<playwright.BrowserContext> {
    return browser.newContext(this.config.browser.contextOptions);
  }
}

class CdpLaunchContextFactory implements BrowserContextFactory {
  readonly config: FullConfig;
  readonly appliesStorageState = true;

  private _pinnedPortLaunch: { closing: boolean, exited: Promise<void> } | undefined;

  constructor(config: FullConfig) {
    this.config = config;
  }

  get sessionsUnsupportedReason(): string | undefined {
    if (!this.config.browser.isolated)
      return 'without --isolated each session would attach to a launched application\'s single shared context (same tabs, cookies and storage). Add --isolated to give each session its own browser context.';
    if (this.config.browser.cdpLaunch?.port !== undefined)
      return 'the pinned --cdp-launch-port can serve only one launched application at a time, so a second session would attach to the first session\'s instance. Drop --cdp-launch-port (each session then launches on its own free port) or run one session at a time.';
    return undefined;
  }

  async createContext(clientInfo: ClientInfo): Promise<ContextHandle> {
    const { cdpLaunch } = this.config.browser;
    if (!cdpLaunch)
      throw new Error('CDP launch requires browser.cdpLaunch.');
    const startupTimeoutMs = cdpLaunch.startupTimeoutMs ?? defaultCdpTimeoutMs;
    // A NaN or infinite budget would make the attach loop's deadline check
    // never fire. Config resolution rejects those; never launch on one anyway.
    if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0)
      throw new Error(`Invalid CDP launch startup timeout ${startupTimeoutMs}: expected a positive number of milliseconds. No application was launched.`);
    if (cdpLaunch.port !== undefined) {
      await this._waitForClosingPinnedPortHolder(cdpLaunch);
      this._assertPinnedPortFree(cdpLaunch);
    }
    const port = cdpLaunch.port ?? await findFreePort({ reserve: true });
    const allocatedPort = cdpLaunch.port === undefined ? port : undefined;
    const endpoint = `http://127.0.0.1:${port}`;
    const args = (cdpLaunch.args ?? []).map(arg => arg.replaceAll('{port}', String(port)));
    let browser: playwright.Browser;
    let childProcess: ReturnType<typeof spawn>;
    let pinnedLaunch: NonNullable<CdpLaunchContextFactory['_pinnedPortLaunch']> | undefined;
    try {
      childProcess = spawn(cdpLaunch.command, args, {
        cwd: cdpLaunch.cwd,
        env: {
          ...process.env,
          ...cdpLaunch.env,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      const launchFailure = watchLaunchFailure(childProcess, cdpLaunch.command, endpoint);
      if (cdpLaunch.port !== undefined)
        pinnedLaunch = this._trackPinnedPortChild(childProcess);

      childProcess.stderr?.on('data', data => {
        testDebug(`cdp-launch stderr: ${String(data).trimEnd()}`);
      });

      browser = await this._waitForBrowser(endpoint, clientInfo, childProcess, startupTimeoutMs, launchFailure);
    } catch (error) {
      if (pinnedLaunch)
        pinnedLaunch.closing = true;
      throw error;
    } finally {
      if (allocatedPort !== undefined)
        reservedPorts.delete(allocatedPort);
    }
    const closeLaunchedApp = async () => {
      if (pinnedLaunch)
        pinnedLaunch.closing = true;
      await browser.close().catch(logUnhandledError);
      childProcess.kill('SIGTERM');
    };
    try {
      return { browserContext: await this._contextFor(browser), close: closeLaunchedApp };
    } catch (error) {
      await closeLaunchedApp();
      throw error;
    }
  }

  private async _contextFor(browser: playwright.Browser): Promise<playwright.BrowserContext> {
    const existing = this.config.browser.isolated ? undefined : browser.contexts()[0];
    if (!existing)
      return await browser.newContext(this.config.browser.contextOptions);
    assertReusedContextStorageStateSupported(this.config);
    return existing;
  }

  private async _waitForClosingPinnedPortHolder(cdpLaunch: NonNullable<FullConfig['browser']['cdpLaunch']>): Promise<void> {
    const previous = this._pinnedPortLaunch;
    if (!previous?.closing)
      return;
    await settleWithin(previous.exited, cdpLaunch.startupTimeoutMs ?? defaultCdpTimeoutMs);
  }

  private _assertPinnedPortFree(cdpLaunch: NonNullable<FullConfig['browser']['cdpLaunch']>): void {
    if (this._pinnedPortLaunch)
      throw new Error(`The pinned --cdp-launch-port ${cdpLaunch.port} already serves a launched application from another live browser context, and a second launch on the same port would silently attach to that application instead of its own. Close the other context first, or drop --cdp-launch-port so each context launches on its own free port.`);
  }

  private _trackPinnedPortChild(childProcess: ReturnType<typeof spawn>): NonNullable<CdpLaunchContextFactory['_pinnedPortLaunch']> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const launch = { closing: false, exited: promise };
    const done = () => {
      if (this._pinnedPortLaunch === launch)
        this._pinnedPortLaunch = undefined;
      resolve();
    };
    childProcess.once('exit', done);
    childProcess.once('error', done);
    this._pinnedPortLaunch = launch;
    return launch;
  }

  private async _waitForBrowser(endpoint: string, clientInfo: ClientInfo, childProcess: ReturnType<typeof spawn>, startupTimeoutMs: number, launchFailure: AbortSignal): Promise<playwright.Browser> {
    const deadline = Date.now() + startupTimeoutMs;
    const headers = cdpConnectHeaders(clientInfo, this.config.browser);
    const cdpTimeout = this.config.browser.cdpTimeout ?? defaultCdpTimeoutMs;
    const failLaunch = () => {
      childProcess.kill('SIGTERM');
      return launchFailure.reason;
    };
    let attachTimedOut = false;
    for (;;) {
      const remaining = Math.max(1, deadline - Date.now());
      const attempt = connectOverCDP(endpoint, {
        headers,
        timeout: cdpTimeout > 0 ? Math.min(cdpTimeout, remaining) : remaining,
        noDefaults: true,
      });
      try {
        return await rejectOnAbort(() => attempt, launchFailure);
      } catch (error) {
        if (launchFailure.aborted) {
          // The attempt still in flight can no longer be handed out.
          attempt.then(browser => browser.close(), () => {}).catch(logUnhandledError);
          throw failLaunch();
        }
        testDebug(`connect over CDP failed for ${endpoint}: ${String(error)}`);
        attachTimedOut ||= isCdpAttachTimeout(error);
        if (Date.now() >= deadline) {
          childProcess.kill('SIGTERM');
          throw new Error(`Timed out waiting for CDP endpoint ${endpoint}.${attachTimedOut ? ` ${cdpAttachTimeoutHint}` : ''}`, { cause: error });
        }
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await rejectOnAbort(() => new Promise(resolve => { timer = setTimeout(resolve, 50); }), launchFailure);
      } catch {
        throw failLaunch();
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

/**
 * Settles a launch promptly when the launched command cannot run: an async
 * spawn 'error' (for example ENOENT for a missing application) would otherwise
 * be an unhandled EventEmitter error that terminates the server, and a command
 * that dies unsuccessfully would leave the attach loop retrying until its
 * deadline. A clean exit (code 0) is not a failure: launchers such as
 * `open -a <App>` hand off to the application and exit immediately.
 */
function watchLaunchFailure(childProcess: ReturnType<typeof spawn>, command: string, endpoint: string): AbortSignal {
  const controller = new AbortController();
  let spawned = false;
  childProcess.once('spawn', () => { spawned = true; });
  // Stays attached for the child's lifetime: a later 'error' (for example a
  // failed kill) must not become an unhandled EventEmitter error either.
  childProcess.on('error', error => {
    testDebug(`cdp-launch process error: ${String(error)}`);
    if (controller.signal.aborted)
      return;
    controller.abort(new Error(spawned
      ? `CDP launch command "${command}" failed before its CDP endpoint ${endpoint} became available: ${errorMessage(error)}`
      : `Failed to start CDP launch command "${command}": ${errorMessage(error)}. Check that the application is installed and the command path is correct.`));
  });
  childProcess.once('exit', (code, signal) => {
    if (code === 0 || controller.signal.aborted)
      return;
    controller.abort(new Error(`CDP launch command "${command}" exited ${signal ? `on signal ${signal}` : `with code ${code}`} before its CDP endpoint ${endpoint} became available.`));
  });
  return controller.signal;
}

class StorageStateError extends Error {}

type StableProfileClaim = {
  closing: boolean;
  released: Promise<void>;
  release: () => void;
};

function disposableProfileSuffix(hasStorageState: boolean, browserSession: boolean): string {
  if (hasStorageState)
    return `-storage-state-${createGuid()}`;
  if (browserSession)
    return `-session-${createGuid()}`;
  return '';
}

function releasingClaimOnClose(result: ContextHandle, claim: StableProfileClaim): ContextHandle {
  return {
    browserContext: result.browserContext,
    closeStarting: () => { claim.closing = true; },
    close: async () => {
      try {
        await result.close();
      } finally {
        claim.release();
      }
    },
  };
}

export const persistentProfileConflictRemedy = 'Drop --user-data-dir (a managed, disposable profile is used for storage-state sessions), or drop the storage state and sign in in that profile instead.';

export class PersistentContextFactory implements BrowserContextFactory {
  readonly ownsBrowser = true;
  readonly config: FullConfig;
  readonly appliesStorageState = true;

  private _userDataDirs = new Set<string>();

  private _stableProfileClaim: StableProfileClaim | undefined;

  private _claimStableProfile(): StableProfileClaim {
    const { promise: released, resolve: resolveReleased } = Promise.withResolvers<void>();
    const claim = {
      closing: false,
      released,
      release: () => {
        if (this._stableProfileClaim === claim)
          this._stableProfileClaim = undefined;
        resolveReleased();
      },
    };
    this._stableProfileClaim = claim;
    return claim;
  }

  constructor(config: FullConfig) {
    this.config = config;
  }

  get sessionsUnsupportedReason(): string | undefined {
    if (this.config.browser.userDataDir)
      return 'the configured --user-data-dir profile can back only one running browser at a time. Drop --user-data-dir (extra sessions run in their own disposable profiles) or use --isolated.';
    return undefined;
  }

  async createContext(clientInfo: ClientInfo, _abortSignal?: AbortSignal, options?: CreateContextOptions): Promise<ContextHandle> {
    testDebug('create browser context (persistent)');
    const { storageState, ...contextOptions } = this.config.browser.contextOptions ?? {};
    assertStorageStateDoesNotResetUserProfile(this.config, persistentProfileConflictRemedy);
    const tracesDir = await startTraceServer(this.config);
    const { cdpPortOptions, releaseCdpPort } = await allocateCdpPort(this.config.browser);
    let claim: StableProfileClaim | undefined;
    let userDataDir: string | undefined;
    let disposableProfile = false;
    try {
      const profile = await this._reserveProfile(disposableProfileSuffix(!!storageState, !!options?.browserSession));
      claim = profile.claim;
      userDataDir = this.config.browser.userDataDir ?? await this._createUserDataDir(profile.suffix);
      disposableProfile = !!profile.suffix && !this.config.browser.userDataDir;

      this._userDataDirs.add(userDataDir);
      testDebug('lock user data dir', userDataDir);

      const browserContext = await this._launchPersistentContext(userDataDir, {
        tracesDir,
        ...this.config.browser.launchOptions,
        ...cdpPortOptions,
        ...contextOptions,
        handleSIGINT: false,
        handleSIGTERM: false,
      });
      const result = await this._applyStorageState(browserContext, storageState, userDataDir, disposableProfile);
      return claim ? releasingClaimOnClose(result, claim) : result;
    } catch (error) {
      claim?.release();
      if (disposableProfile && userDataDir !== undefined) {
        await fs.promises.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
        this._userDataDirs.delete(userDataDir);
      }
      throw error;
    } finally {
      releaseCdpPort();
    }
  }

  private async _reserveProfile(suffix: string): Promise<{ suffix: string, claim?: StableProfileClaim }> {
    if (suffix || this.config.browser.userDataDir)
      return { suffix };
    if (this._stableProfileClaim?.closing) {
      testDebug('stable persistent profile holder is closing; waiting for its release');
      await this._stableProfileClaim.released;
    }
    if (!this._stableProfileClaim)
      return { suffix, claim: this._claimStableProfile() };
    testDebug('stable persistent profile is in use by a concurrent context; falling back to a disposable profile');
    return { suffix: `-concurrent-${createGuid()}` };
  }

  private async _launchPersistentContext(userDataDir: string, launchOptions: Parameters<playwright.BrowserType['launchPersistentContext']>[1]): Promise<playwright.BrowserContext> {
    const browserType = playwright[this.config.browser.browserName];
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await browserType.launchPersistentContext(userDataDir, launchOptions);
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes('Executable doesn\'t exist'))
          throw browserNotInstalledError(message);
        if (!message.includes('ProcessSingleton') && !message.includes('Invalid URL'))
          throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    throw new Error(`Browser is already in use for ${userDataDir}, use --isolated to run multiple instances of the same browser`);
  }

  private async _applyStorageState(browserContext: playwright.BrowserContext, storageState: NonNullable<FullConfig['browser']['contextOptions']>['storageState'], userDataDir: string, disposableProfile: boolean): Promise<ContextHandle> {
    if (storageState) {
      const replacement = new OpenPageReplacement(browserContext);
      try {
        const replaced = await replacement.run();
        await browserContext.setStorageState(storageState);
        await ensureNetworkPolicyRoutes(this.config, browserContext);
        await navigateReplacementPages(replaced);
      } catch (error) {
        // Closing the context cancels replacements still in flight; they
        // settle before the profile directory is removed.
        await this._closeBrowserContext(browserContext, userDataDir, disposableProfile, () => replacement.settled());
        throw new StorageStateError(errorMessage(error));
      }
    }
    const close = () => this._closeBrowserContext(browserContext, userDataDir, disposableProfile);
    return { browserContext, close };
  }

  private async _closeBrowserContext(browserContext: playwright.BrowserContext, userDataDir: string, disposeUserDataDir = false, afterClose?: () => Promise<void>) {
    testDebug('close browser context (persistent)');
    testDebug('release user data dir', userDataDir);
    await browserContext.close().catch(() => {});
    await afterClose?.();
    if (disposeUserDataDir)
      await fs.promises.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    this._userDataDirs.delete(userDataDir);
    testDebug('close browser context complete (persistent)');
  }

  private async _createUserDataDir(suffix: string) {
    const dir = process.env.PWMCP_PROFILES_DIR_FOR_TEST ?? registryDirectory;
    const browserToken = this.config.browser.launchOptions?.channel ?? this.config.browser?.browserName;
    const workspaceToken = `-${createHash(process.cwd())}`;
    const result = path.join(dir, `mcp-${browserToken}${workspaceToken}${suffix}`);
    await fs.promises.mkdir(result, { recursive: true });
    return result;
  }
}

async function allocateCdpPort(browserConfig: FullConfig['browser']): Promise<{ cdpPortOptions: { cdpPort?: number }, releaseCdpPort: () => void }> {
  if (browserConfig.browserName !== 'chromium')
    return { cdpPortOptions: {}, releaseCdpPort: () => {} };
  const cdpPort = await findFreePort({ reserve: true });
  return { cdpPortOptions: { cdpPort }, releaseCdpPort: () => reservedPorts.delete(cdpPort) };
}

function cdpConnectHeaders(clientInfo: ClientInfo, browserConfig: FullConfig['browser']): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  const userAgent = [clientInfo.name, clientInfo.version].filter(Boolean).join('/');
  if (userAgent)
    headers['User-Agent'] = userAgent;
  Object.assign(headers, browserConfig.cdpHeaders);
  return Object.keys(headers).length ? headers : undefined;
}

const cdpAttachTimeoutHint = 'The CDP WebSocket connected, but Playwright did not finish attaching before the timeout. An existing tab can block the attach: a sleeping or unresponsive tab can stall it, and on Playwright 1.63.0 so did a tab without a renderer (crashed, or discarded by Memory Saver). Reload or close that tab in the browser yourself, or attach to a separate browser, then retry; a longer --cdp-timeout helps only when the attach is merely slow.';

function isCdpAttachTimeout(error: unknown): error is Error {
  return error instanceof Error && error.name === 'TimeoutError' && error.message.includes('<ws connected>');
}

const reservedPorts = new Set<number>();

async function findFreePort(options?: { reserve?: boolean }): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, () => {
        const { port } = server.address() as net.AddressInfo;
        server.close(() => resolve(port));
      });
      server.on('error', reject);
    });
    if (reservedPorts.has(port))
      continue;
    if (options?.reserve)
      reservedPorts.add(port);
    return port;
  }
}

function browserNotInstalledError(message: string): Error {
  const match = message.match(/Executable doesn't exist at ([^\r\n]+)/);
  const location = match ? `; expected executable at ${match[1].trim()}` : '';
  return new Error(`Browser specified in your config is not installed${location}. Either install it (likely) or change the config.`);
}

const traceServers = new WeakMap<FullConfig, Promise<string>>();

async function startTraceServer(config: FullConfig): Promise<string | undefined> {
  if (!config.saveTrace)
    return undefined;
  let started = traceServers.get(config);
  if (!started) {
    started = doStartTraceServer(config);
    traceServers.set(config, started);
    started.catch(() => {
      if (traceServers.get(config) === started)
        traceServers.delete(config);
    });
  }
  return started;
}

async function doStartTraceServer(config: FullConfig): Promise<string> {
  const tracesDir = await outputFile(config, `traces-${Date.now()}-${createShortGuid()}`);
  const server = await startTraceViewerServer();
  const urlPrefix = server.urlPrefix('human-readable');
  const url = urlPrefix + '/trace/index.html?trace=' + tracesDir + '/trace.json';
  printToStderr('\nTrace viewer listening on ' + url);
  return tracesDir;
}
