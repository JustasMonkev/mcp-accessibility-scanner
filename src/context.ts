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
import { createShortGuid } from './utils/guid.js';
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
      // The name is unique per context: with --isolated (or a remote/CDP
      // browser) several sessions' contexts share the browser's one cached
      // tracesDir, and a fixed name would make every context write the same
      // trace.trace/trace.network files — concurrent corruption, and later
      // sessions overwriting earlier traces. The 'trace' prefix is kept
      // because the printed viewer URL (…/trace.json) is served as a
      // prefix-matched descriptor over the traces directory.
      ready: browserContext.tracing.start({
        name: `trace-${createShortGuid()}`,
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
  /**
   * Resolves the `--save-session` log this context writes to, called when
   * the context first launches its browser context. The log is created
   * lazily at that point rather than eagerly by the owning backend: over
   * stateless HTTP every request builds a fresh backend, and a request that
   * only lists tools or routes to an existing browser session must not mint
   * an empty session directory. A backend hands the same async-once
   * supplier to its default context and to every session it opens, so all
   * of them share one log.
   */
  sessionLog: (() => Promise<SessionLog | undefined>) | undefined;
  clientInfo: ClientInfo;
  browserSessions?: BrowserSessionBroker;
  /**
   * True when this Context backs an explicitly opened browser session
   * (`browser_session_open`) or the ephemeral default context of a stateless
   * per-request HTTP backend, rather than the long-lived default one;
   * forwarded to the context factory so e.g. the persistent factory mints a
   * disposable profile instead of contending for the stable one.
   */
  browserSession?: boolean;
  /**
   * The registry handle (`bs_...`) this Context serves when it backs an
   * explicitly opened browser session. The `--save-session` log is shared by
   * a backend's default context and every session it opens, so recorded user
   * actions are tagged with this handle — the same identity routed tool
   * calls already carry in their logged args — and the log scopes its
   * pending-action merging by originating context. Absent for the default
   * context (including the ephemeral stateless-HTTP one, which has no
   * handle).
   */
  browserSessionId?: string;
};

export class Context {
  readonly tools: Tool[];
  readonly config: FullConfig;
  readonly options: ContextOptions;
  private _browserContextPromise: Promise<{ browserContext: playwright.BrowserContext, close: () => Promise<void>, closeStarting?: () => void }> | undefined;
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
  // In-flight download saves (Tab hands them over as they start). A download
  // outlives the tool call that triggered it — the response reports it as
  // "still downloading" — so disposal must wait for these before closing the
  // browser, or saveAs() is aborted mid-stream and the reported file ends up
  // missing or partial (the stateless HTTP path disposes the backend's
  // default context the moment the response closes).
  private _pendingDownloads = new Set<Promise<unknown>>();
  private _abortController = new AbortController();
  private _removePageObserver: (() => void) | undefined;
  private _inputRecorder: InputRecorder | undefined;
  private _recording: { actions: string[], ready: Promise<playwright.BrowserContext> } | undefined;
  // Resolved from options.sessionLog at the first browser context launch.
  private _sessionLog: SessionLog | undefined;

  constructor(options: ContextOptions) {
    this.tools = options.tools;
    this.config = options.config;
    this.options = options;
    this._browserContextFactory = options.browserContextFactory;
    this._clientInfo = options.clientInfo;
    testDebug('create context');
    contextRegistry.register(this);
  }

  static async disposeAll() {
    await contextRegistry.disposeAll();
  }

  get sessionLog(): SessionLog | undefined {
    return this._sessionLog;
  }

  /**
   * Resolves this context's `--save-session` log through the supplier handed
   * in by the backend that created it, caching the result. Called at the
   * first browser context launch, and by the owning backend for routed tool
   * calls: a no-browser tool (e.g. browser_default_timeout) routed to a
   * freshly opened session must land in the opener backend's log even though
   * the session has not launched a browser yet — reading the cached field
   * alone would silently skip it.
   */
  async resolveSessionLog(): Promise<SessionLog | undefined> {
    this._sessionLog ??= await this.options.sessionLog?.();
    return this._sessionLog;
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

  async startRecording(): Promise<void> {
    this.assertRecordingCanPersist();
    if (this._recording)
      throw new Error('Recording is already in progress.');
    const actions: string[] = [];
    const ready = this._ensureBrowserContext().then(async ({ browserContext }) => {
      await InputRecorder.startRecording(this, browserContext, actions);
      return browserContext;
    });
    const recording = { actions, ready };
    this._recording = recording;
    try {
      await ready;
    } catch (error) {
      if (this._recording === recording)
        this._recording = undefined;
      throw error;
    }
  }

  async stopRecording(): Promise<string[] | undefined> {
    this.assertRecordingCanPersist();
    const recording = this._recording;
    if (!recording)
      return undefined;
    this._recording = undefined;
    const browserContext = await recording.ready;
    await InputRecorder.stopRecording(this, browserContext, recording.actions);
    return recording.actions.map(code => code.trim()).filter(Boolean);
  }

  assertRecordingCanPersist(): void {
    if (this.options.browserSession && !this.options.browserSessionId)
      throw new Error('Recording over stateless HTTP requires a browserSessionId. Call browser_session_open, then pass its browserSessionId to browser_start_recording and browser_stop_recording. Shared-context modes that cannot open browser sessions require a stateful MCP connection.');
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
   * Registers an in-flight download save. Disposal waits (bounded) for the
   * registered saves before closing the browser context, and the session TTL
   * reaper holds off like it does for running tools — a download routinely
   * outlives the tool call that started it. The save's rejection is handled
   * here (logged): an aborted download must not surface as an unhandled
   * rejection.
   */
  trackPendingDownload(promise: Promise<unknown>): void {
    const settled = promise.catch(logUnhandledError);
    this._pendingDownloads.add(settled);
    void settled.then(() => this._pendingDownloads.delete(settled));
  }

  /** True while a download save is still writing its file. */
  hasPendingDownloads(): boolean {
    return this._pendingDownloads.size > 0;
  }

  /**
   * Waits for in-flight download saves, bounded at 30s: the same order as the
   * default navigation timeout, so a download that network conditions allow
   * to finish gets to — while disposal (a stateless HTTP response closing,
   * process shutdown, the TTL reaper) can never hang indefinitely on a
   * stalled download. Past the cap the download is abandoned, exactly as
   * every download was before this wait existed. Loops because a page can
   * start another download while an earlier one is awaited; the cap spans
   * the whole wait, not each download.
   */
  private async _waitForPendingDownloads(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this._pendingDownloads.size) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([...this._pendingDownloads]),
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, remaining);
            timer.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
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

    // Unpublished BEFORE the download drain below: the drain can hold this
    // close open for up to 30s, and with the promise still published a tool
    // call arriving in that window (browser_navigate after the last tab
    // closed with a download pending) was handed the closing context — its
    // fresh tab was silently torn down when the drain settled. Unpublishing
    // first routes such calls into _setupBrowserContext(), whose
    // _closeBrowserContextPromise check rejects them with the existing
    // "Another browser context is being closed" error.
    const promise = this._browserContextPromise;
    this._browserContextPromise = undefined;

    await promise.then(async ({ browserContext, close, closeStarting }) => {
      // Advance notice for the factory, ahead of the download drain: the
      // persistent factory uses it to tell a stable-profile holder that is
      // closing apart from one that is concurrently alive, so a default
      // context arriving mid-drain waits for the release instead of being
      // silently demoted to a disposable profile.
      closeStarting?.();
      // Before the browser goes away — whoever is closing it: a stateless
      // HTTP response's disposal, browser_session_close, the TTL reaper, the
      // last tab closing — give in-flight download saves their bounded
      // window to finish, so the files tool responses reported as "still
      // downloading" actually materialize.
      await this._waitForPendingDownloads();
      if (this._recording)
        await this.stopRecording().catch(logUnhandledError);
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

  private async _setupBrowserContext(): Promise<{ browserContext: playwright.BrowserContext, close: () => Promise<void>, closeStarting?: () => void }> {
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
      // First real use of this context: resolve — and, once per backend,
      // create — the session log before deciding whether to record input.
      await this.resolveSessionLog();
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
// object with a dispatching sink. Session logs and on-demand recordings
// register and deregister with it. The hub carries the enablement promise: a session
// joining while (or after) another session's _enableRecorder call is in
// flight must not report recording as ready before it is, and a failed
// enablement evicts the hub so the next session retries instead of silently
// recording nothing. (Ceiling: the recorder itself stays enabled on the
// shared context once any session got it — with no registered recorders the
// events just fall on an empty set.)
type RecorderHub = {
  recorders: Set<InputRecorder>;
  recordings: Map<Context, string[]>;
  ready: Promise<void>;
};
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
    const hub = InputRecorder._ensureHub(browserContext);
    hub.recorders.add(recorder);
    try {
      await hub.ready;
    } catch (error) {
      hub.recorders.delete(recorder);
      throw error;
    }
    return recorder;
  }

  static async startRecording(context: Context, browserContext: playwright.BrowserContext, actions: string[]): Promise<void> {
    const hub = InputRecorder._ensureHub(browserContext);
    hub.recordings.set(context, actions);
    try {
      await hub.ready;
    } catch (error) {
      if (hub.recordings.get(context) === actions)
        hub.recordings.delete(context);
      throw error;
    }
  }

  static async stopRecording(context: Context, browserContext: playwright.BrowserContext, actions: string[]): Promise<void> {
    // Playwright buffers clicks, fills and navigations for 500ms so a later
    // event can refine them. Keep this recording registered until that last
    // event arrives; config.timeouts.settle may be shorter or disabled.
    await new Promise(resolve => setTimeout(resolve, 500));
    const recordings = recorderHubs.get(browserContext)?.recordings;
    if (recordings?.get(context) === actions)
      recordings.delete(context);
  }

  dispose() {
    recorderHubs.get(this._browserContext)?.recorders.delete(this);
  }

  private static _ensureHub(browserContext: playwright.BrowserContext): RecorderHub {
    const hub = recorderHubs.get(browserContext);
    if (hub)
      return hub;

    const recorders = new Set<InputRecorder>();
    const recordings = new Map<Context, string[]>();
    const dispatch = (
      log: (recorder: InputRecorder) => void,
      record: (actions: string[]) => void,
    ) => {
      const contexts = new Set<Context>([...recorders].map(recorder => recorder._context));
      for (const context of recordings.keys())
        contexts.add(context);
      const running = [...contexts].filter(context => context.isRunningTool());
      if (!running.length) {
        for (const recorder of recorders)
          log(recorder);
      }
      for (const [context, actions] of recordings) {
        if (!running.some(runningContext => runningContext !== context))
          record(actions);
      }
    };
    const created: RecorderHub = {
      recorders,
      recordings,
      ready: (browserContext as any)._enableRecorder({
        mode: 'recording',
        recorderMode: 'api',
        omitCallTracking: true,
        language: 'playwright-test',
        hideToolbar: true,
      }, {
        actionAdded: (page: playwright.Page, data: actions.ActionInContext, code: string) => {
          dispatch(
              recorder => recorder._actionAdded(page, data, code),
              recorded => recorded.push(code),
          );
        },
        actionUpdated: (page: playwright.Page, data: actions.ActionInContext, code: string) => {
          dispatch(
              recorder => recorder._actionUpdated(page, data, code),
              recorded => {
                if (recorded.length && code)
                  recorded[recorded.length - 1] = code;
              },
          );
        },
        signalAdded: (page: playwright.Page, data: actions.SignalInContext, code: string) => {
          dispatch(
              recorder => recorder._signalAdded(page, data),
              recorded => {
                if (recorded.length && code)
                  recorded[recorded.length - 1] = code;
              },
          );
        },
      }),
    };
    created.ready.catch(() => {
      if (recorderHubs.get(browserContext) === created)
        recorderHubs.delete(browserContext);
    });
    recorderHubs.set(browserContext, created);
    return created;
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
