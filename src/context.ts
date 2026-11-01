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
import { assertNetworkPolicySupported, ensureNetworkPolicyRoutes } from './networkPolicy.js';
import { truncateDataUrls } from './utils/dataUrl.js';
import { truncateWithMarker } from './utils/fileUtils.js';
import { InputRecorder, recorderBufferMs } from './inputRecorder.js';
import { rejectAfterTimeout, settleWithin } from './utils/timeout.js';

import type { FullConfig } from './config.js';
import type { Tool } from './tools/tool.js';
import type { BrowserContextFactory, ClientInfo } from './browserContextFactory.js';
import type { BrowserSessionBroker } from './browserSessions.js';
import type { SessionLog } from './sessionLog.js';
import type { RecordedAction, Recording, RecordingTarget } from './inputRecorder.js';

const testDebug = debug('pw:mcp:test');
const recorderControlTools = new Set(['browser_start_recording', 'browser_stop_recording']);
const pageCloseTimeoutMs = 5_000;
const pendingDownloadDrainTimeoutMs = 30_000;
const maxRetainedDownloadErrors = 20;
const maxDownloadErrorBytes = 2000;
const pendingPageCloses = new WeakMap<playwright.Page, Promise<void>>();

function pendingPageClose(page: playwright.Page): Promise<void> {
  const pending = pendingPageCloses.get(page);
  if (pending)
    return pending;
  const close = page.close();
  pendingPageCloses.set(page, close);
  const clear = () => {
    if (pendingPageCloses.get(page) === close)
      pendingPageCloses.delete(page);
  };
  void close.then(clear, clear);
  return close;
}

async function closePage(page: playwright.Page, timeoutMs: number): Promise<void> {
  const maxAttempts = 3;
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      break;
    try {
      await rejectAfterTimeout(pendingPageClose(page), remaining, `Timed out after ${timeoutMs}ms while closing the page.`);
    } catch (error) {
      if (!page.isClosed())
        throw error;
    }
    if (page.isClosed())
      return;
  }
  throw new Error(`Failed to close the page after ${maxAttempts} attempts within ${timeoutMs}ms.`);
}

function contextClosedWhileOpeningTabError(): Error {
  return new Error('The browser context closed while a tab was being opened.');
}

function releaseOnce(release: () => void): () => void {
  let released = false;
  return () => {
    if (released)
      return;
    released = true;
    release();
  };
}

type BrowserContextHandle = { browserContext: playwright.BrowserContext, close: () => Promise<void>, closeStarting?: () => void };

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

type IdleGroup = {
  browserContext: playwright.BrowserContext;
  contexts: Set<Context>;
  timer?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
};
const idleGroups = new WeakMap<playwright.BrowserContext, IdleGroup>();

async function acquireTrace(browserContext: playwright.BrowserContext): Promise<void> {
  let hub = traceHubs.get(browserContext);
  if (!hub) {
    const created: TraceHub = {
      users: 0,
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
  try {
    await browserContext.tracing.stop();
  } catch (originalError) {
    try {
      await browserContext.tracing.stop();
    } catch {
      throw originalError;
    }
  }
}

type ContextOptions = {
  tools: Tool[];
  modalStateTools?: Tool[];
  config: FullConfig;
  browserContextFactory: BrowserContextFactory;
  sessionLog: (() => Promise<SessionLog | undefined>) | undefined;
  clientInfo: ClientInfo;
  browserSessions?: BrowserSessionBroker;
  browserSession?: boolean;
  browserSessionId?: string;
};

export class Context {
  readonly tools: Tool[];
  readonly modalStateTools: Tool[];
  readonly config: FullConfig;
  readonly options: ContextOptions;
  private _browserContextPromise: Promise<BrowserContextHandle> | undefined;
  private _browserContextFactory: BrowserContextFactory;
  private _tabs: Tab[] = [];
  private _currentTab: Tab | undefined;
  private _clientInfo: ClientInfo;

  private _closeBrowserContextPromise: Promise<void> | undefined;
  private _runningTools: string[] = [];
  private _sessionHolds = 0;
  private _lastToolCallEndedAt = -Infinity;
  private _pendingDownloads = new Set<Promise<unknown>>();
  private _openingPages = new Set<Promise<unknown>>();
  private _openingTab: { attaching: Promise<unknown>, request: Promise<void>, waiting: (AbortSignal | undefined)[] } | undefined;
  private _downloadErrors: string[] = [];
  private _omittedDownloadErrors = 0;
  private _abortController = new AbortController();
  private _removePageObserver: (() => void) | undefined;
  private _inputRecorder: InputRecorder | undefined;
  private _removeRecorderContext: (() => void) | undefined;
  private _recordingStartFinished: Promise<void> | undefined;
  private _recording: Recording | undefined;
  private _recordingStops = new Set<Promise<void>>();
  private _closeAfterRecording = false;
  private _sessionLog: SessionLog | undefined;
  private _idleGroup: IdleGroup | undefined;
  private _lastActivityAt = Date.now();
  private _idleClosePromise: Promise<void> | undefined;

  constructor(options: ContextOptions) {
    this.tools = options.tools;
    this.modalStateTools = options.modalStateTools ?? options.tools;
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

  tabForPage(page: playwright.Page): Tab | undefined {
    return this._tabs.find(tab => tab.page === page);
  }

  currentTabOrDie(): Tab {
    if (!this._currentTab)
      throw new Error('No open pages available. Use the "browser_navigate" tool to navigate to a page first.');
    return this._currentTab;
  }

  async newTab(): Promise<Tab> {
    const attaching = this._ensureBrowserContext();
    const { browserContext } = await attaching;
    if (this._browserContextPromise !== attaching)
      throw contextClosedWhileOpeningTabError();
    const opening = browserContext.newPage().then(async page => {
      if (this._browserContextPromise !== attaching) {
        await closePage(page, pageCloseTimeoutMs).catch(logUnhandledError);
        throw contextClosedWhileOpeningTabError();
      }
      this._currentTab = this._tabs.find(t => t.page === page)!;
      return this._currentTab;
    });
    this._openingPages.add(opening);
    try {
      return await opening;
    } finally {
      this._openingPages.delete(opening);
    }
  }

  async selectTab(index: number) {
    const tab = this._tabs[index];
    if (!tab)
      throw new Error(`Tab ${index} not found`);
    await tab.page.bringToFront();
    this._currentTab = tab;
    return tab;
  }

  async ensureTab(signal?: AbortSignal): Promise<Tab> {
    const attaching = this._ensureBrowserContext();
    const { browserContext } = await attaching;
    if (!this._currentTab) {
      signal?.throwIfAborted();
      if (this._browserContextPromise !== attaching)
        throw contextClosedWhileOpeningTabError();
      let opening = this._openingTab;
      if (opening?.attaching !== attaching) {
        const waiting: (AbortSignal | undefined)[] = [];
        const request = browserContext.newPage().then(async page => {
          if (this._openingTab?.waiting === waiting)
            this._openingTab = undefined;
          if (this._browserContextPromise === attaching && waiting.some(waiter => !waiter?.aborted))
            return;
          await closePage(page, pageCloseTimeoutMs).catch(logUnhandledError);
          if (this._browserContextPromise !== attaching)
            throw contextClosedWhileOpeningTabError();
          throw new Error('The tab request was cancelled.');
        });
        opening = this._openingTab = { attaching, request, waiting };
        this._openingPages.add(request);
      }
      opening.waiting.push(signal);
      try {
        await opening.request;
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      } finally {
        this._openingPages.delete(opening.request);
        if (this._openingTab === opening)
          this._openingTab = undefined;
      }
    }
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
      this._scheduleIdleTimeout();
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
      this._scheduleIdleTimeout();
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
      this._lastActivityAt = Date.now();
      this._scheduleIdleTimeout();
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
    await closePage(tab.page, tab.operationTimeout());
    return url;
  }

  async outputFile(name: string, exclusive = false): Promise<string> {
    return outputFile(this.config, name, exclusive);
  }

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
    if (this._idleClosePromise) {
      await this._idleClosePromise;
      this._idleClosePromise = undefined;
    }
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

  isRunningTool() {
    return this._runningTools.length > 0 || this._sessionHolds > 0;
  }

  isRunningToolForRecording(buffered: boolean): boolean {
    return this._runningTools.some(name => !recorderControlTools.has(name)) || buffered && Date.now() - this._lastToolCallEndedAt <= recorderBufferMs;
  }

  trackPendingDownload(promise: Promise<unknown>, filename?: string): void {
    const settled = promise.catch(error => {
      if (this._downloadErrors.length < maxRetainedDownloadErrors) {
        const label = filename ? ` "${filename}"` : '';
        const cause = error instanceof Error ? error.message : String(error);
        this._downloadErrors.push(truncateWithMarker(truncateDataUrls(`Failed to save download${label}: ${cause}`), maxDownloadErrorBytes));
      } else {
        ++this._omittedDownloadErrors;
      }
      logUnhandledError(error);
    });
    this._pendingDownloads.add(settled);
    this._scheduleIdleTimeout();
    void settled.then(() => {
      this._pendingDownloads.delete(settled);
      this._lastActivityAt = Date.now();
      this._scheduleIdleTimeout();
    });
  }

  hasPendingDownloads(): boolean {
    return this._pendingDownloads.size > 0;
  }

  takeDownloadErrors(): string[] {
    const errors = this._downloadErrors.splice(0);
    if (this._omittedDownloadErrors)
      errors.push(`Omitted ${this._omittedDownloadErrors} additional download failure(s).`);
    this._omittedDownloadErrors = 0;
    return errors;
  }

  private async _waitForOpeningPages(): Promise<void> {
    if (this._openingPages.size)
      await settleWithin(Promise.allSettled([...this._openingPages]), pageCloseTimeoutMs);
  }

  private async _waitForPendingDownloads(): Promise<void> {
    const deadline = Date.now() + pendingDownloadDrainTimeoutMs;
    while (this._pendingDownloads.size) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        return;
      await settleWithin(Promise.all([...this._pendingDownloads]), remaining);
    }
  }

  beginToolCall(name: string): () => void {
    this._runningTools.push(name);
    this._scheduleIdleTimeout();
    return releaseOnce(() => {
      const index = this._runningTools.lastIndexOf(name);
      if (index !== -1)
        this._runningTools.splice(index, 1);
      if (!recorderControlTools.has(name))
        this._lastToolCallEndedAt = Date.now();
      this._lastActivityAt = Date.now();
      this._scheduleIdleTimeout();
    });
  }

  beginSessionHold(): () => void {
    this._sessionHolds++;
    this._scheduleIdleTimeout();
    return releaseOnce(() => {
      this._sessionHolds--;
      this._lastActivityAt = Date.now();
      this._scheduleIdleTimeout();
    });
  }

  async resumeAfterIdle(): Promise<string | undefined> {
    if (!this._idleClosePromise)
      return;
    await this._idleClosePromise;
    await this._ensureBrowserContext();
    this._idleClosePromise = undefined;
    return 'The browser connection was released after inactivity and has been reopened. Use browser_navigate to navigate again if needed; previous element references are no longer valid.';
  }

  private _scheduleIdleTimeout() {
    const group = this._idleGroup;
    if (!group)
      return;
    clearTimeout(group.timer);
    group.timer = undefined;
    if (group.closing || !group.contexts.size)
      return;
    let deadline = 0;
    for (const context of group.contexts) {
      if (!context.config.timeouts.idle || context.options.browserSession || context.isRunningTool() || context.hasPendingDownloads() || context._recording || context._recordingStartFinished || context._recordingStops.size)
        return;
      deadline = Math.max(deadline, context._lastActivityAt + context.config.timeouts.idle);
    }
    group.timer = setTimeout(() => {
      group.timer = undefined;
      const contexts = [...group.contexts];
      group.closing = Promise.all(contexts.map(context => context.closeBrowserContext())).then(() => {
        idleGroups.delete(group.browserContext);
      });
      for (const context of contexts)
        context._idleClosePromise = group.closing;
      void group.closing.catch(logUnhandledError);
    }, Math.max(0, deadline - Date.now()));
    group.timer.unref?.();
  }

  private async _closeBrowserContextImpl() {
    if (!this._browserContextPromise)
      return;

    testDebug('close context');

    const promise = this._browserContextPromise;
    this._browserContextPromise = undefined;

    await promise.then(async ({ browserContext, close, closeStarting }) => {
      closeStarting?.();
      await this._waitForPendingDownloads();
      if (this._recording)
        await this.stopRecording().catch(logUnhandledError);
      await Promise.all(this._recordingStops);
      await this._waitForOpeningPages();
      this._detachFromBrowserContext();
      try {
        if (this.config.saveTrace)
          await releaseTrace(browserContext);
      } catch (error) {
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

  private _detachFromBrowserContext() {
    if (this._idleGroup) {
      this._idleGroup.contexts.delete(this);
      this._scheduleIdleTimeout();
      if (!this._idleGroup.contexts.size && !this._idleGroup.closing)
        idleGroups.delete(this._idleGroup.browserContext);
      this._idleGroup = undefined;
    }
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

  private async _setupBrowserContext(): Promise<BrowserContextHandle> {
    if (this._closeBrowserContextPromise)
      throw new Error('Another browser context is being closed.');
    assertNetworkPolicySupported(this.config, this._browserContextFactory.ownsBrowser === true);
    const result = await this._browserContextFactory.createContext(this._clientInfo, this._abortController.signal, this._runningTools[this._runningTools.length - 1], { browserSession: this.options.browserSession });
    const closingGroup = idleGroups.get(result.browserContext)?.closing;
    if (closingGroup) {
      await result.close();
      await closingGroup;
      return this._setupBrowserContext();
    }
    let group = idleGroups.get(result.browserContext);
    if (!group) {
      group = { browserContext: result.browserContext, contexts: new Set() };
      idleGroups.set(result.browserContext, group);
    }
    group.contexts.add(this);
    this._idleGroup = group;
    this._lastActivityAt = Date.now();
    this._scheduleIdleTimeout();
    try {
      const { browserContext } = result;
      await ensureNetworkPolicyRoutes(this.config, browserContext);
      this._removeRecorderContext = InputRecorder.attachContext(this, browserContext);
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
      this._detachFromBrowserContext();
      await result.close().catch(() => {});
      throw error;
    }
    return result;
  }
}
