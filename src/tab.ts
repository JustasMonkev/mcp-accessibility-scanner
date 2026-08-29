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

import { EventEmitter } from 'node:events';
import type * as playwright from 'playwright';
import { callOnPageNoTrace, waitForCompletion } from './tools/utils.js';
import { logUnhandledError } from './utils/log.js';
import { ManualPromise } from './mcp/manualPromise.js';
import { truncateDataUrls } from './utils/dataUrl.js';
import { safeIsoTimestampForFileName, truncateToUtf8Bytes } from './utils/fileUtils.js';
import type { ModalState } from './tools/tool.js';

import type { Context } from './context.js';

/** @public */
export const TabEvents = {
  modalState: 'modalState'
};

export type TabEventsInterface = {
  [TabEvents.modalState]: [modalState: ModalState];
};

export type TabSnapshot = {
  url: string;
  title: string;
  mainDocumentStatus?: { status: number, statusText: string };
  ariaSnapshot: string;
  modalStates: ModalState[];
  consoleMessages: ConsoleMessage[];
  downloads: { download: playwright.Download, finished: boolean, outputFile: string }[];
};

class StaleAriaSnapshotError extends Error {}

export class Tab extends EventEmitter<TabEventsInterface> {
  readonly context: Context;
  readonly page: playwright.Page;
  private _lastTitle = 'about:blank';
  private _consoleMessages: ConsoleMessage[] = [];
  private _recentConsoleMessages: ConsoleMessage[] = [];
  private _requests: Map<playwright.Request, playwright.Response | null> = new Map();
  private _mainDocumentStatus: { status: number, statusText: string } | undefined;
  private _onPageClose: (tab: Tab) => void;
  private _modalStates: ModalState[] = [];
  private _downloads: { download: playwright.Download, finished: boolean, outputFile: string }[] = [];
  private _defaultTimeout: number;
  // The aria snapshot last handed to the caller; the refs in it are the refs the
  // next tool call will name. Cleared whenever the page it described is gone.
  private _lastAriaSnapshot: string | undefined;
  private _ariaSnapshotGeneration = 0;
  private _pageGeneration = 0;

  private _pageListeners: { event: string, listener: (...args: any[]) => void }[] = [];

  constructor(context: Context, page: playwright.Page, onPageClose: (tab: Tab) => void) {
    super();
    this.context = context;
    this.page = page;
    this._onPageClose = onPageClose;
    this._defaultTimeout = context.config.timeouts.defaultTimeout ?? 6000;
    // Registered through a tracked list so dispose() can take them off again:
    // on a shared (non-isolated CDP) context the page outlives the session,
    // and listeners left behind would pile up with session churn.
    const listen = (event: string, listener: (...args: any[]) => void) => {
      page.on(event as any, listener);
      this._pageListeners.push({ event, listener });
    };
    // Every document swap invalidates the cached snapshot, whoever caused it:
    // goBack(), page.reload() from scan_page_matrix, a meta refresh, or the page
    // assigning location itself. Tab.navigate() is only one of those routes, and
    // a ref resolved against the page the user has left would target the wrong
    // document.
    listen('framenavigated', (frame: playwright.Frame) => {
      if (!frame.parentFrame()) {
        ++this._pageGeneration;
        this._invalidateAriaSnapshot();
      }
    });
    listen('console', event => this._handleConsoleMessage(messageToConsoleMessage(event)));
    listen('pageerror', error => this._handleConsoleMessage(pageErrorToConsoleMessage(error)));
    listen('crash', () => this.context.pageCrashed(this.page));
    listen('request', request => this._requests.set(request, null));
    listen('response', response => this._handleResponse(response));
    listen('close', () => this._onClose());
    listen('filechooser', chooser => {
      this.setModalState({
        type: 'fileChooser',
        description: 'File chooser',
        fileChooser: chooser,
      });
    });
    listen('dialog', dialog => this._dialogShown(dialog));
    // Fires when a dialog is closed out of band (e.g. dismissed manually in
    // headed mode or via a CDP side-channel), so a stale modal state cannot
    // block snapshot-bearing tools. browser_handle_dialog keeps its
    // already-closed fallback for a close that races with the event handler.
    listen('dialogclosed', dialog => this._dialogClosed(dialog));
    listen('download', download => {
      // Tracked on the Context: the save outlives this tool call (and can
      // outlive the tab), and context disposal must wait for it instead of
      // closing the browser mid-stream. The context also owns the promise's
      // rejection handling.
      this.context.trackPendingDownload(this._downloadStarted(download));
    });
    page.setDefaultNavigationTimeout(context.config.timeouts.navigationTimeout ?? 30000);
    page.setDefaultTimeout(this._defaultTimeout);
  }

  // Detaches this wrapper from its page without closing the page: the page
  // can belong to a shared context that outlives the session.
  dispose() {
    for (const { event, listener } of this._pageListeners)
      this.page.off(event as any, listener);
    this._pageListeners = [];
  }

  modalStates(): ModalState[] {
    return this._modalStates;
  }

  setModalState(modalState: ModalState) {
    this._modalStates.push(modalState);
    this.emit(TabEvents.modalState, modalState);
  }

  clearModalState(modalState: ModalState) {
    this._modalStates = this._modalStates.filter(state => state !== modalState);
  }

  modalStatesMarkdown(): string[] {
    return renderModalStates(this.context, this.modalStates());
  }

  private _dialogShown(dialog: playwright.Dialog) {
    this.setModalState({
      type: 'dialog',
      description: `"${dialog.type()}" dialog with message "${dialog.message()}"`,
      dialog,
    });
  }

  private _dialogClosed(dialog: playwright.Dialog) {
    const state = this._modalStates.find(state => state.type === 'dialog' && state.dialog === dialog);
    if (state)
      this.clearModalState(state);
  }

  private async _downloadStarted(download: playwright.Download) {
    // The suggested name alone is not collision-safe: sessions share one
    // output directory, and two downloads suggesting "report.pdf" would
    // overwrite each other. The same {timestamp}-{token} fragment the other
    // default artifact names carry goes in before the extension, keeping the
    // suggested name as the recognizable part; responses print the suggested
    // name next to the saved path, so the file stays attributable.
    const suggested = download.suggestedFilename() || 'download';
    const separator = suggested.lastIndexOf('.');
    let base = separator > 0 ? suggested.slice(0, separator) : suggested;
    let extension = separator > 0 ? suggested.slice(separator) : '';
    const uniqueSuffix = `-${safeIsoTimestampForFileName()}`;
    // Filesystems cap a single name component at 255 bytes, and a long but
    // valid Content-Disposition name plus the ~35-byte suffix used to fail
    // saveAs() with ENAMETOOLONG. The recognizable part is truncated by BYTE
    // length (UTF-8, whole code points) so extension and uniqueness suffix
    // survive intact; a pathological "extension" too long to leave any base
    // is just part of one long name and is truncated with it.
    const maxNameBytes = 255;
    let baseBudget = maxNameBytes - Buffer.byteLength(uniqueSuffix, 'utf8') - Buffer.byteLength(extension, 'utf8');
    if (baseBudget < 1) {
      base = suggested;
      extension = '';
      baseBudget = maxNameBytes - Buffer.byteLength(uniqueSuffix, 'utf8');
    }
    const uniqueName = `${truncateToUtf8Bytes(base, baseBudget)}${uniqueSuffix}${extension}`;
    const entry = {
      download,
      finished: false,
      outputFile: await this.context.outputFile(uniqueName)
    };
    this._downloads.push(entry);
    await download.saveAs(entry.outputFile);
    entry.finished = true;
  }

  private _clearCollectedArtifacts() {
    this._consoleMessages.length = 0;
    this._recentConsoleMessages.length = 0;
    this._requests.clear();
    this._mainDocumentStatus = undefined;
    ++this._pageGeneration;
    this._invalidateAriaSnapshot();
  }

  private _invalidateAriaSnapshot() {
    ++this._ariaSnapshotGeneration;
    this._lastAriaSnapshot = undefined;
  }

  private _handleConsoleMessage(message: ConsoleMessage) {
    this._consoleMessages.push(message);
    this._recentConsoleMessages.push(message);
  }

  private _handleResponse(response: playwright.Response) {
    const request = response.request();
    this._requests.set(request, response);
    if (request.isNavigationRequest() && response.frame() === this.page.mainFrame() && !request.redirectedTo())
      this._mainDocumentStatus = { status: response.status(), statusText: response.statusText() };
  }

  private _onClose() {
    this._clearCollectedArtifacts();
    this._onPageClose(this);
  }

  async updateTitle() {
    await this._raceAgainstModalStates(async () => {
      try {
        this._lastTitle = await this._withPageStateTimeout(
            callOnPageNoTrace(this.page, page => page.title()),
            'reading page title',
            Math.min(this._pageStateTimeoutMs(), 5000),
        );
      } catch (error) {
        logUnhandledError(error);
      }
    });
  }

  lastTitle(): string {
    return this._lastTitle;
  }

  setDefaultTimeout(timeout: number) {
    this._defaultTimeout = timeout;
    this.page.setDefaultTimeout(timeout);
  }

  isCurrentTab(): boolean {
    return this === this.context.currentTab();
  }

  async waitForLoadState(state: 'load', options?: { timeout?: number }): Promise<void> {
    await callOnPageNoTrace(this.page, page => page.waitForLoadState(state, options).catch(logUnhandledError));
  }

  async navigate(url: string) {
    this._clearCollectedArtifacts();

    const downloadEvent = new ManualPromise<playwright.Download>();
    const downloadListener = (download: playwright.Download) => downloadEvent.resolve(download);
    this.page.once('download', downloadListener);
    try {
      try {
        await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      } catch (_e: unknown) {
        const e = _e as Error;
        if (!e.message.includes('Download is starting'))
          throw e;
        const download = await this._withPageStateTimeout(downloadEvent, 'waiting for download').catch(() => undefined);
        if (!download)
          throw e;
        // Make sure other "download" listeners are notified first.
        await new Promise(resolve => setTimeout(resolve, 500));
        return;
      }
    } finally {
      this.page.off('download', downloadListener);
    }

    // Cap load event to 5 seconds, the page is operational at this point.
    await this.waitForLoadState('load', { timeout: 5000 });
  }

  goBack(options?: Parameters<playwright.Page['goBack']>[0]) {
    this._mainDocumentStatus = undefined;
    return this.page.goBack(options);
  }

  consoleMessages(): ConsoleMessage[] {
    return this._consoleMessages;
  }

  requests(): Map<playwright.Request, playwright.Response | null> {
    return this._requests;
  }

  // Playwright resolves `Request.allHeaders()` and `Response.body()` with no
  // timeout of their own, so a still-streaming response would hang a tool call
  // until the page closed. Callers outside this class need the same bound the
  // page-state reads above use.
  async withPageStateTimeout<T>(promise: Promise<T>, description: string): Promise<T> {
    return this._withPageStateTimeout(promise, description);
  }

  async captureSnapshot(): Promise<TabSnapshot> {
    let tabSnapshot: TabSnapshot | undefined;
    const capture = { valid: true };
    const snapshotGeneration = this._ariaSnapshotGeneration;
    const modalStates = await this._raceAgainstModalStates(async () => {
      const [snapshot, title] = await Promise.all([
        this._withPageStateTimeout(
            this._captureAriaSnapshot(capture),
            'capturing page accessibility snapshot',
        ).catch(error => {
          // Nothing describes the page any more, and the refs of an older
          // snapshot must not be trusted against it.
          if (!(error instanceof StaleAriaSnapshotError)) {
            capture.valid = false;
            logUnhandledError(error);
            if (snapshotGeneration === this._ariaSnapshotGeneration)
              this._invalidateAriaSnapshot();
          }
          return `# Page snapshot unavailable: ${formatPageStateError(error)}`;
        }),
        this._withPageStateTimeout(
            this.page.title(),
            'reading page title',
        ).catch(error => {
          logUnhandledError(error);
          return this._lastTitle;
        }),
      ]);
      this._lastTitle = title;
      tabSnapshot = {
        url: this.page.url(),
        title,
        mainDocumentStatus: this._mainDocumentStatus,
        ariaSnapshot: snapshot,
        modalStates: [],
        consoleMessages: [],
        downloads: this._downloads,
      };
    });
    if (tabSnapshot) {
      // Assign console message late so that we did not lose any to modal state.
      tabSnapshot.consoleMessages = this._recentConsoleMessages;
      this._recentConsoleMessages = [];
    }
    if (!tabSnapshot) {
      capture.valid = false;
      this._invalidateAriaSnapshot();
    }
    return tabSnapshot ?? {
      url: this.page.url(),
      title: '',
      mainDocumentStatus: this._mainDocumentStatus,
      ariaSnapshot: '',
      modalStates,
      consoleMessages: [],
      downloads: [],
    };
  }

  private _javaScriptBlocked(): boolean {
    return this._modalStates.some(state => state.type === 'dialog');
  }

  private _pageStateTimeoutMs(): number {
    return this._defaultTimeout > 0 ? this._defaultTimeout : 5000;
  }

  private async _withPageStateTimeout<T>(promise: Promise<T>, description: string, timeoutMs = this._pageStateTimeoutMs()): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`Timed out after ${timeoutMs}ms while ${description}.`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId)
        clearTimeout(timeoutId);
    }
  }

  private async _raceAgainstModalStates(action: () => Promise<void>): Promise<ModalState[]> {
    if (this.modalStates().length)
      return this.modalStates();

    const promise = new ManualPromise<ModalState[]>();
    const listener = (modalState: ModalState) => promise.resolve([modalState]);
    this.once(TabEvents.modalState, listener);

    return await Promise.race([
      action().then(() => {
        this.off(TabEvents.modalState, listener);
        return [];
      }),
      promise,
    ]);
  }

  async waitForCompletion(callback: () => Promise<void>) {
    await this._raceAgainstModalStates(() => waitForCompletion(this, callback));
  }

  async refLocator(params: { element: string, ref: string }): Promise<playwright.Locator> {
    return (await this.refLocators([params]))[0];
  }

  async refLocators(params: { element: string, ref: string }[]): Promise<playwright.Locator[]> {
    // The refs a caller passes come from the snapshot the last tool call
    // returned, which is the one cached here, so the common case needs no fresh
    // capture. Playwright keeps a ref bound to the element it was issued for,
    // but that element can change its accessible role or name while staying
    // connected. Re-checking only the referenced nodes is still cheaper than a
    // full-page snapshot and prevents an old ref from targeting repurposed UI.
    const cached = this._lastAriaSnapshot;
    const snapshot = cached && await this._refsMatchSnapshot(params, cached)
      ? cached
      : await this._captureAriaSnapshot();
    return params.map(param => {
      if (!snapshot.includes(`[ref=${param.ref}]`))
        throw new Error(`Ref ${param.ref} not found in the current page snapshot. Try capturing new snapshot.`);
      return this.page.locator(`aria-ref=${param.ref}`).describe(param.element);
    });
  }

  private async _refsMatchSnapshot(params: { ref: string }[], snapshot: string): Promise<boolean> {
    const pageGeneration = this._pageGeneration;
    const lines = snapshot.split('\n');
    const timeout = Math.min(this._pageStateTimeoutMs(), 1000);
    const matches = await Promise.all(params.map(async param => {
      const cached = lines.find(line => line.includes(`[ref=${param.ref}]`));
      if (!cached)
        return false;
      const current = await this.page.locator(`aria-ref=${param.ref}`)
          .ariaSnapshot({ mode: 'ai', depth: 1, timeout })
          .catch(() => '');
      // Refs are assigned from the full role and name before long names are
      // omitted from rendering, so a semantic change still changes this line.
      return current.split('\n', 1)[0]?.trim() === cached.trim();
    }));
    return pageGeneration === this._pageGeneration && matches.every(Boolean);
  }

  private async _captureAriaSnapshot(capture = { valid: true }): Promise<string> {
    const pageGeneration = this._pageGeneration;
    const snapshot = await this.page.ariaSnapshot({ mode: 'ai' });
    if (!capture.valid || pageGeneration !== this._pageGeneration)
      throw new StaleAriaSnapshotError('Page changed while capturing accessibility snapshot.');
    ++this._ariaSnapshotGeneration;
    this._lastAriaSnapshot = snapshot;
    return snapshot;
  }

  async waitForTimeout(time: number) {
    if (this._javaScriptBlocked()) {
      await new Promise(f => setTimeout(f, time));
      return;
    }

    await callOnPageNoTrace(this.page, page => page.waitForTimeout(time));
  }
}

export type ConsoleMessage = {
  type: ReturnType<playwright.ConsoleMessage['type']> | undefined;
  text: string;
  toString(): string;
};

function messageToConsoleMessage(message: playwright.ConsoleMessage): ConsoleMessage {
  return {
    type: message.type(),
    text: message.text(),
    toString: () => `[${message.type().toUpperCase()}] ${message.text()} @ ${message.location().url}:${message.location().lineNumber}`,
  };
}

function pageErrorToConsoleMessage(errorOrValue: Error | any): ConsoleMessage {
  if (errorOrValue instanceof Error) {
    return {
      type: undefined,
      text: errorOrValue.message,
      toString: () => errorOrValue.stack || errorOrValue.message,
    };
  }
  return {
    type: undefined,
    text: String(errorOrValue),
    toString: () => String(errorOrValue),
  };
}

function formatPageStateError(error: unknown): string {
  if (error instanceof Error)
    return error.message;
  return String(error);
}

export function renderModalStates(context: Context, modalStates: ModalState[]): string[] {
  const result: string[] = ['### Modal state'];
  if (modalStates.length === 0)
    result.push('- There is no modal state present');
  for (const state of modalStates) {
    const tool = context.tools.find(tool => tool.clearsModalState === state.type);
    result.push(`- [${truncateDataUrls(state.description)}]: can be handled by the "${tool?.schema.name}" tool`);
  }
  return result;
}
