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

import { AsyncLocalStorage } from 'node:async_hooks';

import debug from 'debug';
import type * as playwright from 'playwright';

import { logUnhandledError } from './utils/log.js';
import { Tab } from './tab.js';
import { evictOutputFiles, outputFile, setProtectedOutputDirsProvider } from './config.js';

import type { FullConfig } from './config.js';
import type { Tool } from './tools/tool.js';
import type { BrowserContextFactory, BrowserContextResult, ClientInfo } from './browserContextFactory.js';
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

  protectedOutputDirs(): string[] {
    return [...this._contexts].flatMap(ctx => ctx.protectedOutputDirs());
  }
}

const contextRegistry = new ContextRegistry();

// Output eviction must preserve the live session-log and trace folders of every
// active context (concurrent HTTP sessions share one output directory), so it
// consults the registry rather than guessing which folders are still in use.
setProtectedOutputDirsProvider(() => contextRegistry.protectedOutputDirs());

/**
 * Coordinates output eviction across every concurrent tool call (including those
 * from different HTTP sessions, which share one output directory):
 *
 * - eviction only runs when no tool is currently executing anywhere, so it never
 *   deletes in-progress artifacts that a running tool has not returned yet;
 * - tool execution waits for any in-flight eviction to finish before it starts
 *   writing, so an eviction walk can never race with a later tool's writes.
 */
class OutputEvictionGate {
  private _runningTools = 0;
  private _evictionPromise: Promise<void> = Promise.resolve();

  async run<T>(evict: () => Promise<void>, body: () => Promise<T>): Promise<T> {
    const shouldEvict = this._runningTools === 0;
    this._runningTools++;
    try {
      if (shouldEvict)
        this._evictionPromise = evict().catch(logUnhandledError);
      await this._evictionPromise;
      return await body();
    } finally {
      this._runningTools--;
    }
  }
}

export const outputEvictionGate = new OutputEvictionGate();

// Name of the tool whose execution is on the current async call stack. Used when
// a tool lazily creates the browser context so the right tool name reaches the
// context factory (e.g. the extension relay's `newTab` flag), even when several
// first-time tool calls overlap.
export const currentToolNameStorage = new AsyncLocalStorage<string>();

type ContextOptions = {
  tools: Tool[];
  config: FullConfig;
  browserContextFactory: BrowserContextFactory;
  sessionLog: SessionLog | undefined;
  clientInfo: ClientInfo;
};

export class Context {
  readonly tools: Tool[];
  readonly config: FullConfig;
  readonly sessionLog: SessionLog | undefined;
  readonly options: ContextOptions;
  private _browserContextPromise: Promise<BrowserContextResult> | undefined;
  private _browserContextFactory: BrowserContextFactory;
  private _tabs: Tab[] = [];
  private _currentTab: Tab | undefined;
  private _clientInfo: ClientInfo;
  private _tracesDir: string | undefined;

  private _closeBrowserContextPromise: Promise<void> | undefined;
  private _runningTools = new Map<symbol, string>();
  private _abortController = new AbortController();

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
    return outputFile(this.config, this._clientInfo.rootPath, name);
  }

  async evictOutputFiles(): Promise<void> {
    await evictOutputFiles(this.config, this._clientInfo.rootPath);
  }

  // Output paths this context is actively writing to, which must survive
  // `outputMaxSize` eviction: its session log, in-progress trace, and any
  // downloads still being saved.
  protectedOutputDirs(): string[] {
    const dirs: string[] = [];
    if (this.sessionLog)
      dirs.push(this.sessionLog.folder);
    if (this._tracesDir)
      dirs.push(this._tracesDir);
    for (const tab of this._tabs)
      dirs.push(...tab.pendingDownloadOutputFiles());
    return dirs;
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

  isRunningTool() {
    return this._runningTools.size > 0;
  }

  // Each in-flight tool call gets its own token so that overlapping calls which
  // finish out of order remove their own entry rather than popping whichever
  // tool happened to start last.
  setRunningTool(name: string): symbol {
    const token = Symbol(name);
    this._runningTools.set(token, name);
    return token;
  }

  clearRunningTool(token: symbol) {
    this._runningTools.delete(token);
  }

  private async _closeBrowserContextImpl() {
    if (!this._browserContextPromise)
      return;

    testDebug('close context');

    const promise = this._browserContextPromise;
    this._browserContextPromise = undefined;

    await promise.then(async ({ browserContext, close }) => {
      if (this.config.saveTrace)
        await browserContext.tracing.stop();
      await close();
    });
    // Keep the trace folder protected until tracing has fully stopped and the
    // files are finalized; only then is it safe to let eviction reclaim it.
    this._tracesDir = undefined;
  }

  async dispose() {
    this._abortController.abort('MCP context disposed');
    await this.closeBrowserContext();
    contextRegistry.unregister(this);
  }

  private async _setupRequestInterception(context: playwright.BrowserContext) {
    if (this.config.network?.allowedOrigins?.length) {
      await context.route('**', route => route.abort('blockedbyclient'));

      for (const origin of this.config.network.allowedOrigins)
        await context.route(`*://${origin}/**`, route => route.continue());
    }

    if (this.config.network?.blockedOrigins?.length) {
      for (const origin of this.config.network.blockedOrigins)
        await context.route(`*://${origin}/**`, route => route.abort('blockedbyclient'));
    }
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

  private async _setupBrowserContext(): Promise<BrowserContextResult> {
    if (this._closeBrowserContextPromise)
      throw new Error('Another browser context is being closed.');
    // TODO: move to the browser context factory to make it based on isolation mode.
    const result = await this._browserContextFactory.createContext(this._clientInfo, this._abortController.signal, currentToolNameStorage.getStore());
    const { browserContext } = result;
    this._tracesDir = result.tracesDir;
    await this._setupRequestInterception(browserContext);
    if (this.sessionLog)
      await InputRecorder.create(this, browserContext);
    for (const page of browserContext.pages())
      this._onPageCreated(page);
    browserContext.on('page', page => this._onPageCreated(page));
    if (this.config.saveTrace) {
      await browserContext.tracing.start({
        name: 'trace',
        screenshots: false,
        snapshots: true,
        sources: false,
      });
    }
    return result;
  }
}

export class InputRecorder {
  private _context: Context;
  private _browserContext: playwright.BrowserContext;

  private constructor(context: Context, browserContext: playwright.BrowserContext) {
    this._context = context;
    this._browserContext = browserContext;
  }

  static async create(context: Context, browserContext: playwright.BrowserContext) {
    const recorder = new InputRecorder(context, browserContext);
    await recorder._initialize();
    return recorder;
  }

  private async _initialize() {
    const sessionLog = this._context.sessionLog!;
    await (this._browserContext as any)._enableRecorder({
      mode: 'recording',
      recorderMode: 'api',
    }, {
      actionAdded: (page: playwright.Page, data: actions.ActionInContext, code: string) => {
        if (this._context.isRunningTool())
          return;
        const tab = Tab.forPage(page);
        if (tab)
          sessionLog.logUserAction(data.action, tab, code, false);
      },
      actionUpdated: (page: playwright.Page, data: actions.ActionInContext, code: string) => {
        if (this._context.isRunningTool())
          return;
        const tab = Tab.forPage(page);
        if (tab)
          sessionLog.logUserAction(data.action, tab, code, true);
      },
      signalAdded: (page: playwright.Page, data: actions.SignalInContext) => {
        if (this._context.isRunningTool())
          return;
        if (data.signal.name !== 'navigation')
          return;
        const tab = Tab.forPage(page);
        const navigateAction: actions.Action = {
          name: 'navigate',
          url: data.signal.url,
          signals: [],
        };
        if (tab)
          sessionLog.logUserAction(navigateAction, tab, `await page.goto('${data.signal.url}');`, false);
      },
    });
  }
}
