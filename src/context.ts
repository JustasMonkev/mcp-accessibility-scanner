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
const recorderBufferMs = 500;
const recorderControlTools = new Set(['browser_start_recording', 'browser_stop_recording']);
const expectPrelude = "const { expect } = require('playwright/test');";
const pageCloseAttemptTimeoutMs = 1000;

/**
 * Chromium can acknowledge Target.closeTarget while a racing navigation keeps
 * the target alive. Retry the public close call instead of letting one tool or
 * an entire crawl wait forever.
 */
async function closePage(page: playwright.Page, attemptTimeoutMs = pageCloseAttemptTimeoutMs): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const closed = await Promise.race([
        page.close().then(() => true),
        new Promise<false>(resolve => {
          timer = setTimeout(() => resolve(false), attemptTimeoutMs);
          timer.unref?.();
        }),
      ]);
      if (closed || page.isClosed())
        return;
    } catch (error) {
      if (page.isClosed())
        return;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Timed out while closing the page after 3 attempts.');
}

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
  private _lastToolCallEndedAt = -Infinity;
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
  private _removeRecorderContext: (() => void) | undefined;
  private _recordingStartFinished: Promise<void> | undefined;
  private _recording: Recording | undefined;
  private _recordingStops = new Set<Promise<void>>();
  private _closeAfterRecording = false;
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
    this.assertRecordingCanStart();
    await this._startRecording();
  }

  async startRecordingOnCurrentTab(): Promise<void> {
    this.assertRecordingCanStart();
    let finishStart: () => void;
    const startFinished = new Promise<void>(resolve => finishStart = resolve);
    this._recordingStartFinished = startFinished;
    try {
      const tab = await this.ensureTab();
      await tab.page.bringToFront();
      await this._startRecording();
    } finally {
      if (this._recordingStartFinished === startFinished)
        this._recordingStartFinished = undefined;
      finishStart!();
    }
  }

  private async _startRecording(): Promise<void> {
    const actions: RecordedAction[] = [];
    const target: RecordingTarget = { actions, pageIndexes: new Map(), state: { stopping: false } };
    const ready = this._ensureBrowserContext().then(async ({ browserContext }) => {
      await InputRecorder.startRecording(this, browserContext, target);
      return browserContext;
    });
    const recording: Recording = { target, ready, lastActivityAt: Date.now() };
    this._recording = recording;
    try {
      await ready;
    } catch (error) {
      if (this._recording === recording)
        this._recording = undefined;
      this._closeBrowserContextAfterRecording();
      throw error;
    }
  }

  async stopRecording(): Promise<string[] | undefined> {
    this.assertRecordingCanPersist();
    if (this._recordingStartFinished)
      await this._recordingStartFinished;
    const recording = this._recording;
    if (!recording)
      return undefined;
    this._recording = undefined;
    recording.target.state.stopping = true;
    let finishStop: () => void;
    const stopFinished = new Promise<void>(resolve => finishStop = resolve);
    this._recordingStops.add(stopFinished);
    try {
      const browserContext = await recording.ready;
      await InputRecorder.stopRecording(this, browserContext, recording.target);
      return recording.target.actions.map(action => action.code.trim()).filter(Boolean);
    } finally {
      this._recordingStops.delete(stopFinished);
      finishStop!();
      this._closeBrowserContextAfterRecording();
    }
  }

  recordingActivityAt(): number | undefined {
    return this._recording?.lastActivityAt;
  }

  markRecordingActivity(): void {
    if (this._recording)
      this._recording.lastActivityAt = Date.now();
  }

  assertRecordingCanPersist(): void {
    if (this.options.browserSession && !this.options.browserSessionId)
      throw new Error('Recording over stateless HTTP requires a browserSessionId. Call browser_session_open, then pass its browserSessionId to browser_start_recording and browser_stop_recording. Shared-context modes that cannot open browser sessions require a stateful MCP connection.');
  }

  assertRecordingCanStart(): void {
    this.assertRecordingCanPersist();
    if (this._recording || this._recordingStartFinished)
      throw new Error('Recording is already in progress.');
  }

  async closeTab(index: number | undefined): Promise<string> {
    const tab = index === undefined ? this._currentTab : this._tabs[index];
    if (!tab)
      throw new Error(`Tab ${index} not found`);
    const url = tab.page.url();
    await closePage(tab.page);
    return url;
  }

  async outputFile(name: string, exclusive = false): Promise<string> {
    return outputFile(this.config, name, exclusive);
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
    this._closeAfterRecording = false;
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
    if (!this._tabs.length) {
      if (this._recording || this._recordingStops.size)
        this._closeAfterRecording = true;
      else
        void this.closeBrowserContext();
    }
  }

  async closeBrowserContext() {
    if (!this._closeBrowserContextPromise)
      this._closeBrowserContextPromise = this._closeBrowserContextImpl().catch(logUnhandledError);
    await this._closeBrowserContextPromise;
    this._closeBrowserContextPromise = undefined;
  }

  private _closeBrowserContextAfterRecording(): void {
    if (!this._closeAfterRecording || this._recording || this._recordingStops.size || this._closeBrowserContextPromise)
      return;
    this._closeAfterRecording = false;
    void this.closeBrowserContext();
  }

  /** True while ANY tool call is running in this Context, overlap included. */
  isRunningTool() {
    return this._runningTools.length > 0;
  }

  isRunningToolForRecording(buffered: boolean): boolean {
    return this._runningTools.some(name => !recorderControlTools.has(name)) || buffered && Date.now() - this._lastToolCallEndedAt <= recorderBufferMs;
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
      if (!recorderControlTools.has(name))
        this._lastToolCallEndedAt = Date.now();
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
      await Promise.all(this._recordingStops);
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
    this._removeRecorderContext?.();
    this._removeRecorderContext = undefined;
    this._inputRecorder?.dispose();
    this._inputRecorder = undefined;
    this._closeAfterRecording = false;
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
      this._removeRecorderContext = InputRecorder.attachContext(this, browserContext);
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
// at its disposed Context. One hub therefore owns a dispatching sink per
// context. Session logs and on-demand recordings register and deregister with
// it. The hub carries the enablement promise: a session
// joining while (or after) another session's _enableRecorder call is in
// flight must not report recording as ready before it is, and a failed
// enablement evicts the hub so the next session retries instead of silently
// recording nothing. When the last consumer leaves, the recorder returns to
// standby; the same hub arms it again for the next recording.
type RecordedAction = { page: playwright.Page, code: string, sequence?: number };
type RecordingTarget = {
  actions: RecordedAction[];
  pageIndexes: Map<playwright.Page, number>;
  state: { stopping: boolean };
};
type Recording = { target: RecordingTarget, ready: Promise<playwright.BrowserContext>, lastActivityAt: number };
const actionIsBuffered = (action: actions.Action): boolean =>
  action.name === 'click' && action.button === 'left' || action.name === 'navigate';
const pageAliasFromCode = (code: string): string | undefined =>
  code.match(/^\s*await\s+(page\d*)\./m)?.[1]
    ?? code.match(/^\s*await\s+expect\((page\d*)(?:\.|\))/m)?.[1];
const addMissingPageAlias = (
  recorded: RecordedAction[],
  page: playwright.Page,
  code: string,
  pageIndexes: Map<playwright.Page, number>,
  browserContext: playwright.BrowserContext,
) => {
  const alias = pageAliasFromCode(code);
  if (!alias || alias === 'page')
    return;
  const declaration = new RegExp(`^\\s*const\\s+${alias}\\s*=`, 'm');
  if (declaration.test(code) || recorded.some(action => declaration.test(action.code)))
    return;
  const initialPageIndex = pageIndexes.get(page);
  const pageIndex = initialPageIndex ?? browserContext.pages().indexOf(page);
  if (pageIndex === -1)
    return;
  const declarationAction = { page, code: `const ${alias} = context.pages()[${pageIndex}];` };
  if (initialPageIndex === undefined)
    recorded.push(declarationAction);
  else
    recorded.unshift(declarationAction);
};
type RecorderHub = {
  recorders: Set<InputRecorder>;
  recordings: Map<Context, RecordingTarget>;
  starting: number;
  ready: Promise<void>;
  arm: () => Promise<void>;
  ensureArmed: () => Promise<void>;
  standbyIfIdle: () => Promise<void>;
};
const recorderHubs = new WeakMap<playwright.BrowserContext, RecorderHub>();
const recorderContexts = new WeakMap<playwright.BrowserContext, Set<Context>>();

export class InputRecorder {
  private _context: Context;
  private _browserContext: playwright.BrowserContext;
  private _lastActions = new WeakMap<playwright.Page, { action: actions.Action, sequence: number }>();

  private constructor(context: Context, browserContext: playwright.BrowserContext) {
    this._context = context;
    this._browserContext = browserContext;
  }

  static async create(context: Context, browserContext: playwright.BrowserContext) {
    const recorder = new InputRecorder(context, browserContext);
    const existingHub = recorderHubs.get(browserContext);
    const hub = InputRecorder._ensureHub(browserContext);
    hub.recorders.add(recorder);
    try {
      await hub.ready;
      if (existingHub)
        await hub.ensureArmed();
    } catch (error) {
      hub.recorders.delete(recorder);
      throw error;
    }
    return recorder;
  }

  static attachContext(context: Context, browserContext: playwright.BrowserContext): () => void {
    let contexts = recorderContexts.get(browserContext);
    if (!contexts) {
      contexts = new Set();
      recorderContexts.set(browserContext, contexts);
    }
    contexts.add(context);
    return () => contexts.delete(context);
  }

  static async startRecording(context: Context, browserContext: playwright.BrowserContext, target: RecordingTarget): Promise<void> {
    const existingHub = recorderHubs.get(browserContext);
    const hub = InputRecorder._ensureHub(browserContext);
    ++hub.starting;
    try {
      await hub.ready;
      if (existingHub) {
        await new Promise(resolve => setTimeout(resolve, recorderBufferMs));
        await hub.arm();
      }
      for (const [index, page] of browserContext.pages().entries())
        target.pageIndexes.set(page, index);
      hub.recordings.set(context, target);
    } catch (error) {
      if (hub.recordings.get(context) === target)
        hub.recordings.delete(context);
      throw error;
    } finally {
      --hub.starting;
    }
  }

  static async stopRecording(context: Context, browserContext: playwright.BrowserContext, target: RecordingTarget): Promise<void> {
    // Playwright buffers clicks and navigations for 500ms so a later
    // event can refine them. Keep this recording registered until that last
    // event arrives; config.timeouts.settle may be shorter or disabled.
    const recordings = recorderHubs.get(browserContext)?.recordings;
    await new Promise(resolve => setTimeout(resolve, recorderBufferMs));
    if (target && recordings?.get(context) === target) {
      recordings.delete(context);
      const hub = recorderHubs.get(browserContext);
      await hub?.standbyIfIdle().catch(logUnhandledError);
    }
  }

  dispose() {
    const hub = recorderHubs.get(this._browserContext);
    hub?.recorders.delete(this);
    void hub?.standbyIfIdle().catch(logUnhandledError);
  }

  private static _ensureHub(browserContext: playwright.BrowserContext): RecorderHub {
    const hub = recorderHubs.get(browserContext);
    if (hub)
      return hub;

    const recorders = new Set<InputRecorder>();
    const recordings = new Map<Context, RecordingTarget>();
    let actionSequence = 0;
    const lastActionSequence = new WeakMap<playwright.Page, number>();
    let armed = false;
    let transition = Promise.resolve();
    const enqueue = (callback: () => Promise<void>) => {
      const result = transition.then(callback, callback);
      transition = result.catch(() => {});
      return result;
    };
    const dispatch = (
      buffered: boolean,
      flushable: boolean,
      log: (recorder: InputRecorder) => void,
      record: (target: RecordingTarget) => void,
    ) => {
      const contexts = new Set<Context>(recorderContexts.get(browserContext));
      for (const context of recordings.keys())
        contexts.add(context);
      const running = [...contexts].filter(context => context.isRunningToolForRecording(buffered));
      if (!running.length) {
        for (const recorder of recorders)
          log(recorder);
      }
      for (const [context, target] of recordings) {
        if ((!target.state.stopping || flushable) && !running.some(runningContext => runningContext !== context)) {
          record(target);
          context.markRecordingActivity();
        }
      }
    };
    const params = {
        mode: 'recording',
        recorderMode: 'api',
        omitCallTracking: true,
        language: 'javascript',
    };
    const sink = {
        actionAdded: (page: playwright.Page, data: actions.Action | actions.ActionInContext, code: string) => {
          const sequence = ++actionSequence;
          lastActionSequence.set(page, sequence);
          const action = 'action' in data ? data.action : data;
          const isAssertion = action.name.startsWith('assert');
          if (isAssertion)
            code = code.replace(/^(\s*)\/\/ ?/gm, '$1');
          const buffered = actionIsBuffered(action);
          dispatch(
              buffered,
              buffered || action.name === 'closePage',
              recorder => recorder._actionAdded(page, action, isAssertion ? `${expectPrelude}\n${code}` : code, sequence),
              target => {
                if (isAssertion && !target.actions.some(action => action.code === expectPrelude))
                  target.actions.push({ page, code: expectPrelude });
                addMissingPageAlias(target.actions, page, code, target.pageIndexes, browserContext);
                target.actions.push({ page, code, sequence });
              },
          );
        },
        actionUpdated: (page: playwright.Page, data: actions.Action | actions.ActionInContext, code: string) => {
          const sequence = lastActionSequence.get(page);
          if (sequence === undefined)
            return;
          const action = 'action' in data ? data.action : data;
          dispatch(
              true,
              true,
              recorder => recorder._actionUpdated(page, action, code, sequence),
              target => {
                const recorded = target.actions.findLast(action => action.sequence === sequence);
                if (recorded)
                  recorded.code = code;
              },
          );
        },
        signalAdded: (page: playwright.Page, data: actions.Signal | actions.SignalInContext, code: string) => {
          const sequence = lastActionSequence.get(page);
          const signal = 'signal' in data ? data.signal : data;
          dispatch(
              true,
              true,
              recorder => recorder._signalAdded(page, signal, code, sequence),
              target => {
                if (sequence === undefined)
                  return;
                const action = target.actions.findLast(action => action.sequence === sequence);
                if (action && code)
                  action.code = code;
              },
          );
        },
    };
    const arm = async () => {
      await (browserContext as any)._enableRecorder(params, sink);
      armed = true;
    };
    const created: RecorderHub = {
      recorders,
      recordings,
      starting: 0,
      ready: enqueue(arm),
      arm: () => enqueue(arm),
      ensureArmed: () => enqueue(async () => {
        if (armed)
          return;
        await arm();
      }),
      standbyIfIdle: () => enqueue(async () => {
        if (created.starting || recorders.size || recordings.size)
          return;
        try {
          await (browserContext as any)._disableRecorder();
        } finally {
          armed = false;
        }
      }),
    };
    created.ready.catch(() => {
      if (recorderHubs.get(browserContext) === created)
        recorderHubs.delete(browserContext);
    });
    recorderHubs.set(browserContext, created);
    return created;
  }

  private _actionAdded(page: playwright.Page, action: actions.Action, code: string, sequence: number) {
    this._lastActions.set(page, { action, sequence });
    const tab = this._context.tabForPage(page);
    if (tab)
      this._context.sessionLog!.logUserAction(action, tab, code, false);
  }

  private _actionUpdated(page: playwright.Page, action: actions.Action, code: string, sequence: number) {
    if (this._lastActions.get(page)?.sequence !== sequence)
      return;
    this._lastActions.set(page, { action, sequence });
    const tab = this._context.tabForPage(page);
    if (tab)
      this._context.sessionLog!.logUserAction(action, tab, code, true);
  }

  private _signalAdded(page: playwright.Page, signal: actions.Signal, code: string, sequence?: number) {
    const lastAction = this._lastActions.get(page);
    if (sequence !== undefined && lastAction?.sequence !== sequence)
      return;
    const tab = this._context.tabForPage(page);
    if (signal.name !== 'navigation' && tab && code && lastAction)
      this._context.sessionLog!.logUserAction(lastAction.action, tab, code, true);
    if (signal.name !== 'navigation')
      return;
    const navigateAction: actions.Action = {
      name: 'navigate',
      url: signal.url,
      signals: [],
    };
    if (tab)
      this._context.sessionLog!.logUserAction(navigateAction, tab, `await page.goto('${signal.url}');`, false);
  }
}
