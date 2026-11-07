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
import { settleWithin } from './utils/timeout.js';
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

async function replaceOpenPagesWithBlankTabs(browserContext: playwright.BrowserContext): Promise<{ page: playwright.Page, url: string }[]> {
  const seen = new Set<playwright.Page>();
  const arrivals: playwright.Page[] = [];
  const onPage = (page: playwright.Page) => arrivals.push(page);
  const replaced: { page: playwright.Page, url: string }[] = [];
  const replacePage = async (page: playwright.Page) => {
    const url = page.url();
    let fresh: playwright.Page;
    try {
      fresh = await browserContext.newPage();
    } catch {
      await page.close();
      return;
    }
    seen.add(fresh);
    try {
      await page.close();
    } catch (error) {
      await fresh.close().catch(() => {});
      throw error;
    }
    replaced.push({ page: fresh, url });
  };
  browserContext.on('page', onPage);
  try {
    while (true) {
      const pending = [...new Set([...browserContext.pages(), ...arrivals.splice(0)])].filter(page => !seen.has(page));
      if (!pending.length)
        break;
      for (const page of pending)
        seen.add(page);
      await Promise.all(pending.map(replacePage));
    }
  } finally {
    browserContext.off('page', onPage);
  }
  return replaced;
}

async function navigateReplacementPages(replaced: { page: playwright.Page, url: string }[]): Promise<void> {
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
  createContext(clientInfo: ClientInfo, abortSignal: AbortSignal, toolName: string | undefined, options?: CreateContextOptions): Promise<ContextHandle>;
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
          const remaining = this._handoutCounts.get(browser)! - 1;
          this._handoutCounts.set(browser, remaining);
          if (remaining === 0 && !this._pendingAcquisitions.has(obtainedPromise)) {
            this._evictBrowser(obtainedPromise);
            testDebug(`close browser (${this._logName})`);
            await browser.close().catch(logUnhandledError);
          }
        },
      };
    } finally {
      const pending = this._pendingAcquisitions.get(obtainedPromise)! - 1;
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
    return playwright.chromium.connectOverCDP(this.config.browser.cdpEndpoint!, {
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
    const url = new URL(this.config.browser.remoteEndpoint!);
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
    const cdpLaunch = this.config.browser.cdpLaunch!;
    if (cdpLaunch.port !== undefined) {
      await this._waitForClosingPinnedPortHolder(cdpLaunch);
      this._assertPinnedPortFree(cdpLaunch);
    }
    const allocatedPort = cdpLaunch.port === undefined ? await findFreePort({ reserve: true }) : undefined;
    const port = cdpLaunch.port ?? allocatedPort!;
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
      if (cdpLaunch.port !== undefined)
        pinnedLaunch = this._trackPinnedPortChild(childProcess);

      childProcess.stderr?.on('data', data => {
        testDebug(`cdp-launch stderr: ${String(data).trimEnd()}`);
      });

      browser = await this._waitForBrowser(endpoint, clientInfo, childProcess, cdpLaunch.startupTimeoutMs ?? defaultCdpTimeoutMs);
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

  private async _waitForBrowser(endpoint: string, clientInfo: ClientInfo, childProcess: ReturnType<typeof spawn>, startupTimeoutMs: number): Promise<playwright.Browser> {
    const deadline = Date.now() + startupTimeoutMs;
    const headers = cdpConnectHeaders(clientInfo, this.config.browser);
    const cdpTimeout = this.config.browser.cdpTimeout ?? defaultCdpTimeoutMs;
    let attachTimedOut = false;
    for (;;) {
      const remaining = Math.max(1, deadline - Date.now());
      try {
        return await playwright.chromium.connectOverCDP(endpoint, {
          headers,
          timeout: cdpTimeout > 0 ? Math.min(cdpTimeout, remaining) : remaining,
          noDefaults: true,
        });
      } catch (error) {
        testDebug(`connect over CDP failed for ${endpoint}: ${String(error)}`);
        attachTimedOut ||= isCdpAttachTimeout(error);
        if (Date.now() >= deadline) {
          childProcess.kill('SIGTERM');
          throw new Error(`Timed out waiting for CDP endpoint ${endpoint}.${attachTimedOut ? ` ${cdpAttachTimeoutHint}` : ''}`);
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }
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
  readonly name = 'persistent';
  readonly description = 'Create a new persistent browser context';

  private _userDataDirs = new Set<string>();

  private _stableProfileClaim: StableProfileClaim | undefined;

  private _claimStableProfile(): StableProfileClaim {
    let resolveReleased!: () => void;
    const released = new Promise<void>(resolve => { resolveReleased = resolve; });
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

  async createContext(clientInfo: ClientInfo, _abortSignal?: AbortSignal, _toolName?: string, options?: CreateContextOptions): Promise<ContextHandle> {
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
      try {
        const replaced = await replaceOpenPagesWithBlankTabs(browserContext);
        await browserContext.setStorageState(storageState);
        await ensureNetworkPolicyRoutes(this.config, browserContext);
        await navigateReplacementPages(replaced);
      } catch (error) {
        await this._closeBrowserContext(browserContext, userDataDir, disposableProfile);
        throw new StorageStateError(errorMessage(error));
      }
    }
    const close = () => this._closeBrowserContext(browserContext, userDataDir, disposableProfile);
    return { browserContext, close };
  }

  private async _closeBrowserContext(browserContext: playwright.BrowserContext, userDataDir: string, disposeUserDataDir = false) {
    testDebug('close browser context (persistent)');
    testDebug('release user data dir', userDataDir);
    await browserContext.close().catch(() => {});
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
