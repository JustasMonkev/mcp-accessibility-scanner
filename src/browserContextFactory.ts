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
import { createGuid, createHash, createShortGuid } from './utils/guid.js';
import { outputFile  } from './config.js';
import { ensureNetworkPolicyRoutes } from './networkPolicy.js';

import type { FullConfig } from './config.js';

/** Rejects factories that would silently ignore a configured storage state. */
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
  // Factories must apply the state to a fresh context or reject unsafe reuse.
  assertStorageStateSupported(config, factory, 'Drop the storage state and sign in interactively before auditing.');
  return factory;
}

/**
 * Replaces every open page of `browserContext` with a blank fresh tab and
 * returns the fresh tabs paired with the URL each replaced page showed.
 * Replacement, not an in-page sessionStorage clear plus reload: the old
 * document's scripts keep running between an evaluated clear and the
 * navigation that would follow it, and a timer persisting the previous
 * identity can write it back into that window — sessionStorage survives the
 * reload, and the audit reads the old user again. A fresh tab starts with
 * empty sessionStorage for every origin (only window.open clones the
 * opener's copy, verified against Playwright 1.61.1 Chromium). The
 * replacement tab is created before the old page closes — closing a
 * browser's last tab can take the whole (attached, user-owned) browser down
 * with it.
 */
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
      // Without a replacement tab (Electron targets cannot create pages),
      // closing is the only way to keep the previous identity's DOM and
      // sessionStorage out of the audit.
      await page.close();
      return;
    }
    // The replacement never needs replacing itself — it must not be swept up
    // by the loop below when it surfaces through pages() or the listener.
    seen.add(fresh);
    try {
      await page.close();
    } catch (error) {
      await fresh.close().catch(() => {});
      throw error;
    }
    replaced.push({ page: fresh, url });
  };
  // A still-old document can open a page while the ones above are being
  // replaced — a popup from a timer, say — and a same-origin popup clones
  // its opener's previous-identity sessionStorage at creation. A single
  // pages() snapshot would hand such a page to Context unreset, so the sweep
  // repeats until no unseen page remains; the temporary 'page' listener
  // catches pages whose creation the next pages() call cannot see yet. The
  // Set dedupes a page that arrives through both — two concurrent
  // replacements of one page would race each other's close.
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

/**
 * Navigates each replacement tab to the URL its replaced page showed, bringing
 * what a scan sees onto the state the context now holds. A tab that cannot
 * load its page — the origin may be blocked by the just-installed policy, or
 * the load simply failed — is blanked instead (the fresh tab carries no old
 * identity, so a blank one is safe to hand to Context), and closed only when
 * even blanking fails.
 */
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

/** Existing contexts can contain service workers and storage we cannot safely snapshot. */
export function assertReusedContextStorageStateSupported(config: FullConfig): void {
  if (config.browser.contextOptions?.storageState)
    throw new Error('Cannot apply --storage-state to an existing browser context on Playwright 1.63.0: its rollback snapshot can run service-worker-served scripts and alter storage. Use a fresh context (for CDP, add --isolated), or omit --storage-state and sign in interactively. No storage snapshot or reset was attempted.');
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

export type ClientInfo = { name?: string, version?: string };

export type CreateContextOptions = {
  /**
   * True when the context backs an explicitly opened browser session
   * (`browser_session_open`) — or the ephemeral default context of a
   * stateless per-request HTTP backend — rather than the long-lived default
   * session. The persistent factory gives such contexts their own disposable
   * profile: the stable `mcp-<browser>-<workspace>` profile can back only one running
   * browser at a time, so concurrent contexts sharing it would fail with
   * "Browser is already in use".
   */
  browserSession?: boolean;
};

export interface BrowserContextFactory {
  /** Attaches to one shared browser context across stateless requests. */
  readonly sharedContext?: boolean;
  /**
   * Set when attaching waits for the user (the extension must be connected),
   * so a tools/list, which clients send unprompted at startup, never attaches.
   */
  readonly attachNeedsUser?: boolean;
  /**
   * True when createContext() honors config.browser.contextOptions.storageState
   * or explicitly rejects contexts where it cannot safely do so. Omitted counts as
   * false, so a factory that forgets to declare it rejects a storage state rather
   * than dropping it silently.
   */
  readonly appliesStorageState?: boolean;
  /**
   * Set when this factory cannot give each Context a browser context of its
   * own — every wrapper it returns shares one live context, tabs, cookies and
   * storage included. `browser_session_open` refuses to open explicit browser
   * sessions in these modes with this reason: a handle that silently routed
   * into the shared context would advertise a separation that does not exist.
   * Undefined (or omitted) means separate per-session contexts are supported.
   */
  readonly sessionsUnsupportedReason?: string;
  /**
   * `closeStarting`, when present, is the owning Context's advance notice
   * that `close()` will follow — invoked synchronously when the Context
   * begins its shutdown, ahead of async cleanup (the bounded pending-download
   * drain) that can hold the actual `close()` call open for tens of seconds.
   * The persistent factory uses it to tell a stable-profile holder that is
   * closing apart from one that is concurrently alive.
   */
  createContext(clientInfo: ClientInfo, abortSignal: AbortSignal, toolName: string | undefined, options?: CreateContextOptions): Promise<{ browserContext: playwright.BrowserContext, close: () => Promise<void>, closeStarting?: () => void }>;
}

abstract class BaseContextFactory implements BrowserContextFactory {
  abstract readonly appliesStorageState: boolean;
  readonly config: FullConfig;
  private _logName: string;
  protected _browserPromise: Promise<playwright.Browser> | undefined;

  // Counts live handouts per browser object, claimed BEFORE awaiting context
  // creation — the same pattern as CdpContextFactory. A `browser.contexts()`
  // census cannot see a sibling still inside _doCreateContext(): if session
  // A's close ran while session B's first newContext() was in flight, A saw
  // itself as the last context and closed the shared browser out from under
  // B. Keyed per browser object (not per factory) because an external
  // disconnect makes _obtainBrowser hand out a fresh browser while stale
  // handouts still reference the old one.
  private _handoutCounts = new WeakMap<playwright.Browser, number>();

  // Acquisitions that have entered createContext() but not yet claimed their
  // per-browser handout count: `await` yields to the microtask queue even on
  // an already-resolved browser promise, so a sibling's close running inside
  // that window used to see zero remaining handouts and shut the shared
  // browser down under the resuming caller. Registered synchronously before
  // the first await (see _acquireBrowser) and consulted by every "am I the
  // last one?" check. Keyed per obtain promise, not per factory: a pending
  // acquisition on a NEW promise (after an external disconnect evicted the
  // old one) must not keep the old browser from closing.
  private _pendingAcquisitions = new Map<Promise<playwright.Browser>, number>();

  constructor(name: string, config: FullConfig) {
    this._logName = name;
    this.config = config;
  }

  // Deliberately not async: the returned promise must be the cached
  // `_browserPromise` itself so callers can register pending acquisitions
  // against it and use it for the identity guards, and the body must run
  // synchronously so obtaining and registering happen in one continuation.
  protected _obtainBrowser(clientInfo: ClientInfo): Promise<playwright.Browser> {
    if (this._browserPromise)
      return this._browserPromise;
    testDebug(`obtain browser (${this._logName})`);
    const promise = this._doObtainBrowser(clientInfo);
    this._browserPromise = promise;
    // The eviction is bound to the promise this browser came from — the same
    // identity guard the close paths use: a close evicts the cache eagerly,
    // so by the time the closing browser's asynchronous 'disconnected' fires
    // (or a failed obtain rejects), a successor connection may already be
    // cached, and clearing it would churn yet another browser for the next
    // session while the successor is alive.
    void promise.then(browser => {
      browser.on('disconnected', () => {
        if (this._browserPromise === promise)
          this._browserPromise = undefined;
      });
    }).catch(() => {
      if (this._browserPromise === promise)
        this._browserPromise = undefined;
    });
    return promise;
  }

  protected abstract _doObtainBrowser(clientInfo: ClientInfo): Promise<playwright.Browser>;

  /**
   * Obtains the shared browser and claims the caller's per-browser count via
   * `claim`, atomically with the browser's delivery: the acquisition is
   * registered in a synchronous counter before the first await, and `claim`
   * runs in the same continuation that resolves the browser, so at every
   * point the caller is visible either as pending or as a live handout. The
   * close paths consult _hasPendingAcquisition() and defer the browser
   * shutdown to a pending acquisition instead of treating themselves as last.
   */
  protected async _acquireBrowser(clientInfo: ClientInfo, claim: (browser: playwright.Browser) => void): Promise<{ browser: playwright.Browser, obtainedPromise: Promise<playwright.Browser> }> {
    const obtainedPromise = this._obtainBrowser(clientInfo);
    this._pendingAcquisitions.set(obtainedPromise, (this._pendingAcquisitions.get(obtainedPromise) ?? 0) + 1);
    try {
      const browser = await obtainedPromise;
      claim(browser);
      return { browser, obtainedPromise };
    } finally {
      const pending = (this._pendingAcquisitions.get(obtainedPromise) ?? 1) - 1;
      if (pending > 0)
        this._pendingAcquisitions.set(obtainedPromise, pending);
      else
        this._pendingAcquisitions.delete(obtainedPromise);
    }
  }

  /**
   * True while a createContext() has started against `obtainedPromise` but
   * not yet claimed its per-browser count. A release that would otherwise be
   * the last defers the browser shutdown to that acquisition — which either
   * claims the count in the same continuation the promise resolves in (its
   * own release then closes the browser), or fails to obtain the browser
   * altogether, in which case there is no browser left to close (a rejected
   * obtain never launched one).
   */
  protected _hasPendingAcquisition(obtainedPromise: Promise<playwright.Browser>): boolean {
    return !!this._pendingAcquisitions.get(obtainedPromise);
  }

  private _releaseHandout(browser: playwright.Browser): boolean {
    const remaining = Math.max(0, (this._handoutCounts.get(browser) ?? 1) - 1);
    this._handoutCounts.set(browser, remaining);
    return remaining === 0;
  }

  async createContext(clientInfo: ClientInfo): Promise<{ browserContext: playwright.BrowserContext, close: () => Promise<void> }> {
    testDebug(`create browser context (${this._logName})`);
    // `obtainedPromise` is the promise this browser came from — it guards the
    // eager `_browserPromise` resets below: after an external disconnect a
    // NEW promise may be in place, and clearing it would orphan the fresh
    // connection other sessions are about to use.
    const { browser, obtainedPromise } = await this._acquireBrowser(clientInfo, acquired => {
      this._handoutCounts.set(acquired, (this._handoutCounts.get(acquired) ?? 0) + 1);
    });
    let browserContext: playwright.BrowserContext;
    try {
      browserContext = await this._doCreateContext(browser);
    } catch (error) {
      // The handout never materialized. When it was the last one, the browser
      // must not stay behind ownerless — a sibling's close may have deferred
      // the browser shutdown to this in-flight creation.
      if (this._releaseHandout(browser) && !this._hasPendingAcquisition(obtainedPromise)) {
        if (this._browserPromise === obtainedPromise)
          this._browserPromise = undefined;
        testDebug(`close browser (${this._logName})`);
        await browser.close().catch(logUnhandledError);
      }
      throw error;
    }
    let released = false;
    return {
      browserContext,
      close: async () => {
        if (released)
          return;
        released = true;
        testDebug(`close browser context (${this._logName})`);
        const last = this._releaseHandout(browser) && !this._hasPendingAcquisition(obtainedPromise);
        // Cleared before the awaits so a createContext() arriving while this
        // close is still in flight obtains a fresh browser instead of the
        // closing one.
        if (last && this._browserPromise === obtainedPromise)
          this._browserPromise = undefined;
        await browserContext.close().catch(logUnhandledError);
        if (last) {
          testDebug(`close browser (${this._logName})`);
          await browser.close().catch(logUnhandledError);
        }
      },
    };
  }

  protected abstract _doCreateContext(browser: playwright.Browser): Promise<playwright.BrowserContext>;
}

class IsolatedContextFactory extends BaseContextFactory {
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
        if (error.message.includes('Executable doesn\'t exist'))
          throw browserNotInstalledError(error);
        throw error;
      });
    } finally {
      // Bound by the launched browser on success, free for reuse on failure —
      // either way the reservation has served its purpose.
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

  // Fresh contexts accept storage state; existing external contexts reject it.
  readonly appliesStorageState = true;

  // Contexts created by this factory already received the configured state.
  private _createdContexts = new WeakSet<playwright.BrowserContext>();
  // Serializes the no-context fallback the same way: two sessions arriving at
  // a contextless target must share one created context, not race two.
  private _fallbackContext = new WeakMap<playwright.Browser, Promise<playwright.BrowserContext>>();

  constructor(config: FullConfig) {
    super('cdp', config);
  }

  // Without --isolated every session gets the attached browser's one existing
  // context, so a "separate" browser session would share its tabs, cookies
  // and storage with everything else.
  get sessionsUnsupportedReason(): string | undefined {
    if (this.config.browser.isolated)
      return undefined;
    return 'this connection attaches to the browser\'s existing context, which every session would share (same tabs, cookies and storage). Add --isolated to give each session its own browser context.';
  }

  // The CDP connection (and with it every route and page proxy) is shared by
  // all live sessions of this factory, so nothing may close it while a
  // sibling session still audits through it — neither a session's own
  // close() nor the cleanup after another session's failed setup. The
  // handout count is kept per browser object, not per factory: an external
  // disconnect makes _obtainBrowser hand out a fresh browser while stale
  // sessions still hold references to the old one, and a shared counter
  // would let a stale release keep the new connection open forever (its last
  // real user would only ever bring the count down to the stale remainder).
  // The reference is claimed before context creation, so a sibling still
  // inside _doCreateContext() counts and a concurrent failure cannot close
  // the connection out from under it.
  private _sessionCounts = new WeakMap<playwright.Browser, number>();

  private _releaseBrowser(browser: playwright.Browser): boolean {
    const remaining = Math.max(0, (this._sessionCounts.get(browser) ?? 1) - 1);
    this._sessionCounts.set(browser, remaining);
    return remaining === 0;
  }

  override async createContext(clientInfo: ClientInfo): Promise<{ browserContext: playwright.BrowserContext, close: () => Promise<void> }> {
    testDebug('create browser context (cdp)');
    // `obtainedPromise` guards the eager `_browserPromise` evictions below —
    // same pattern as the base class: after an external disconnect a NEW
    // promise may be in place, and clearing it would orphan the fresh
    // connection other sessions are about to use. The session count is
    // claimed atomically with the browser's delivery (see _acquireBrowser),
    // so a sibling's close inside createContext's own await window defers to
    // this acquisition instead of disconnecting under it.
    const { browser, obtainedPromise } = await this._acquireBrowser(clientInfo, acquired => {
      this._sessionCounts.set(acquired, (this._sessionCounts.get(acquired) ?? 0) + 1);
    });
    let browserContext: playwright.BrowserContext;
    try {
      browserContext = await this._doCreateContext(browser);
    } catch (error) {
      // Without this the CDP connection stays open after e.g. an unreadable
      // storage-state file, even though no context was ever handed out — but
      // only when no sibling session is still using the shared connection.
      if (this._releaseBrowser(browser) && !this._hasPendingAcquisition(obtainedPromise)) {
        if (this._browserPromise === obtainedPromise)
          this._browserPromise = undefined;
        await browser.close().catch(logUnhandledError);
      }
      throw error;
    }
    let released = false;
    return {
      browserContext,
      close: async () => {
        if (released)
          return;
        released = true;
        // An isolated session's context belongs to it alone — close it now,
        // or abandoned contexts (with their pages, routes and listeners)
        // pile up on a long-lived shared connection until the last session
        // exits. The non-isolated context is the browser's own and shared;
        // it stays.
        if (this.config.browser.isolated)
          await browserContext.close().catch(logUnhandledError);
        if (this._releaseBrowser(browser) && !this._hasPendingAcquisition(obtainedPromise)) {
          // Evicted before the await so a createContext() arriving while
          // this disconnect is still in flight obtains a fresh connection
          // instead of the closing one — the 'disconnected' event that also
          // clears the cache fires too late to catch that window.
          if (this._browserPromise === obtainedPromise)
            this._browserPromise = undefined;
          testDebug('disconnect browser (cdp)');
          await browser.close().catch(logUnhandledError);
        }
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
    // undefined context to the caller. Track ownership so later sessions may
    // join that context; memoize creation so concurrent arrivals share it.
    if (!existing) {
      let creating = this._fallbackContext.get(browser);
      if (!creating) {
        creating = browser.newContext(this.config.browser.contextOptions).then(created => {
          this._createdContexts.add(created);
          // Evict on close, or a context closed externally (while the
          // connection lives on) would keep being handed out of this memo to
          // every later session — contexts() no longer lists it, so only the
          // memo would remember it, forever.
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
  // See CdpContextFactory: fresh context when isolated, setStorageState otherwise.
  readonly appliesStorageState = true;

  // The live child launched on a pinned --cdp-launch-port, tracked from spawn
  // until the process exits. The sessionsUnsupportedReason veto below keeps
  // registry sessions off this path, but DEFAULT contexts reach it too —
  // parallel handshake-free HTTP requests each build a per-request backend
  // whose default context launches here — and a second launch against the
  // pinned port cannot work while the first child lives: its own child can
  // never bind the busy port, so the connect loop attaches to the FIRST
  // child's endpoint, the "separate" context lands in a sibling's
  // application, and cleanup kills a child that owns nothing. Serializing
  // the launches would not fix that — the port stays bound for the first
  // context's whole lifetime, so a queued second launch could only time out
  // or cross-attach after all — hence the second concurrent context is
  // honestly rejected instead. `closing` marks a teardown in progress (kill
  // sent), which a new arrival may briefly wait out rather than failing a
  // plain sequential close-then-relaunch on the OS shutdown tail.
  private _pinnedPortLaunch: { closing: boolean, exited: Promise<void> } | undefined;

  constructor(config: FullConfig) {
    this.config = config;
  }

  // Without --isolated a session would reuse a launched application's single
  // existing context. With --isolated each context is created fresh, at the
  // documented cost of launching another application instance per context —
  // unless the port is pinned: then every session's child is launched against
  // the SAME endpoint, the second session's connect loop reaches the first
  // session's instance (its own child never bound the busy port), its
  // "separate" context lands in a sibling's application, and its cleanup
  // kills a child that owns nothing while leaking that context.
  get sessionsUnsupportedReason(): string | undefined {
    if (!this.config.browser.isolated)
      return 'without --isolated each session would attach to a launched application\'s single shared context (same tabs, cookies and storage). Add --isolated to give each session its own browser context.';
    if (this.config.browser.cdpLaunch?.port !== undefined)
      return 'the pinned --cdp-launch-port can serve only one launched application at a time, so a second session would attach to the first session\'s instance. Drop --cdp-launch-port (each session then launches on its own free port) or run one session at a time.';
    return undefined;
  }

  async createContext(clientInfo: ClientInfo): Promise<{ browserContext: playwright.BrowserContext, close: () => Promise<void> }> {
    const cdpLaunch = this.config.browser.cdpLaunch!;
    if (cdpLaunch.port !== undefined) {
      await this._waitForClosingPinnedPortHolder(cdpLaunch);
      // Checked synchronously with the spawn-and-track below (nothing awaits
      // in between on the pinned path): a concurrent createContext() resuming
      // from the same wait could otherwise interleave here and both would
      // launch against the one port.
      this._assertPinnedPortFree(cdpLaunch);
    }
    // Reserved until the child is known to have bound the port (or the launch
    // failed): findFreePort()'s probe socket is closed before the child
    // spawns, so a concurrent session's probe could otherwise be handed the
    // same port — both connect loops would then attach to whichever child
    // bound first, sharing its context and killing the wrong child on
    // cleanup (exactly the confusion the pinned-port session veto exists to
    // prevent). In-process reservation suffices: the realistic collision
    // source is concurrent createContext() calls in this process racing one
    // OS port pool.
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

      // A successful connect proves the child owns the port, so the OS can no
      // longer hand it to a sibling's probe; on failure the child is already
      // killed and the port free again.
      browser = await this._waitForBrowser(endpoint, clientInfo, childProcess, cdpLaunch.startupTimeoutMs ?? 30000);
    } catch (error) {
      // _waitForBrowser has already killed the child on failure; marking the
      // tracked launch closing lets the next pinned-port context wait out the
      // exit instead of rejecting against a corpse.
      if (pinnedLaunch)
        pinnedLaunch.closing = true;
      throw error;
    } finally {
      if (allocatedPort !== undefined)
        reservedPorts.delete(allocatedPort);
    }
    let browserContext: playwright.BrowserContext;
    try {
      if (this.config.browser.isolated) {
        browserContext = await browser.newContext(this.config.browser.contextOptions);
      } else {
        const existing = browser.contexts()[0];
        if (existing) {
          assertReusedContextStorageStateSupported(this.config);
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
      if (pinnedLaunch)
        pinnedLaunch.closing = true;
      await browser.close().catch(logUnhandledError);
      childProcess.kill('SIGTERM');
      throw error;
    }
    return {
      browserContext,
      close: async () => {
        if (pinnedLaunch)
          pinnedLaunch.closing = true;
        await browser.close().catch(logUnhandledError);
        childProcess.kill('SIGTERM');
      }
    };
  }

  /**
   * Waits out a pinned-port holder whose teardown has already begun (kill
   * sent, exit pending), bounded by the configured startup timeout — the
   * same budget a launch gets — so a plain sequential close-then-relaunch
   * does not flake on the child's asynchronous exit. A holder that is NOT
   * closing is genuine concurrency; _assertPinnedPortFree rejects it.
   */
  private async _waitForClosingPinnedPortHolder(cdpLaunch: NonNullable<FullConfig['browser']['cdpLaunch']>): Promise<void> {
    const previous = this._pinnedPortLaunch;
    if (!previous?.closing)
      return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        previous.exited,
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, cdpLaunch.startupTimeoutMs ?? 30000);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Rejects a pinned-port launch while another live context's child still
   * holds the port (see _pinnedPortLaunch). Synchronous, so callers can bind
   * the check to the spawn without an interleaving window. */
  private _assertPinnedPortFree(cdpLaunch: NonNullable<FullConfig['browser']['cdpLaunch']>): void {
    if (this._pinnedPortLaunch)
      throw new Error(`The pinned --cdp-launch-port ${cdpLaunch.port} already serves a launched application from another live browser context, and a second launch on the same port would silently attach to that application instead of its own. Close the other context first, or drop --cdp-launch-port so each context launches on its own free port.`);
  }

  /** Tracks the pinned-port child until its process is gone; identity-guarded
   * so a stale exit can never untrack a successor's launch. The 'error'
   * listener covers a spawn that never produces an 'exit' (e.g. ENOENT). */
  private _trackPinnedPortChild(childProcess: ReturnType<typeof spawn>): NonNullable<CdpLaunchContextFactory['_pinnedPortLaunch']> {
    const launch = { closing: false, exited: undefined as unknown as Promise<void> };
    launch.exited = new Promise<void>(resolve => {
      const done = () => {
        if (this._pinnedPortLaunch === launch)
          this._pinnedPortLaunch = undefined;
        resolve();
      };
      childProcess.once('exit', done);
      childProcess.once('error', done);
    });
    this._pinnedPortLaunch = launch;
    return launch;
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

// Shared with the --connect-tool startup validation in program.ts, so the
// lazy rejection here and the eager one there never drift apart.
export const persistentProfileConflictRemedy = 'Drop --user-data-dir (a managed, disposable profile is used for storage-state sessions), or drop the storage state and sign in in that profile instead.';

export class PersistentContextFactory implements BrowserContextFactory {
  readonly config: FullConfig;
  // launchPersistentContext() silently ignores a storageState option, so the
  // state is applied to the launched context with setStorageState() instead.
  readonly appliesStorageState = true;
  readonly name = 'persistent';
  readonly description = 'Create a new persistent browser context';

  private _userDataDirs = new Set<string>();

  // Set while a live context (or one still launching) holds the stable
  // `mcp-<browser>-<workspace>` profile. The profile can back only one running browser at
  // a time (Chromium's ProcessSingleton lock), and every stateful backend's
  // default context resolves to it — one such context under stdio, but each
  // concurrent Mcp-Session-Id HTTP client brings its own backend, and the
  // second used to spin on the lock and fail with "Browser is already in
  // use". The stable profile goes to the FIRST claimant; genuinely
  // concurrent claimants fall back to a disposable profile (their audit
  // runs, without the stable profile's sign-in state), and the claim is
  // released when the holder's context closes so the next default context —
  // and the profile's persisted state — line up again. Checked-and-set
  // synchronously, so concurrent createContext() calls cannot both claim.
  //
  // A holder that has BEGUN closing (`closing`, set via the handle's
  // closeStarting notice) is a release in progress, not genuine concurrency:
  // its async shutdown — dominated by the Context's bounded pending-download
  // drain — can outlast a --connect-tool/--vscode provider switch-away, and a
  // claimant arriving in that window (the user switching back) used to be
  // silently demoted to a disposable profile, losing the stable profile's
  // sign-in state. Such a claimant now waits on `released` (bounded: the
  // drain is capped at 30s and the browser shutdown bounds the rest) and
  // then claims the stable profile itself.
  private _stableProfileClaim: {
    closing: boolean;
    released: Promise<void>;
    // Frees the claim (identity-guarded, so a stale release can never free a
    // successor's claim) and resolves `released`; idempotent.
    release: () => void;
  } | undefined;

  // Claims the stable profile for one context. Synchronous, so a concurrent
  // createContext() cannot interleave between check and set.
  private _claimStableProfile(): NonNullable<PersistentContextFactory['_stableProfileClaim']> {
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

  // A user-supplied profile directory can back only one running browser at a
  // time (Chromium's ProcessSingleton lock), and minting disposable profiles
  // behind the user's back would silently drop the sign-in state they asked
  // for — so explicit sessions are refused in that configuration. Without
  // --user-data-dir, sessions run in their own disposable profiles below.
  get sessionsUnsupportedReason(): string | undefined {
    if (this.config.browser.userDataDir)
      return 'the configured --user-data-dir profile can back only one running browser at a time. Drop --user-data-dir (extra sessions run in their own disposable profiles) or use --isolated.';
    return undefined;
  }

  async createContext(clientInfo: ClientInfo, _abortSignal?: AbortSignal, _toolName?: string, options?: CreateContextOptions): Promise<{ browserContext: playwright.BrowserContext, close: () => Promise<void>, closeStarting?: () => void }> {
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
    assertStorageStateDoesNotResetUserProfile(this.config, persistentProfileConflictRemedy);
    // Trace setup runs before the disposable profile exists: it can fail (an
    // unwritable output directory), and nothing after the directory is created
    // may throw outside the cleanup scope below, or failed starts would leave
    // stray profiles behind.
    const tracesDir = await startTraceServer(this.config);
    // Per-launch and reserved until this launch binds it: two explicit
    // sessions launching concurrently interleave their awaits here, and a
    // port written into the shared config would be overwritten by the
    // sibling before launchPersistentContext() reads it — both browsers
    // then race for one port and one fails to bind.
    const { cdpPortOptions, releaseCdpPort } = await allocateCdpPort(this.config.browser);
    // An explicitly opened browser session gets its own disposable profile for
    // the same reason a storage-state context does: the stable profile can back
    // only one running browser, so a second session sharing it would spin on
    // the ProcessSingleton lock and fail with "Browser is already in use". The
    // DEFAULT (no-handle) context keeps the stable `mcp-<browser>-<workspace>` profile, so
    // its sign-in state still survives restarts.
    let profileSuffix = storageState
      ? `-storage-state-${createGuid()}`
      : options?.browserSession
        ? `-session-${createGuid()}`
        : '';
    let claim: PersistentContextFactory['_stableProfileClaim'];
    let userDataDir: string | undefined;
    let disposableProfile = false;
    const browserType = playwright[this.config.browser.browserName];
    // The cleanup scope opens right after the port reservation: the
    // profile-directory mkdir below can reject too (e.g. a transient volume
    // failure), and a failure between the claim and the launch loop used to
    // escape the cleanup — the claim was never reset (every later default
    // context misclassified as concurrent and demoted to a disposable
    // profile) and the reserved CDP port was never released.
    try {
      // A default (no-suffix) context claims the stable profile — unless a
      // sibling already holds it (see _stableProfileClaim): then it runs in
      // a disposable profile instead of failing the launch. A user-supplied
      // --user-data-dir is exempt: silently substituting a disposable profile
      // would drop the sign-in state the user explicitly asked for, so that
      // configuration keeps the launch-time contention error.
      if (!profileSuffix && !this.config.browser.userDataDir) {
        // A holder that has begun closing is a release in progress, not
        // genuine concurrency: wait for the release (bounded by the holder's
        // capped download drain and browser shutdown) instead of silently
        // demoting this context to a disposable profile. Re-checked after
        // the wait — another claimant may have won the freed claim.
        const holder = this._stableProfileClaim;
        if (holder?.closing) {
          testDebug('stable persistent profile holder is closing; waiting for its release');
          await holder.released;
        }
        if (this._stableProfileClaim) {
          profileSuffix = `-concurrent-${createGuid()}`;
          testDebug('stable persistent profile is in use by a concurrent context; falling back to a disposable profile');
        } else {
          claim = this._claimStableProfile();
        }
      }
      userDataDir = this.config.browser.userDataDir ?? await this._createUserDataDir(profileSuffix);
      // Guarded on the config profile too: sessionsUnsupportedReason keeps
      // registry sessions out of a user-supplied --user-data-dir, so a suffix
      // here always means the guid-fresh managed directory above — but a direct
      // caller combining both must still never see the user's profile deleted.
      disposableProfile = !!profileSuffix && !this.config.browser.userDataDir;

      this._userDataDirs.add(userDataDir);
      testDebug('lock user data dir', userDataDir);

      for (let i = 0; i < 5; i++) {
        try {
          const browserContext = await browserType.launchPersistentContext(userDataDir, {
            tracesDir,
            ...this.config.browser.launchOptions,
            ...cdpPortOptions,
            ...contextOptions,
            handleSIGINT: false,
            handleSIGTERM: false,
          });
          const result = await this._applyStorageState(browserContext, storageState, userDataDir, disposableProfile);
          if (!claim)
            return result;
          const heldClaim = claim;
          return {
            browserContext: result.browserContext,
            // The owning Context's advance notice that close() will follow
            // once its async cleanup (the bounded download drain) finishes:
            // from here on a new default claimant waits for the release
            // instead of treating this holder as genuine concurrency.
            closeStarting: () => { heldClaim.closing = true; },
            close: async () => {
              try {
                await result.close();
              } finally {
                // Released only after the browser has shut down, so the next
                // claimant's launch meets a freed ProcessSingleton lock (the
                // launch retry loop covers the OS-level shutdown tail).
                // release() is idempotent and identity-guarded, so a repeated
                // close() can never free a claim a successor context holds.
                heldClaim.release();
              }
            },
          };
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
      // A claim that never produced a context must not pin the stable profile
      // forever — the next default context would needlessly fall back to a
      // disposable profile with the stable one sitting free.
      claim?.release();
      // The disposable profile belongs to this context alone, so a launch that
      // never produced a context must not leave it behind — repeated failed
      // starts would otherwise pile one stray directory into the registry each.
      // (Already removed on the StorageStateError path; rm is idempotent.)
      if (disposableProfile && userDataDir !== undefined) {
        await fs.promises.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
        this._userDataDirs.delete(userDataDir);
      }
      throw error;
    } finally {
      // Bound by the launched browser on success, free for reuse on failure —
      // either way the reservation has served its purpose.
      releaseCdpPort();
    }
  }

  // Separate from the launch retry loop: its `catch` retries on messages a
  // malformed storage-state file could coincidentally match (`Invalid URL`).
  private async _applyStorageState(browserContext: playwright.BrowserContext, storageState: NonNullable<FullConfig['browser']['contextOptions']>['storageState'], userDataDir: string, disposableProfile: boolean): Promise<{ browserContext: playwright.BrowserContext, close: () => Promise<void> }> {
    if (storageState) {
      try {
        // Startup pages can keep persisting their anonymous identity while the
        // state lands. Park them on blank replacements before the apply, then
        // navigate the replacements only after the recorded state is installed.
        const replaced = await replaceOpenPagesWithBlankTabs(browserContext);
        await browserContext.setStorageState(storageState);
        await ensureNetworkPolicyRoutes(this.config, browserContext);
        await navigateReplacementPages(replaced);
      } catch (error) {
        // Nobody holds a close() for this context yet, so a bad storage-state
        // file must not leave the launched browser running.
        await this._closeBrowserContext(browserContext, userDataDir, disposableProfile);
        throw new StorageStateError(error instanceof Error ? error.message : String(error));
      }
    }
    const close = () => this._closeBrowserContext(browserContext, userDataDir, disposableProfile);
    return { browserContext, close };
  }

  private async _closeBrowserContext(browserContext: playwright.BrowserContext, userDataDir: string, disposeUserDataDir = false) {
    testDebug('close browser context (persistent)');
    testDebug('release user data dir', userDataDir);
    await browserContext.close().catch(() => {});
    // A storage-state or browser-session profile is unique to this context and
    // holds nothing worth keeping — the state file (or the default profile) is
    // the durable copy — so it is removed rather than left to pile up next to
    // the regular persistent profile.
    if (disposeUserDataDir)
      await fs.promises.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    this._userDataDirs.delete(userDataDir);
    testDebug('close browser context complete (persistent)');
  }

  // The suffix keeps disposable storage-state and browser-session profiles
  // apart from the regular persistent profile (and, carrying a per-context
  // guid, from each other), so removing one can never destroy an interactive
  // session or a sibling's.
  //
  // The workspace token keeps different servers' stable profiles apart. MCP
  // clients typically launch one stdio server per workspace, cwd'd into it, so
  // hashing process.cwd() gives each workspace its own deterministic profile:
  // sign-in state survives restarts of the same server (same cwd, same hash),
  // while servers for other workspaces neither contend for this profile's
  // ProcessSingleton lock nor inherit its cookies and storage. (This restores
  // the separation the deprecated MCP Roots hash used to provide — keyed on
  // the server's own launch directory instead of a client-reported root, so it
  // covers every client rather than only those that exposed roots.)
  private async _createUserDataDir(suffix: string) {
    const dir = process.env.PWMCP_PROFILES_DIR_FOR_TEST ?? registryDirectory;
    const browserToken = this.config.browser.launchOptions?.channel ?? this.config.browser?.browserName;
    const workspaceToken = `-${createHash(process.cwd())}`;
    const result = path.join(dir, `mcp-${browserToken}${workspaceToken}${suffix}`);
    await fs.promises.mkdir(result, { recursive: true });
    return result;
  }
}

/**
 * Allocates the CDP port for a Chromium launch, reserved until that launch has
 * bound it (or failed). The port travels in per-launch options instead of
 * being written into the shared config: concurrent launches from one factory
 * (e.g. two explicit persistent sessions) would otherwise overwrite each
 * other's `cdpPort` between allocation and launch and race for a single port.
 */
async function allocateCdpPort(browserConfig: FullConfig['browser']): Promise<{ cdpPortOptions: { cdpPort?: number }, releaseCdpPort: () => void }> {
  if (browserConfig.browserName !== 'chromium')
    return { cdpPortOptions: {}, releaseCdpPort: () => {} };
  const cdpPort = await findFreePort({ reserve: true });
  return { cdpPortOptions: { cdpPort }, releaseCdpPort: () => reservedPorts.delete(cdpPort) };
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

/**
 * Ports handed out by `findFreePort({ reserve: true })` whose intended owner
 * has not bound them yet. The probe socket below is closed before the caller
 * uses the port, so without this set two concurrent allocations in this
 * process could be handed the same port. Module-level because every factory
 * in the process draws from the one OS port pool.
 */
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
    // Reserved ports are skipped for every caller — nothing may be pointed at
    // a port a launched child is still starting up on. The check-and-reserve
    // is synchronous, so concurrent allocations cannot interleave inside it.
    if (reservedPorts.has(port))
      continue;
    if (options?.reserve)
      reservedPorts.add(port);
    return port;
  }
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

// One trace-viewer server and traces directory per config — i.e. per server
// run, the same WeakMap pattern as resolveOutputDir. startTraceViewerServer()
// binds a listening HTTP socket that nothing ever closes, so starting one per
// browser launch (the persistent factory launches per context, so every
// explicit-session open/close cycle) leaked a listener for the life of the
// process. Sharing one tracesDir across launches is safe for the trace files:
// each Context records under its own `trace-<guid>` name (see acquireTrace in
// context.ts), exactly as --isolated mode has always shared its per-browser
// tracesDir.
const traceServers = new WeakMap<FullConfig, Promise<string>>();

async function startTraceServer(config: FullConfig): Promise<string | undefined> {
  if (!config.saveTrace)
    return undefined;
  let started = traceServers.get(config);
  if (!started) {
    started = doStartTraceServer(config);
    traceServers.set(config, started);
    // A failed start (e.g. an unwritable output directory) is not memoized:
    // the next launch retries instead of replaying the rejection for the
    // process lifetime. Guarded by identity — a retry may already have
    // stored a fresh in-flight promise by the time this handler runs.
    started.catch(() => {
      if (traceServers.get(config) === started)
        traceServers.delete(config);
    });
  }
  return started;
}

async function doStartTraceServer(config: FullConfig): Promise<string> {
  // The random suffix keeps two configs resolving in the same millisecond
  // from sharing a trace folder. Nothing parses the folder name back.
  const tracesDir = await outputFile(config, `traces-${Date.now()}-${createShortGuid()}`);
  const server = await startTraceViewerServer();
  const urlPrefix = server.urlPrefix('human-readable');
  const url = urlPrefix + '/trace/index.html?trace=' + tracesDir + '/trace.json';
  // eslint-disable-next-line no-console
  console.error('\nTrace viewer listening on ' + url);
  return tracesDir;
}
