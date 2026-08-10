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

import debug from 'debug';
import type * as playwright from 'playwright';

import { logUnhandledError } from './utils/log.js';
import { Tab } from './tab.js';
import { outputFile } from './config.js';
import { ensureNetworkPolicyRoutes } from './networkPolicy.js';

import type { FullConfig } from './config.js';
import type { Tool } from './tools/tool.js';
import type { BrowserContextFactory, ClientInfo } from './browserContextFactory.js';
import type { BrowserSessionBroker } from './browserSessions.js';
import type * as actions from './actions.js';
import type { SessionLog } from './sessionLog.js';

const testDebug = debug('pw:mcp:test');

class ContextRegistry {
  private readonly _contexts = new Set<Context>();

  register(context: Context): void {
    this._contexts.add(context);
  }

  unregister(context: Context): void {
    this._contexts.delete(context);
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this._contexts].map(ctx => ctx.dispose()));
  }
}

const contextRegistry = new ContextRegistry();

type TraceHub = { users: number, ready: Promise<void> };
const traceHubs = new WeakMap<playwright.BrowserContext, TraceHub>();

async function acquireTrace(browserContext: playwright.BrowserContext): Promise<void> {
  let hub = traceHubs.get(browserContext);
  if (!hub) {
    const created: TraceHub = {
      users: 0,
      ready: browserContext.tracing.start({
        name: 'trace',
        screenshots: false,
        snapshots: true,
        sources: false,
      }),
    };
    traceHubs.set(browserContext, created);
    created.ready.catch(() => {
      if (traceHubs.get(browserContext) === created)
        traceHubs.delete(browserContext);
    });
    hub = created;
  }
  hub.users++;
  try {
    await hub.ready;
  } catch (error) {
    hub.users--;
    throw error;
  }
}

async function releaseTrace(browserContext: playwright.BrowserContext): Promise<void> {
  const hub = traceHubs.get(browserContext);
  if (!hub || --hub.users)
    return;
  traceHubs.delete(browserContext);
  await browserContext.tracing.stop();
}

type ContextOptions = {
  tools: Tool[];
  config: FullConfig;
  browserContextFactory: BrowserContextFactory;
  sessionLog: SessionLog | undefined;
  clientInfo: ClientInfo;
  browserSessions?: BrowserSessionBroker;
  /**
   * True when this Context backs an explicitly opened browser session
   * (`browser_session_open`) rather than the default one; forwarded to the
   * context factory so e.g. the persistent factory mints a disposable profile
   * instead of contending for the stable one.
   */
  browserSession?: boolean;
};

export class Context {
  readonly tools: Tool[];
  readonly config: FullConfig;
  readonly sessionLog: SessionLog | undefined;
  readonly options: ContextOptions;
  private _browserContextPromise: Promise<{ browserContext: playwright.BrowserContext, close: () => Promise<void> }> | undefined;
  private _browserContextFactory: BrowserContextFactory;
  private _tabs: Tab[] = [];
  private _currentTab: Tab | undefined;
  private _clientInfo: ClientInfo;

  private _closeBrowserContextPromise: Promise<void> | undefined;
  // A multiset, not a single slot: tool calls on one Context can overlap, and
  // with a single marker the first call to finish would clear it while the
  // second still ran — letting the session TTL reaper (or a session close)
  // dispose the browser mid-operation.
  private _runningTools: string[] = [];
  private _abortController = new AbortController();
  private _removePageObserver: (() => void) | undefined;
  private _inputRecorder: InputRecorder | undefined;

  constructor(options: ContextOptions) {
    this.tools = options.tools;
    this.config = options.config;
    this.sessionLog = options.sessionLog;
    this.options = options;
    this._browserContextFactory = options.browserContextFactory;
    this._clientInfo = options.clientInfo;
    testDebug('create context');
    contextRegistry.register(this);
  }

  static async disposeAll() {
    await contextRegistry.disposeAll();
  }

  tabs(): Tab[] {
    return this._tabs;
  }

  currentTab(): Tab | undefined {
    return this._currentTab;
  }

  // Resolves within this session's own wrappers: on a shared (non-isolated
  // CDP) context, several sessions wrap the same page, and an event belongs
  // to whichever session is asking — a global page→tab map would hand every
  // session the last writer's wrapper and lose the entry when that session
  // closes.
  tabForPage(page: playwright.Page): Tab | undefined {
    return this._tabs.find(tab => tab.page === page);
  }

  currentTabOrDie(): Tab {
    if (!this._currentTab)
      throw new Error('No open pages available. Use the "browser_navigate" tool to navigate to a page first.');
    return this._currentTab;
  }

  async newTab(): Promise<Tab> {
    const { browserContext } = await this._ensureBrowserContext();
    const page = await browserContext.newPage();
    this._currentTab = this._tabs.find(t => t.page === page)!;
    return this._currentTab;
  }

  async selectTab(index: number) {
    const tab = this._tabs[index];
    if (!tab)
      throw new Error(`Tab ${index} not found`);
    await tab.page.bringToFront();
    this._currentTab = tab;
    return tab;
  }

  async ensureTab(): Promise<Tab> {
    const { browserContext } = await this._ensureBrowserContext();
    if (!this._currentTab)
      await browserContext.newPage();
    return this._currentTab!;
  }

  async closeTab(index: number | undefined): Promise<string> {
    const tab = index === undefined ? this._currentTab : this._tabs[index];
    if (!tab)
      throw new Error(`Tab ${index} not found`);
    const url = tab.page.url();
    await tab.page.close();
    return url;
  }

  async outputFile(name: string): Promise<string> {
    return outputFile(this.config, name);
  }

  /**
   * The registry behind `browser_session_open` / `browser_session_close`.
   * Provided by BrowserServerBackend; absent when the Context is constructed
   * outside of it (e.g. directly in tests).
   */
  browserSessions(): BrowserSessionBroker {
    if (!this.options.browserSessions)
      throw new Error('Browser session management is not available in this environment.');
    return this.options.browserSessions;
  }

  private _onPageCreated(page: playwright.Page) {
    const tab = new Tab(this, page, tab => this._onPageClosed(tab));
    this._tabs.push(tab);
    if (!this._currentTab)
      this._currentTab = tab;
  }

  private _onPageClosed(tab: Tab) {
    const index = this._tabs.indexOf(tab);
    if (index === -1)
      return;
    this._tabs.splice(index, 1);

    if (this._currentTab === tab)
      this._currentTab = this._tabs[Math.min(index, this._tabs.length - 1)];
    if (!this._tabs.length)
      void this.closeBrowserContext();
  }

  async closeBrowserContext() {
    if (!this._closeBrowserContextPromise)
      this._closeBrowserContextPromise = this._closeBrowserContextImpl().catch(logUnhandledError);
    await this._closeBrowserContextPromise;
    this._closeBrowserContextPromise = undefined;
  }

  /** True while ANY tool call is running in this Context, overlap included. */
  isRunningTool() {
    return this._runningTools.length > 0;
  }

  /**
   * Marks a tool call as running and returns the release callback for that
   * specific call (idempotent, and releasing out of completion order is
   * fine). isRunningTool() stays true until every overlapping call released.
   */
  beginToolCall(name: string): () => void {
    this._runningTools.push(name);
    let released = false;
    return () => {
      if (released)
        return;
      released = true;
      const index = this._runningTools.lastIndexOf(name);
      if (index !== -1)
        this._runningTools.splice(index, 1);
    };
  }

  private async _closeBrowserContextImpl() {
    if (!this._browserContextPromise)
      return;

    testDebug('close context');

    const promise = this._browserContextPromise;
    this._browserContextPromise = undefined;

    await promise.then(async ({ browserContext, close }) => {
      this._detachFromBrowserContext();
      // close() is the factory's only cleanup hook — for storage-state
      // sessions it also removes the disposable profile — and this close
      // attempt is the only one (_browserContextPromise is already cleared),
      // so a failing trace stop must not skip it.
      try {
        if (this.config.saveTrace)
          await releaseTrace(browserContext);
      } catch (error) {
        // The symmetric race to the tolerated "already started" on setup: on
        // a shared context the sibling that closed first already stopped the
        // one recording, which is an expected shutdown, not an error worth
        // logging. Anything else still surfaces.
        if (!(error instanceof Error && /already stopped|Must start tracing before stopping/i.test(error.message)))
          throw error;
      } finally {
        await close();
      }
    });
  }

  async dispose() {
    this._abortController.abort('MCP context disposed');
    await this.closeBrowserContext();
    contextRegistry.unregister(this);
  }

  private async _setupRequestInterception(context: playwright.BrowserContext) {
    await ensureNetworkPolicyRoutes(this.config, context);
  }

  // The browser context can outlive this session (non-isolated CDP siblings
  // share it), so the session's observers must not: a leftover 'page'
  // listener would keep creating tabs inside a disposed Context, and the tab
  // wrappers' own page listeners would pile up with session churn.
  private _detachFromBrowserContext() {
    this._removePageObserver?.();
    this._removePageObserver = undefined;
    this._inputRecorder?.dispose();
    this._inputRecorder = undefined;
    for (const tab of this._tabs)
      tab.dispose();
    this._tabs = [];
    this._currentTab = undefined;
  }

  private _ensureBrowserContext() {
    if (!this._browserContextPromise) {
      this._browserContextPromise = this._setupBrowserContext();
      this._browserContextPromise.catch(() => {
        this._browserContextPromise = undefined;
      });
    }
    return this._browserContextPromise;
  }

  private async _setupBrowserContext(): Promise<{ browserContext: playwright.BrowserContext, close: () => Promise<void> }> {
    if (this._closeBrowserContextPromise)
      throw new Error('Another browser context is being closed.');
    // TODO: move to the browser context factory to make it based on isolation mode.
    // The factory gets the most recently started call's name — with overlap
    // that is the call whose execution is creating the context right now.
    const result = await this._browserContextFactory.createContext(this._clientInfo, this._abortController.signal, this._runningTools[this._runningTools.length - 1], { browserSession: this.options.browserSession });
    // The factory handed ownership over with close(); a setup failure past
    // this point would otherwise discard that callback with the browser still
    // running — and, for storage-state sessions, the disposable profile
    // pinned forever.
    try {
      const { browserContext } = result;
      await this._setupRequestInterception(browserContext);
      if (this.sessionLog)
        this._inputRecorder = await InputRecorder.create(this, browserContext);
      for (const page of browserContext.pages())
        this._onPageCreated(page);
      const onPage = (page: playwright.Page) => this._onPageCreated(page);
      browserContext.on('page', onPage);
      this._removePageObserver = () => browserContext.off('page', onPage);
      if (this.config.saveTrace)
        await acquireTrace(browserContext);
    } catch (error) {
      // The shared context may survive this close (siblings hold it), so the
      // observers registered above must come off explicitly.
      this._detachFromBrowserContext();
      await result.close().catch(() => {});
      throw error;
    }
    return result;
  }
}

// Playwright's _enableRecorder supports a single event sink per browser
// context, and a shared (non-isolated CDP) context can serve several sessions
// at once — a second _enableRecorder call would silently replace the first
// session's callbacks, and a departing session would leave the sink pointing
// at its disposed Context. The recorder is therefore enabled once per context
// object with a dispatching sink, and sessions register and deregister their
// own recorders with it. The hub carries the enablement promise: a session
// joining while (or after) another session's _enableRecorder call is in
// flight must not report recording as ready before it is, and a failed
// enablement evicts the hub so the next session retries instead of silently
// recording nothing. (Ceiling: the recorder itself stays enabled on the
// shared context once any session got it — with no registered recorders the
// events just fall on an empty set.)
type RecorderHub = { recorders: Set<InputRecorder>, ready: Promise<void> };
const recorderHubs = new WeakMap<playwright.BrowserContext, RecorderHub>();

export class InputRecorder {
  private _context: Context;
  private _browserContext: playwright.BrowserContext;

  private constructor(context: Context, browserContext: playwright.BrowserContext) {
    this._context = context;
    this._browserContext = browserContext;
  }

  static async create(context: Context, browserContext: playwright.BrowserContext) {
    const recorder = new InputRecorder(context, browserContext);
    let hub = recorderHubs.get(browserContext);
    if (!hub) {
      const recorders = new Set<InputRecorder>();
      const dispatch = (handle: (recorder: InputRecorder) => void) => {
        // A tool call drives the page through Playwright, and the recorder
        // cannot attribute a DOM event to the session that caused it — so
        // while any session sharing this context runs a tool, the events are
        // automation for every session's log, not user actions. (A real user
        // action racing a sibling's tool call is suppressed with them — the
        // same trade-off a single session already accepts for its own runs.)
        for (const registered of recorders) {
          if (registered._context.isRunningTool())
            return;
        }
        for (const registered of recorders)
          handle(registered);
      };
      const created: RecorderHub = {
        recorders,
        ready: (browserContext as any)._enableRecorder({
          mode: 'recording',
          recorderMode: 'api',
        }, {
          actionAdded: (page: playwright.Page, data: actions.ActionInContext, code: string) => {
            dispatch(registered => registered._actionAdded(page, data, code));
          },
          actionUpdated: (page: playwright.Page, data: actions.ActionInContext, code: string) => {
            dispatch(registered => registered._actionUpdated(page, data, code));
          },
          signalAdded: (page: playwright.Page, data: actions.SignalInContext) => {
            dispatch(registered => registered._signalAdded(page, data));
          },
        }),
      };
      created.ready.catch(() => {
        if (recorderHubs.get(browserContext) === created)
          recorderHubs.delete(browserContext);
      });
      recorderHubs.set(browserContext, created);
      hub = created;
    }
    hub.recorders.add(recorder);
    try {
      await hub.ready;
    } catch (error) {
      hub.recorders.delete(recorder);
      throw error;
    }
    return recorder;
  }

  dispose() {
    recorderHubs.get(this._browserContext)?.recorders.delete(this);
  }

  private _actionAdded(page: playwright.Page, data: actions.ActionInContext, code: string) {
    const tab = this._context.tabForPage(page);
    if (tab)
      this._context.sessionLog!.logUserAction(data.action, tab, code, false);
  }

  private _actionUpdated(page: playwright.Page, data: actions.ActionInContext, code: string) {
    const tab = this._context.tabForPage(page);
    if (tab)
      this._context.sessionLog!.logUserAction(data.action, tab, code, true);
  }

  private _signalAdded(page: playwright.Page, data: actions.SignalInContext) {
    if (data.signal.name !== 'navigation')
      return;
    const tab = this._context.tabForPage(page);
    const navigateAction: actions.Action = {
      name: 'navigate',
      url: data.signal.url,
      signals: [],
    };
    if (tab)
      this._context.sessionLog!.logUserAction(navigateAction, tab, `await page.goto('${data.signal.url}');`, false);
  }
}
