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
import { createGuid, createShortGuid } from './utils/guid.js';
import { outputFile  } from './config.js';
import { ensureNetworkPolicyRoutes } from './networkPolicy.js';

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

// The rules addCookies enforces client-side (verified against Playwright
// 1.61.1: empty or missing domain/path without a url, a url combined with a
// domain or a path, about:blank/data:/unparseable urls, an expires other
// than -1 or a positive number up to Playwright's ceiling, and sameSite
// outside Strict/Lax/None are all rejected there — non-http(s) url schemes
// and malformed origin strings fail browser-side during the apply). Failing
// them here keeps the failure ahead of the cache clear; anything these
// checks miss still fails inside setStorageState.
const cookieUrlProblem = (url: unknown): string | null => {
  if (typeof url !== 'string')
    return 'is not a string';
  if (url === 'about:blank')
    return 'cannot be about:blank';
  if (url.startsWith('data:'))
    return 'cannot be a data: URL';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return `must be an http(s) URL, not ${parsed.protocol}`;
  } catch {
    return 'is not a valid absolute URL';
  }
  return null;
};

const isValidIndexedDBKey = (value: unknown): boolean =>
  typeof value === 'string'
  || (typeof value === 'number' && Number.isFinite(value))
  || (value instanceof Date && Number.isFinite(value.getTime()))
  || value instanceof ArrayBuffer
  || ArrayBuffer.isView(value)
  || (Array.isArray(value) && value.every(isValidIndexedDBKey));

const indexedDBIdentifier = /^[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u;
const isValidIndexedDBKeyPath = (value: unknown): boolean =>
  typeof value === 'string' && (value === '' || value.split('.').every(part => indexedDBIdentifier.test(part)));
const isValidIndexedDBKeyPathArray = (value: unknown): boolean =>
  Array.isArray(value) && !!value.length && value.every(isValidIndexedDBKeyPath);

function assertValidStorageState(state: { cookies?: unknown[], origins?: unknown[] }): void {
  for (const value of state.cookies ?? []) {
    const cookie = value as Record<string, unknown> | null;
    const problem = !cookie || typeof cookie !== 'object'
      ? 'a cookie entry is not an object'
      : !cookie.url && (!cookie.domain || !cookie.path)
        ? `cookie "${String(cookie.name ?? '')}" should have a url or a domain/path pair`
        : cookie.url && cookie.domain
          ? `cookie "${String(cookie.name ?? '')}" should have either a url or a domain, not both`
          : cookie.url && cookie.path
            ? `cookie "${String(cookie.name ?? '')}" should have either a url or a path, not both`
            : cookie.url !== undefined && cookieUrlProblem(cookie.url)
              ? `cookie "${String(cookie.name ?? '')}" has a url that ${cookieUrlProblem(cookie.url)}`
              : cookie.expires !== undefined && (typeof cookie.expires !== 'number' || Number.isNaN(cookie.expires) || (cookie.expires !== -1 && (cookie.expires <= 0 || cookie.expires > 253402300799)))
                ? `cookie "${String(cookie.name ?? '')}" should have a valid expires — only -1 or a positive unix timestamp in seconds up to 253402300799 (9999-12-31T23:59:59Z, Playwright's own ceiling) is allowed`
                : cookie.sameSite !== undefined && !['Strict', 'Lax', 'None'].includes(cookie.sameSite as string)
                  ? `cookie "${String(cookie.name ?? '')}" has sameSite "${String(cookie.sameSite)}", expected one of Strict|Lax|None`
                  : null;
    if (problem)
      throw new Error(`Invalid storage state: ${problem}. Nothing was changed — the state is validated before the apply, because setStorageState() clears the attached context's HTTP cache and cookie jar before it validates, and the cache cannot be restored.`);
  }
  for (const value of state.origins ?? []) {
    const entry = value as Record<string, unknown> | null;
    // Restoring an origin's storage navigates Playwright's temporary page to
    // it — a malformed or non-http(s) origin fails that navigation after the
    // clear.
    const problem = !entry || typeof entry !== 'object'
      ? 'an origins entry is not an object'
      : typeof entry.origin !== 'string' || cookieUrlProblem(entry.origin)
        ? `origins entry "${String(entry?.origin ?? '')}" is not an absolute http(s) URL`
        : null;
    if (problem)
      throw new Error(`Invalid storage state: ${problem}. Nothing was changed — the state is validated before the apply, because setStorageState() clears the attached context's HTTP cache and cookie jar before it validates, and the cache cannot be restored.`);

    const databaseNames = new Set<string>();
    for (const value of Array.isArray(entry?.indexedDB) ? entry.indexedDB : []) {
      const database = value as Record<string, unknown>;
      const stores = Array.isArray(database.stores) ? database.stores as Record<string, unknown>[] : [];
      let indexedDBProblem = !Number.isSafeInteger(database.version) || (database.version as number) <= 0
        ? `IndexedDB database "${String(database.name ?? '')}" should have a positive integer version`
        : databaseNames.has(String(database.name))
          ? `IndexedDB database name "${String(database.name)}" is duplicated`
          : null;
      databaseNames.add(String(database.name));
      const storeNames = new Set<string>();
      for (const store of stores) {
        const storeName = String(store.name);
        indexedDBProblem ??= storeNames.has(storeName)
          ? `IndexedDB object store name "${storeName}" is duplicated in database "${String(database.name)}"`
          : store.keyPath !== undefined && !isValidIndexedDBKeyPath(store.keyPath)
            ? `IndexedDB object store "${storeName}" has an invalid key path`
            : store.keyPathArray !== undefined && !isValidIndexedDBKeyPathArray(store.keyPathArray)
              ? `IndexedDB object store "${storeName}" has an invalid array key path`
              : store.autoIncrement && (store.keyPath === '' || Array.isArray(store.keyPathArray))
            ? `IndexedDB object store "${storeName}" cannot combine autoIncrement with an empty or array key path`
              : null;
        storeNames.add(storeName);
        const recordKeys = new Set<string>();
        const hasInlineKey = store.keyPath !== undefined || store.keyPathArray !== undefined;
        for (const value of Array.isArray(store.records) ? store.records : []) {
          const record = value as Record<string, unknown>;
          const hasExternalKey = (record.key !== undefined && record.key !== null)
            || (record.keyEncoded !== undefined && record.keyEncoded !== null);
          const key = record.key ?? record.keyEncoded;
          const serializedKey = hasExternalKey ? JSON.stringify(key) ?? String(key) : '';
          indexedDBProblem ??= record.key !== undefined && record.key !== null && !isValidIndexedDBKey(record.key)
            ? `IndexedDB object store "${storeName}" has an invalid external record key`
            : hasInlineKey && hasExternalKey
            ? `IndexedDB object store "${storeName}" has an inline key path but record also supplies an external key`
            : !hasInlineKey && !store.autoIncrement && !hasExternalKey
              ? `IndexedDB object store "${storeName}" requires an external key for every record`
              : hasExternalKey && recordKeys.has(serializedKey)
                ? `IndexedDB object store "${storeName}" has duplicate record key ${serializedKey}`
                : null;
          if (hasExternalKey)
            recordKeys.add(serializedKey);
        }
        const indexNames = new Set<string>();
        for (const index of Array.isArray(store.indexes) ? store.indexes as Record<string, unknown>[] : []) {
          const indexName = String(index.name);
          indexedDBProblem ??= indexNames.has(indexName)
            ? `IndexedDB index name "${indexName}" is duplicated in object store "${storeName}"`
            : index.keyPath !== undefined && !isValidIndexedDBKeyPath(index.keyPath)
              ? `IndexedDB index "${indexName}" has an invalid key path`
              : index.keyPathArray !== undefined && !isValidIndexedDBKeyPathArray(index.keyPathArray)
                ? `IndexedDB index "${indexName}" has an invalid array key path`
                : index.multiEntry && Array.isArray(index.keyPathArray)
              ? `IndexedDB index "${indexName}" cannot combine multiEntry with an array key path`
                : null;
          indexNames.add(indexName);
        }
      }
      if (indexedDBProblem)
        throw new Error(`Invalid storage state: ${indexedDBProblem}. Nothing was changed — the state is validated before the apply, because setStorageState() clears the attached context's HTTP cache and cookie jar before it validates, and the cache cannot be restored.`);
    }
  }
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
  const parsedState = await (async () => {
    try {
      return typeof storageState === 'string'
        ? JSON.parse(await fs.promises.readFile(storageState, 'utf-8'))
        : storageState;
    } catch (error) {
      // Letting setStorageState() discover the bad file would fail inside
      // the apply block, whose catch answers every failure with a rollback —
      // and the rollback's own setStorageState() clears the attached
      // context's HTTP cache. A config error that changed nothing must not
      // cost the running application its cache.
      throw new Error(`The storage state file could not be read or parsed: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`);
    }
  })();
  // Playwright validates cookies only while installing them — after the
  // attached context's HTTP cache and cookie jar are already cleared — so a
  // semantically invalid cookie (bad expires, missing domain/path) would
  // fail the apply with the cache unrestorably gone. Checked up front, with
  // the same rules addCookies enforces (verified against 1.61.1).
  assertValidStorageState(parsedState);
  // setStorageState needs a temporary page whenever the state carries origins
  // or the context has visited any — and by the time that page creation fails
  // on a target without Target.createTarget, the HTTP cache is already cleared
  // and cannot be put back. Probe the page creation first, so such targets are
  // rejected before anything is mutated. When neither signal indicates a page
  // will be needed (cookie-only state, no pages open), the probe is skipped so
  // that case keeps working on those targets.
  const stateHasOrigins = (parsedState.origins?.length ?? 0) > 0;
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
  // Pages that were already open still render the previous identity — and
  // their scripts keep running: a page that periodically persists
  // authentication into cookies or localStorage would overwrite the state
  // being installed if it were still alive during setStorageState(), and
  // replacing its tab afterwards cannot undo writes already made into
  // context-wide storage. Every open page is therefore replaced with a blank
  // fresh tab FIRST — the old document closes before the state lands, and
  // only blank replacements (which run no scripts) survive the apply — and
  // the replacements are navigated to the pages they replaced only once the
  // recorded state is in place.
  const replaced = await replaceOpenPagesWithBlankTabs(browserContext);
  const policyRequired = !!(config.network?.allowedOrigins?.length || config.network?.blockedOrigins?.length);
  let replacementNavigationSafe = !policyRequired;
  try {
    // The state validated above is the state applied: handing the path back
    // to Playwright would re-read the file here, and a file replaced since
    // that read would skip the cookie/origin validation and the page-creation
    // probe only to fail after the cache clear those exist to prevent.
    await browserContext.setStorageState(parsedState);
    // The replacement navigations run inside the factory, before Context
    // ensures the configured origin allowlist/blocklist — and the recorded
    // credentials are already in place by now. The policy is installed here
    // (permanently — page scripts can queue requests that fire after the
    // navigation settles, so removing the handlers before Context re-ensures
    // the same policy would open a window to a blocked origin;
    // ensureNetworkPolicyRoutes installs once per context, so Context's later
    // call is a no-op). Installed after setStorageState() so an abort-all
    // route cannot interfere with the temporary page Playwright drives to
    // restore origin storage.
    await ensureNetworkPolicyRoutes(config, browserContext);
    replacementNavigationSafe = true;
    await navigateReplacementPages(replaced);
  } catch (error) {
    // Prefer the full-state rollback; fall back to cookies-only when its
    // reapplication is itself impossible on this target.
    const restoredFully = await browserContext.setStorageState(originalState).then(() => true, () => false);
    const restoredCookies = restoredFully || await browserContext.clearCookies()
        .then(() => originalCookies.length ? browserContext.addCookies(originalCookies) : undefined)
        .then(() => true, () => false);
    // The old pages were closed before the apply and cannot be handed back.
    // Navigate their replacements only when no policy was required or its
    // installation succeeded; otherwise restored credentials stay offline.
    if (replacementNavigationSafe)
      await navigateReplacementPages(replaced);
    else
      await Promise.all(replaced.map(({ page }) => page.close().catch(() => {})));
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

export type ClientInfo = { name?: string, version?: string };

export type CreateContextOptions = {
  /**
   * True when the context backs an explicitly opened browser session
   * (`browser_session_open`) — or the ephemeral default context of a
   * stateless per-request HTTP backend — rather than the long-lived default
   * session. The persistent factory gives such contexts their own disposable
   * profile: the stable `mcp-<browser>` profile can back only one running
   * browser at a time, so concurrent contexts sharing it would fail with
   * "Browser is already in use".
   */
  browserSession?: boolean;
};

export interface BrowserContextFactory {
  /**
   * True when createContext() lands config.browser.contextOptions.storageState in
   * the returned context — either by creating a fresh context with it or by
   * applying it to a reused context via setStorageState(). Omitted counts as
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
  createContext(clientInfo: ClientInfo, abortSignal: AbortSignal, toolName: string | undefined, options?: CreateContextOptions): Promise<{ browserContext: playwright.BrowserContext, close: () => Promise<void> }>;
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

  private _releaseHandout(browser: playwright.Browser): boolean {
    const remaining = Math.max(0, (this._handoutCounts.get(browser) ?? 1) - 1);
    this._handoutCounts.set(browser, remaining);
    return remaining === 0;
  }

  async createContext(clientInfo: ClientInfo): Promise<{ browserContext: playwright.BrowserContext, close: () => Promise<void> }> {
    testDebug(`create browser context (${this._logName})`);
    const browser = await this._obtainBrowser(clientInfo);
    // Captured to guard the eager `_browserPromise` reset below: after an
    // external disconnect a NEW promise may be in place, and clearing it
    // would orphan the fresh connection other sessions are about to use.
    const obtainedPromise = this._browserPromise;
    this._handoutCounts.set(browser, (this._handoutCounts.get(browser) ?? 0) + 1);
    let browserContext: playwright.BrowserContext;
    try {
      browserContext = await this._doCreateContext(browser);
    } catch (error) {
      // The handout never materialized. When it was the last one, the browser
      // must not stay behind ownerless — a sibling's close may have deferred
      // the browser shutdown to this in-flight creation.
      if (this._releaseHandout(browser)) {
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
        const last = this._releaseHandout(browser);
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
    await injectCdpPort(this.config.browser);
    const browserType = playwright[this.config.browser.browserName];
    return browserType.launch({
      tracesDir: await startTraceServer(this.config),
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
    const browser = await this._obtainBrowser(clientInfo);
    this._sessionCounts.set(browser, (this._sessionCounts.get(browser) ?? 0) + 1);
    let browserContext: playwright.BrowserContext;
    try {
      browserContext = await this._doCreateContext(browser);
    } catch (error) {
      // Without this the CDP connection stays open after e.g. an unreadable
      // storage-state file, even though no context was ever handed out — but
      // only when no sibling session is still using the shared connection.
      if (this._releaseBrowser(browser))
        await browser.close().catch(logUnhandledError);
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
        if (this._releaseBrowser(browser)) {
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
    // undefined context to the caller. The created context immediately seeds
    // the applied-state memo — a later session will find it as the browser's
    // existing context, and must join it rather than reset it — and the
    // creation itself is memoized so concurrent arrivals share one context.
    if (!existing) {
      let creating = this._fallbackContext.get(browser);
      if (!creating) {
        creating = browser.newContext(this.config.browser.contextOptions).then(created => {
          this._storageStateApplied.set(created, Promise.resolve());
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

  async createContext(clientInfo: ClientInfo, _abortSignal?: AbortSignal, _toolName?: string, options?: CreateContextOptions): Promise<{ browserContext: playwright.BrowserContext, close: () => Promise<void> }> {
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
    assertStorageStateDoesNotResetUserProfile(this.config, persistentProfileConflictRemedy);
    // Trace setup runs before the disposable profile exists: it can fail (an
    // unwritable output directory), and nothing after the directory is created
    // may throw outside the cleanup scope below, or failed starts would leave
    // stray profiles behind.
    const tracesDir = await startTraceServer(this.config);
    // An explicitly opened browser session gets its own disposable profile for
    // the same reason a storage-state context does: the stable profile can back
    // only one running browser, so a second session sharing it would spin on
    // the ProcessSingleton lock and fail with "Browser is already in use". The
    // DEFAULT (no-handle) context keeps the stable `mcp-<browser>` profile, so
    // its sign-in state still survives restarts.
    const profileSuffix = storageState
      ? `-storage-state-${createGuid()}`
      : options?.browserSession
        ? `-session-${createGuid()}`
        : '';
    const userDataDir = this.config.browser.userDataDir ?? await this._createUserDataDir(profileSuffix);
    // Guarded on the config profile too: sessionsUnsupportedReason keeps
    // registry sessions out of a user-supplied --user-data-dir, so a suffix
    // here always means the guid-fresh managed directory above — but a direct
    // caller combining both must still never see the user's profile deleted.
    const disposableProfile = !!profileSuffix && !this.config.browser.userDataDir;

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
          return await this._applyStorageState(browserContext, storageState, userDataDir, disposableProfile);
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
      if (disposableProfile) {
        await fs.promises.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
        this._userDataDirs.delete(userDataDir);
      }
      throw error;
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
  private async _createUserDataDir(suffix: string) {
    const dir = process.env.PWMCP_PROFILES_DIR_FOR_TEST ?? registryDirectory;
    const browserToken = this.config.browser.launchOptions?.channel ?? this.config.browser?.browserName;
    const result = path.join(dir, `mcp-${browserToken}${suffix}`);
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

async function startTraceServer(config: FullConfig): Promise<string | undefined> {
  if (!config.saveTrace)
    return undefined;

  // The random suffix keeps two contexts created in the same millisecond
  // (e.g. concurrent sessions) from sharing a trace folder and overwriting
  // each other's trace files. Nothing parses the folder name back.
  const tracesDir = await outputFile(config, `traces-${Date.now()}-${createShortGuid()}`);
  const server = await startTraceViewerServer();
  const urlPrefix = server.urlPrefix('human-readable');
  const url = urlPrefix + '/trace/index.html?trace=' + tracesDir + '/trace.json';
  // eslint-disable-next-line no-console
  console.error('\nTrace viewer listening on ' + url);
  return tracesDir;
}
