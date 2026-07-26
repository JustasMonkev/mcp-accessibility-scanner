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

const { registryDirectory } = coreBundle.registry;
const { startTraceViewerServer } = coreBundle.server;
import { logUnhandledError, testDebug } from './utils/log.js';
import { createGuid, createHash } from './utils/guid.js';
import { outputFile  } from './config.js';
import { installNetworkPolicyRoutes } from './networkPolicy.js';

import type { FullConfig } from './config.js';

/**
 * Throws when a storage state is configured but `factory` will not apply it. A
 * factory that neither creates a fresh context with the state nor applies it to
 * the context it reuses would drop it without a word and audit the site as an
 * anonymous user, which looks exactly like a successful run. Every factory in
 * this file applies it one way or the other; the extension factory cannot — it
 * works through the user's own running browser, where clearing every origin's
 * cookies to install the recorded state is not an acceptable side effect.
 * Callers pass the remedy that fits the mode they selected — the factory that
 * creates the context is not always the one `contextFactory()` built.
 */
export function assertStorageStateSupported(config: FullConfig, factory: BrowserContextFactory, remedy: string): void {
  if (config.browser.contextOptions?.storageState && !factory.appliesStorageState)
    throw new Error(`Storage state cannot be applied in this mode. ${remedy}`);
}

/**
 * Throws when the configured storage state would be installed inside a profile
 * directory the user supplied. The profile carries its own session data — it is
 * data this server does not own — and resetting it to the recorded state would
 * destroy it. Every factory that lands the state in a context backed by
 * `--user-data-dir` calls this before touching the browser; callers pass the
 * remedy that fits their mode.
 */
export function assertStorageStateDoesNotResetUserProfile(config: FullConfig, remedy: string): void {
  if (config.browser.contextOptions?.storageState && config.browser.userDataDir)
    throw new Error(`--storage-state and --user-data-dir contradict each other: the profile carries its own session data, and resetting a user-supplied profile to match the recorded state would destroy it. ${remedy}`);
}

export function contextFactory(config: FullConfig): BrowserContextFactory {
  const factory = createContextFactory(config);
  // Every built-in factory now applies a storage state; the guard stays so a
  // future factory that forgets to declare support rejects the option instead
  // of silently dropping it.
  assertStorageStateSupported(config, factory, 'Drop the storage state and sign in interactively before auditing.');
  return factory;
}

/**
 * Lands the configured storage state in a context the browser already had.
 * `setStorageState()` clears the context's cookies, local storage and IndexedDB
 * and installs the recorded state — the documented semantics of the option the
 * caller asked for, applied to a context `newContext()` never sees: the CDP
 * modes without --isolated reuse the browser's existing context, and
 * launchPersistentContext() silently ignores a storageState option (verified
 * against Playwright 1.61.1).
 */
export async function applyStorageStateToReusedContext(config: FullConfig, browserContext: playwright.BrowserContext): Promise<void> {
  const storageState = config.browser.contextOptions?.storageState;
  if (!storageState)
    return;
  // setStorageState needs a temporary page whenever the state carries origins
  // or the context has visited any — and by the time that page creation fails
  // on a target without Target.createTarget, the HTTP cache is already cleared
  // and cannot be put back. Probe the page creation first, so such targets are
  // rejected before anything is mutated. When neither signal indicates a page
  // will be needed (cookie-only state, no pages open), the probe is skipped so
  // that case keeps working on those targets.
  const stateHasOrigins = await (async () => {
    try {
      const state = typeof storageState === 'string'
        ? JSON.parse(await fs.promises.readFile(storageState, 'utf-8'))
        : storageState;
      return (state?.origins?.length ?? 0) > 0;
    } catch {
      // An unreadable state file fails inside setStorageState before any
      // mutation, which is the clean failure already.
      return false;
    }
  })();
  const hasLoadedPages = browserContext.pages().some(page => page.url() && page.url() !== 'about:blank');
  if (stateHasOrigins || hasLoadedPages) {
    try {
      const probe = await browserContext.newPage();
      await probe.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Target.createTarget'))
        throw new Error(`The attached browser cannot open the temporary page Playwright needs to apply the storage state's origin data (Electron targets do not support Target.createTarget). Nothing was changed. Drop the storage state and sign in inside the app instead. Original error: ${message}`);
      throw error;
    }
  }
  // setStorageState replaces the cookie jar and then rewrites origin storage
  // one origin at a time, so a failure partway would otherwise leave the
  // attached browser holding a mixture of old and recorded state while the
  // operation reports failure. Both layers are snapshotted first: the cookie
  // jar through pure protocol calls that work everywhere (kept as the
  // fallback for a restore whose own origin phase fails), and origin storage
  // through storageState() below.
  const originalCookies = await browserContext.cookies();
  // The snapshot doubles as a probe for origins this connection has already
  // visited while its pages have since closed or gone blank: for those,
  // storageState() opens the same temporary page the forward apply will need
  // — the newPage probe above cannot see them — but unlike setStorageState()
  // it mutates nothing, so a target that cannot create pages (Electron) is
  // rejected here with everything intact, not after the forward apply has
  // cleared the HTTP cache. Any other snapshot failure also aborts: without
  // the full snapshot, a partial forward apply could only be rolled back to
  // cookies, leaving the attached browser's origin storage part old, part
  // recorded.
  const originalState = await browserContext.storageState({ indexedDB: true }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Target.createTarget'))
      throw new Error(`The attached browser cannot open the temporary page Playwright needs to reset origin storage for origins this connection has already visited (Electron targets do not support Target.createTarget). Nothing was changed. Drop the storage state and sign in inside the app instead. Original error: ${message}`);
    throw new Error(`Snapshotting the context's current storage for rollback failed, so the storage state was not applied — a partial apply could not have been undone. Nothing was changed. Retry, or use --isolated for a fresh context. Original error: ${message}`);
  });
  try {
    await browserContext.setStorageState(storageState);
    // Pages that were already open still render the previous identity's DOM
    // and in-memory state; reload them so what a scan sees matches the state
    // just installed. Ceiling: per-tab sessionStorage survives a reload — it
    // sits outside Playwright storage states entirely.
    //
    // These reloads run inside the factory, before Context installs the
    // configured origin allowlist/blocklist — and the recorded credentials are
    // already in place by now. Mirror the policy for the duration of the
    // reloads so the first navigation cannot reach an origin the policy
    // blocks; the temporary handlers come off again afterwards (only they —
    // a sibling session sharing this reused context may have its own policy
    // routes installed) and Context installs its own from the same rules once
    // the factory returns. Installed after setStorageState() so an abort-all
    // route cannot interfere with the temporary page Playwright drives to
    // restore origin storage.
    const uninstallPolicy = await installNetworkPolicyRoutes(config, browserContext);
    try {
      await Promise.all(browserContext.pages().map(async page => {
        try {
          await page.reload();
        } catch {
          // A page that cannot be brought onto the installed state — its
          // origin may be blocked by the mirrored policy, or the load simply
          // failed — must not stay around rendering the previous identity's
          // DOM: Context adopts every remaining page, and a scan would read
          // the stale document as the new session's UI. Blank it; if even
          // that fails, close it.
          try {
            await page.goto('about:blank');
          } catch {
            await page.close().catch(() => {});
          }
        }
      }));
    } finally {
      if (uninstallPolicy)
        await uninstallPolicy();
    }
  } catch (error) {
    // Prefer the full-state rollback; fall back to cookies-only when its
    // reapplication is itself impossible on this target.
    const restoredFully = await browserContext.setStorageState(originalState).then(() => true, () => false);
    const restoredCookies = restoredFully || await browserContext.clearCookies()
        .then(() => originalCookies.length ? browserContext.addCookies(originalCookies) : undefined)
        .then(() => true, () => false);
    // Restoring origin storage (localStorage/IndexedDB) makes Playwright open a
    // temporary page; a CDP target that cannot create one — Electron has no
    // Target.createTarget — fails here. Cookie-only states need no page and
    // still work on such targets, so name that remedy instead of surfacing the
    // raw protocol error.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Target.createTarget')) {
      const rollbackNote = restoredFully
        ? 'The context\'s original storage state was restored.'
        : restoredCookies
          ? 'The context\'s original cookies were restored.'
          : 'Restoring the context\'s original cookies also failed; its cookie jar may now hold the recorded state.';
      throw new Error(`The attached browser cannot open the temporary page Playwright needs to reset origin storage (Electron targets do not support Target.createTarget). Drop the storage state and sign in inside the app instead — a cookies-only state helps only while the attached target has no pages open and the connection has visited no origin, because clearing storage for an already-visited origin needs the same temporary page. ${rollbackNote} Original error: ${message}`);
    }
    if (!restoredFully && restoredCookies)
      throw new Error(`${message} The context's original cookies were restored, but origin storage may retain partially applied state.`);
    throw error;
  }
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
  return new PersistentContextFactory(config);
}

export type ClientInfo = { name?: string, version?: string, rootPath?: string };

export interface BrowserContextFactory {
  /**
   * True when createContext() lands config.browser.contextOptions.storageState in
   * the returned context — either by creating a fresh context with it or by
   * applying it to a reused context via setStorageState(). Omitted counts as
   * false, so a factory that forgets to declare it rejects a storage state rather
   * than dropping it silently.
   */
  readonly appliesStorageState?: boolean;
  createContext(clientInfo: ClientInfo, abortSignal: AbortSignal, toolName: string | undefined): Promise<{ browserContext: playwright.BrowserContext, close: () => Promise<void> }>;
}

abstract class BaseContextFactory implements BrowserContextFactory {
  abstract readonly appliesStorageState: boolean;
  readonly config: FullConfig;
  private _logName: string;
  protected _browserPromise: Promise<playwright.Browser> | undefined;

  constructor(name: string, config: FullConfig) {
    this._logName = name;
    this.config = config;
  }

  protected async _obtainBrowser(clientInfo: ClientInfo): Promise<playwright.Browser> {
    if (this._browserPromise)
      return this._browserPromise;
    testDebug(`obtain browser (${this._logName})`);
    this._browserPromise = this._doObtainBrowser(clientInfo);
    void this._browserPromise.then(browser => {
      browser.on('disconnected', () => {
        this._browserPromise = undefined;
      });
    }).catch(() => {
      this._browserPromise = undefined;
    });
    return this._browserPromise;
  }

  protected abstract _doObtainBrowser(clientInfo: ClientInfo): Promise<playwright.Browser>;

  async createContext(clientInfo: ClientInfo): Promise<{ browserContext: playwright.BrowserContext, close: () => Promise<void> }> {
    testDebug(`create browser context (${this._logName})`);
    const browser = await this._obtainBrowser(clientInfo);
    const browserContext = await this._doCreateContext(browser);
    return { browserContext, close: () => this._closeBrowserContext(browserContext, browser) };
  }

  protected abstract _doCreateContext(browser: playwright.Browser): Promise<playwright.BrowserContext>;

  private async _closeBrowserContext(browserContext: playwright.BrowserContext, browser: playwright.Browser) {
    testDebug(`close browser context (${this._logName})`);
    if (browser.contexts().length === 1)
      this._browserPromise = undefined;
    await browserContext.close().catch(logUnhandledError);
    if (browser.contexts().length === 0) {
      testDebug(`close browser (${this._logName})`);
      await browser.close().catch(logUnhandledError);
    }
  }
}

class IsolatedContextFactory extends BaseContextFactory {
  readonly appliesStorageState = true;

  constructor(config: FullConfig) {
    super('isolated', config);
  }

  protected override async _doObtainBrowser(clientInfo: ClientInfo): Promise<playwright.Browser> {
    await injectCdpPort(this.config.browser);
    const browserType = playwright[this.config.browser.browserName];
    return browserType.launch({
      tracesDir: await startTraceServer(this.config, clientInfo.rootPath),
      ...this.config.browser.launchOptions,
      handleSIGINT: false,
      handleSIGTERM: false,
    }).catch(error => {
      if (error.message.includes('Executable doesn\'t exist'))
        throw browserNotInstalledError(error);
      throw error;
    });
  }

  protected override async _doCreateContext(browser: playwright.Browser): Promise<playwright.BrowserContext> {
    return browser.newContext(this.config.browser.contextOptions);
  }
}

class CdpContextFactory extends BaseContextFactory {
  // The isolated path creates a fresh context with the state; the attach path
  // applies it to the browser's existing context via setStorageState().
  readonly appliesStorageState = true;

  // One attached browser — and its default context — serves every session
  // this factory creates. Re-running the global setStorageState() for a
  // second session would wipe the first session's live cookies and origin
  // storage mid-audit and reload its pages, so the state is applied once per
  // context object: later sessions join the live shared state. Keyed weakly —
  // a reconnect yields a fresh context object, so the slate resets with the
  // connection — and a failed apply is forgotten so the next session retries.
  private _storageStateApplied = new WeakMap<playwright.BrowserContext, Promise<void>>();

  constructor(config: FullConfig) {
    super('cdp', config);
  }

  override async createContext(clientInfo: ClientInfo): Promise<{ browserContext: playwright.BrowserContext, close: () => Promise<void> }> {
    testDebug('create browser context (cdp)');
    const browser = await this._obtainBrowser(clientInfo);
    let browserContext: playwright.BrowserContext;
    try {
      browserContext = await this._doCreateContext(browser);
    } catch (error) {
      // Without this the CDP connection stays open after e.g. an unreadable
      // storage-state file, even though no context was ever handed out.
      await browser.close().catch(logUnhandledError);
      throw error;
    }
    return {
      browserContext,
      close: async () => {
        testDebug('disconnect browser (cdp)');
        await browser.close().catch(logUnhandledError);
      }
    };
  }

  protected override async _doObtainBrowser(clientInfo: ClientInfo): Promise<playwright.Browser> {
    return playwright.chromium.connectOverCDP(this.config.browser.cdpEndpoint!, {
      headers: cdpConnectHeaders(clientInfo, this.config.browser),
      timeout: this.config.browser.cdpTimeout,
      noDefaults: true,
    });
  }

  protected override async _doCreateContext(browser: playwright.Browser): Promise<playwright.BrowserContext> {
    if (this.config.browser.isolated)
      return await browser.newContext(this.config.browser.contextOptions);
    const existing = browser.contexts()[0];
    // An attached browser can expose no context at all; a fresh one created
    // with the configured options (storage state included) beats handing an
    // undefined context to the caller.
    if (!existing)
      return await browser.newContext(this.config.browser.contextOptions);
    // The shared promise also serializes two sessions arriving at once: both
    // await the same application instead of racing two global resets.
    let applied = this._storageStateApplied.get(existing);
    if (!applied) {
      applied = applyStorageStateToReusedContext(this.config, existing);
      this._storageStateApplied.set(existing, applied);
      applied.catch(() => this._storageStateApplied.delete(existing));
    }
    await applied;
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
  // See CdpContextFactory: fresh context when isolated, setStorageState otherwise.
  readonly appliesStorageState = true;

  constructor(config: FullConfig) {
    this.config = config;
  }

  async createContext(clientInfo: ClientInfo): Promise<{ browserContext: playwright.BrowserContext, close: () => Promise<void> }> {
    const cdpLaunch = this.config.browser.cdpLaunch!;
    const port = cdpLaunch.port ?? await findFreePort();
    const endpoint = `http://127.0.0.1:${port}`;
    const args = (cdpLaunch.args ?? []).map(arg => arg.replaceAll('{port}', String(port)));
    const childProcess = spawn(cdpLaunch.command, args, {
      cwd: cdpLaunch.cwd,
      env: {
        ...process.env,
        ...cdpLaunch.env,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    childProcess.stderr.on('data', data => {
      testDebug(`cdp-launch stderr: ${String(data).trimEnd()}`);
    });

    const browser = await this._waitForBrowser(endpoint, clientInfo, childProcess, cdpLaunch.startupTimeoutMs ?? 30000);
    let browserContext: playwright.BrowserContext;
    try {
      if (this.config.browser.isolated) {
        browserContext = await browser.newContext(this.config.browser.contextOptions);
      } else {
        const existing = browser.contexts()[0];
        if (existing) {
          await applyStorageStateToReusedContext(this.config, existing);
          browserContext = existing;
        } else {
          // See CdpContextFactory: a launched app can expose no context yet;
          // a fresh one with the configured options beats an undefined one.
          browserContext = await browser.newContext(this.config.browser.contextOptions);
        }
      }
    } catch (error) {
      // The desktop process is already running by now; failing to obtain a
      // context (say, an unreadable storage-state file) must not leave it and
      // the CDP connection behind with nobody holding a close() for them.
      await browser.close().catch(logUnhandledError);
      childProcess.kill('SIGTERM');
      throw error;
    }
    return {
      browserContext,
      close: async () => {
        await browser.close().catch(logUnhandledError);
        childProcess.kill('SIGTERM');
      }
    };
  }

  private async _waitForBrowser(endpoint: string, clientInfo: ClientInfo, childProcess: ReturnType<typeof spawn>, startupTimeoutMs: number): Promise<playwright.Browser> {
    const deadline = Date.now() + startupTimeoutMs;
    const connectOptions: playwright.ConnectOverCDPOptions = {
      headers: cdpConnectHeaders(clientInfo, this.config.browser),
      timeout: this.config.browser.cdpTimeout,
      noDefaults: true,
    };
    for (;;) {
      try {
        return await playwright.chromium.connectOverCDP(endpoint, connectOptions);
      } catch (error) {
        testDebug(`connect over CDP failed for ${endpoint}: ${String(error)}`);
        if (Date.now() >= deadline) {
          childProcess.kill('SIGTERM');
          throw new Error(`Timed out waiting for CDP endpoint ${endpoint}.`);
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }
}

// Distinguishes a storage-state failure from a launch failure, so the launch
// retry loop never retries on one (a bad state file fails the same way 5 times).
class StorageStateError extends Error {}

class PersistentContextFactory implements BrowserContextFactory {
  readonly config: FullConfig;
  // launchPersistentContext() silently ignores a storageState option, so the
  // state is applied to the launched context with setStorageState() instead.
  readonly appliesStorageState = true;
  readonly name = 'persistent';
  readonly description = 'Create a new persistent browser context';

  private _userDataDirs = new Set<string>();

  constructor(config: FullConfig) {
    this.config = config;
  }

  async createContext(clientInfo: ClientInfo): Promise<{ browserContext: playwright.BrowserContext, close: () => Promise<void> }> {
    await injectCdpPort(this.config.browser);
    testDebug('create browser context (persistent)');
    // launchPersistentContext() accepts a storageState option without applying
    // it (verified against 1.61.1) — the profile is normally the state — so it
    // is stripped here and applied explicitly after launch.
    const { storageState, ...contextOptions } = this.config.browser.contextOptions ?? {};
    // setStorageState() resets cookies globally but origin storage only for
    // origins in the state or known to the fresh context object, so stale
    // localStorage/IndexedDB in a previously used profile would survive and
    // could sign the audit in as the wrong identity. A storage-state session
    // therefore runs in its own fresh disposable profile — unique per context,
    // because one server can hold several live sessions and a shared
    // deterministic directory would let one session's setup destroy another's
    // running profile — removed again when the context closes. A user-supplied
    // profile cannot be treated this way — it is data we do not own — and
    // keeping it contradicts "start from the recorded state", so that
    // combination errors.
    assertStorageStateDoesNotResetUserProfile(this.config, 'Drop --user-data-dir (a managed, disposable profile is used for storage-state sessions), or drop the storage state and sign in in that profile instead.');
    // Trace setup runs before the disposable profile exists: it can fail (an
    // unwritable output directory), and nothing after the directory is created
    // may throw outside the cleanup scope below, or failed starts would leave
    // stray profiles behind.
    const tracesDir = await startTraceServer(this.config, clientInfo.rootPath);
    const userDataDir = this.config.browser.userDataDir ?? await this._createUserDataDir(clientInfo.rootPath, storageState ? `-storage-state-${createGuid()}` : '');

    this._userDataDirs.add(userDataDir);
    testDebug('lock user data dir', userDataDir);

    const browserType = playwright[this.config.browser.browserName];
    try {
      for (let i = 0; i < 5; i++) {
        try {
          const browserContext = await browserType.launchPersistentContext(userDataDir, {
            tracesDir,
            ...this.config.browser.launchOptions,
            ...contextOptions,
            handleSIGINT: false,
            handleSIGTERM: false,
          });
          return await this._applyStorageState(browserContext, storageState, userDataDir);
        } catch (error: any) {
          if (error instanceof StorageStateError)
            throw error;
          if (error.message.includes('Executable doesn\'t exist'))
            throw browserNotInstalledError(error);
          if (error.message.includes('ProcessSingleton') || error.message.includes('Invalid URL')) {
            // User data directory is already in use, try again.
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          }
          throw error;
        }
      }
      throw new Error(`Browser is already in use for ${userDataDir}, use --isolated to run multiple instances of the same browser`);
    } catch (error) {
      // The disposable profile belongs to this context alone, so a launch that
      // never produced a context must not leave it behind — repeated failed
      // starts would otherwise pile one stray directory into the registry each.
      // (Already removed on the StorageStateError path; rm is idempotent.)
      if (storageState) {
        await fs.promises.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
        this._userDataDirs.delete(userDataDir);
      }
      throw error;
    }
  }

  // Separate from the launch retry loop: its `catch` retries on messages a
  // malformed storage-state file could coincidentally match (`Invalid URL`).
  private async _applyStorageState(browserContext: playwright.BrowserContext, storageState: NonNullable<FullConfig['browser']['contextOptions']>['storageState'], userDataDir: string): Promise<{ browserContext: playwright.BrowserContext, close: () => Promise<void> }> {
    if (storageState) {
      try {
        await browserContext.setStorageState(storageState);
      } catch (error) {
        // Nobody holds a close() for this context yet, so a bad storage-state
        // file must not leave the launched browser running.
        await this._closeBrowserContext(browserContext, userDataDir, true);
        throw new StorageStateError(error instanceof Error ? error.message : String(error));
      }
    }
    const close = () => this._closeBrowserContext(browserContext, userDataDir, !!storageState);
    return { browserContext, close };
  }

  private async _closeBrowserContext(browserContext: playwright.BrowserContext, userDataDir: string, disposeUserDataDir = false) {
    testDebug('close browser context (persistent)');
    testDebug('release user data dir', userDataDir);
    await browserContext.close().catch(() => {});
    // A storage-state profile is unique to this context and holds nothing worth
    // keeping — the state file is the durable copy — so it is removed rather
    // than left to pile up next to the regular persistent profile.
    if (disposeUserDataDir)
      await fs.promises.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    this._userDataDirs.delete(userDataDir);
    testDebug('close browser context complete (persistent)');
  }

  // The suffix keeps disposable storage-state profiles apart from the regular
  // persistent profile (and, carrying a per-context guid, from each other), so
  // removing one can never destroy an interactive session or a sibling's.
  private async _createUserDataDir(rootPath: string | undefined, suffix: string) {
    const dir = process.env.PWMCP_PROFILES_DIR_FOR_TEST ?? registryDirectory;
    const browserToken = this.config.browser.launchOptions?.channel ?? this.config.browser?.browserName;
    // Hesitant putting hundreds of files into the user's workspace, so using it for hashing instead.
    const rootPathToken = rootPath ? `-${createHash(rootPath)}` : '';
    const result = path.join(dir, `mcp-${browserToken}${rootPathToken}${suffix}`);
    await fs.promises.mkdir(result, { recursive: true });
    return result;
  }
}

async function injectCdpPort(browserConfig: FullConfig['browser']) {
  if (browserConfig.browserName === 'chromium')
    (browserConfig.launchOptions as any).cdpPort = await findFreePort();
}

/**
 * Builds the HTTP headers sent with a `connectOverCDP` request: the client
 * User-Agent plus any user-configured `browser.cdpHeaders`. Returns undefined
 * when there is nothing to send.
 */
function cdpConnectHeaders(clientInfo: ClientInfo, browserConfig: FullConfig['browser']): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  const userAgent = [clientInfo.name, clientInfo.version].filter(Boolean).join('/');
  if (userAgent)
    headers['User-Agent'] = userAgent;
  Object.assign(headers, browserConfig.cdpHeaders);
  return Object.keys(headers).length ? headers : undefined;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/**
 * Builds the user-facing "browser not installed" error from Playwright's raw
 * launch failure. When the raw message carries a version-specific executable
 * path (e.g. `chromium-1234`), that path is surfaced so a version mismatch is
 * distinguishable from a genuinely missing install; otherwise the generic
 * message is returned unchanged. Mirrors Playwright MCP throwIfExecutableMissing
 * (microsoft/playwright#41941).
 */
function browserNotInstalledError(error: Error): Error {
  const match = error.message.match(/Executable doesn't exist at ([^\r\n]+)/);
  const location = match ? `; expected executable at ${match[1].trim()}` : '';
  return new Error(`Browser specified in your config is not installed${location}. Either install it (likely) or change the config.`);
}

async function startTraceServer(config: FullConfig, rootPath: string | undefined): Promise<string | undefined> {
  if (!config.saveTrace)
    return undefined;

  const tracesDir = await outputFile(config, rootPath, `traces-${Date.now()}`);
  const server = await startTraceViewerServer();
  const urlPrefix = server.urlPrefix('human-readable');
  const url = urlPrefix + '/trace/index.html?trace=' + tracesDir + '/trace.json';
  // eslint-disable-next-line no-console
  console.error('\nTrace viewer listening on ' + url);
  return tracesDir;
}
