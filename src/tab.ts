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
import type { Request, Response } from 'playwright';
import { callOnPageNoTrace, waitForCompletion } from './tools/utils.js';
import { logUnhandledError } from './utils/log.js';
import { errorMessage } from './utils/errors.js';
import { ManualPromise } from './mcp/manualPromise.js';
import { isToolBlocked } from './mcp/toolPolicy.js';
import { truncateDataUrls } from './utils/dataUrl.js';
import { safeIsoTimestampForFileName, truncateToUtf8Bytes, truncateWithMarker } from './utils/fileUtils.js';
import { rejectAfterTimeout } from './utils/timeout.js';
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
  downloads: { download: playwright.Download, finished: boolean, outputFile: string, error?: string }[];
};

class StaleAriaSnapshotError extends Error {}

const defaultActionTimeoutMs = 6000;
const defaultNavigationTimeoutMs = 30000;
const fallbackOperationTimeoutMs = 5000;
const maxRetainedRequests = 200;
const maxDownloadErrorBytes = 2000;
const maxFileNameBytes = 255;

function uniqueDownloadFileName(suggestedFilename: string): string {
  const suggested = suggestedFilename.replace(/[. ]+$/, '') || 'download';
  const separator = suggested.lastIndexOf('.');
  const uniqueSuffix = `-${safeIsoTimestampForFileName()}`;
  const suffixBytes = Buffer.byteLength(uniqueSuffix, 'utf8');
  const base = separator > 0 ? suggested.slice(0, separator) : suggested;
  const extension = separator > 0 ? suggested.slice(separator) : '';
  const baseBudget = maxFileNameBytes - suffixBytes - Buffer.byteLength(extension, 'utf8');
  if (baseBudget < 1)
    return `${truncateToUtf8Bytes(suggested, maxFileNameBytes - suffixBytes)}${uniqueSuffix}`;
  return `${truncateToUtf8Bytes(base, baseBudget)}${uniqueSuffix}${extension}`;
}

export class Tab extends EventEmitter<TabEventsInterface> {
  readonly context: Context;
  readonly page: playwright.Page;
  private _lastTitle = 'about:blank';
  private _consoleMessages: ConsoleMessage[] = [];
  private _recentConsoleMessages: ConsoleMessage[] = [];
  private _requests = new Map<number, Request>();
  private _requestIds = new WeakMap<Request, number>();
  private _nextRequestId = 0;
  private _navigationRequestId = 0;
  private _mainDocumentStatus: { status: number, statusText: string } | undefined;
  private _onPageClose: (tab: Tab) => void;
  private _modalStates: ModalState[] = [];
  private _downloads: TabSnapshot['downloads'] = [];
  private _defaultTimeout: number;
  private _lastAriaSnapshot: string | undefined;
  private _ariaSnapshotGeneration = 0;
  private _pageGeneration = 0;

  private _pageListeners: { event: string, listener: (...args: any[]) => void }[] = [];

  constructor(context: Context, page: playwright.Page, onPageClose: (tab: Tab) => void) {
    super();
    this.context = context;
    this.page = page;
    this._onPageClose = onPageClose;
    this._defaultTimeout = context.config.timeouts.defaultTimeout ?? defaultActionTimeoutMs;
    const listen = (event: string, listener: (...args: any[]) => void) => {
      page.on(event as any, listener);
      this._pageListeners.push({ event, listener });
    };
    listen('framenavigated', (frame: playwright.Frame) => {
      if (!frame.parentFrame()) {
        ++this._pageGeneration;
        this._invalidateAriaSnapshot();
      }
    });
    listen('console', event => this._handleConsoleMessage(messageToConsoleMessage(event)));
    listen('pageerror', error => this._handleConsoleMessage(pageErrorToConsoleMessage(error)));
    listen('request', request => this._addRequest(request));
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
    listen('dialogclosed', dialog => this._dialogClosed(dialog));
    listen('download', download => {
      this.context.trackPendingDownload(this._downloadStarted(download), download.suggestedFilename());
    });
    page.setDefaultNavigationTimeout(context.config.timeouts.navigationTimeout ?? defaultNavigationTimeoutMs);
    page.setDefaultTimeout(this._defaultTimeout);
  }

  dispose() {
    for (const { event, listener } of this._pageListeners)
      this.page.off(event as any, listener);
    this._pageListeners = [];
    this._requests.clear();
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
    const entry: TabSnapshot['downloads'][number] = {
      download,
      finished: false,
      outputFile: await this.context.outputFile(uniqueDownloadFileName(download.suggestedFilename())),
    };
    this._downloads.push(entry);
    try {
      await download.saveAs(entry.outputFile);
      entry.finished = true;
    } catch (error) {
      entry.error = truncateWithMarker(truncateDataUrls(errorMessage(error)), maxDownloadErrorBytes);
      throw error;
    }
  }

  private _clearCollectedArtifacts() {
    this._consoleMessages.length = 0;
    this._recentConsoleMessages.length = 0;
    this._mainDocumentStatus = undefined;
    ++this._pageGeneration;
    this._invalidateAriaSnapshot();
  }

  private _markRequestsNavigation() {
    for (const id of this._requests.keys()) {
      if (this._requests.size <= maxRetainedRequests)
        break;
      this._requests.delete(id);
    }
    this._navigationRequestId = this._nextRequestId;
  }

  private _invalidateAriaSnapshot() {
    ++this._ariaSnapshotGeneration;
    this._lastAriaSnapshot = undefined;
  }

  private _handleConsoleMessage(message: ConsoleMessage) {
    this._consoleMessages.push(message);
    this._recentConsoleMessages.push(message);
  }

  private _addRequest(request: Request) {
    const id = ++this._nextRequestId;
    this._requestIds.set(request, id);
    this._requests.set(id, request);
    return id;
  }

  private _handleResponse(response: Response) {
    if (this.page.isClosed())
      return;
    const request = response.request();
    const id = this._requestIds.get(request) ?? this._addRequest(request);
    if (!this._requests.has(id))
      return;
    if (id > this._navigationRequestId && request.isNavigationRequest() && response.frame() === this.page.mainFrame() && !request.redirectedTo())
      this._mainDocumentStatus = { status: response.status(), statusText: response.statusText() };
  }

  private _onClose() {
    this._requests.clear();
    this._clearCollectedArtifacts();
    this._onPageClose(this);
  }

  async updateTitle() {
    await this._raceAgainstModalStates(async () => {
      try {
        this._lastTitle = await this.withPageStateTimeout(
            callOnPageNoTrace(this.page, page => page.title()),
            'reading page title',
            Math.min(this.operationTimeout(), fallbackOperationTimeoutMs),
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

  operationTimeout(): number {
    return this._defaultTimeout > 0 ? this._defaultTimeout : fallbackOperationTimeoutMs;
  }

  isCurrentTab(): boolean {
    return this === this.context.currentTab();
  }

  async waitForLoadState(state: 'load', options?: { timeout?: number }): Promise<void> {
    await callOnPageNoTrace(this.page, page => page.waitForLoadState(state, options).catch(logUnhandledError));
  }

  async navigate(url: string, options?: { returnOnDialog?: boolean }) {
    if (options?.returnOnDialog && this.modalStates().length)
      throw new Error(`Cannot navigate while a modal state is present.\n${this.modalStatesMarkdown().join('\n')}`);
    this._markRequestsNavigation();
    this._clearCollectedArtifacts();
    if (!options?.returnOnDialog) {
      await this._navigate(url);
      return;
    }
    let navigation: Promise<void> | undefined;
    const modalStates = await this._raceAgainstModalStates(() => {
      navigation = this._navigate(url);
      return navigation;
    });
    if (modalStates.length && navigation)
      this._reportLateNavigationFailure(navigation);
  }

  private _reportLateNavigationFailure(navigation: Promise<unknown>) {
    const pageGeneration = this._pageGeneration;
    void navigation.catch(error => {
      if (pageGeneration === this._pageGeneration)
        this._handleConsoleMessage(navigationFailureToConsoleMessage(error));
    });
  }

  private async _navigate(url: string) {
    const downloadEvent = new ManualPromise<playwright.Download>();
    const downloadListener = (download: playwright.Download) => downloadEvent.resolve(download);
    this.page.once('download', downloadListener);
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      if (!errorMessage(error).includes('Download is starting'))
        throw error;
      const download = await this.withPageStateTimeout(downloadEvent, 'waiting for download').catch(() => undefined);
      if (!download)
        throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
      return;
    } finally {
      this.page.off('download', downloadListener);
    }

    await this.waitForLoadState('load', { timeout: fallbackOperationTimeoutMs });
  }

  goBack(options?: Parameters<playwright.Page['goBack']>[0]) {
    this._mainDocumentStatus = undefined;
    return this.page.goBack(options);
  }

  async goBackReturningOnDialog(options?: Parameters<playwright.Page['goBack']>[0]): Promise<ModalState[]> {
    let navigation: Promise<unknown> | undefined;
    const modalStates = await this._raceAgainstModalStates(async () => {
      navigation = this.goBack(options);
      await navigation;
    });
    if (modalStates.length && navigation)
      this._reportLateNavigationFailure(navigation);
    return modalStates;
  }

  consoleMessages(): ConsoleMessage[] {
    return this._consoleMessages;
  }

  requests(all = false): Map<number, Request> {
    return all ? this._requests : new Map([...this._requests].filter(([id]) => id > this._navigationRequestId));
  }

  request(id: number): Request | undefined {
    return this._requests.get(id);
  }

  async withPageStateTimeout<T>(promise: Promise<T>, description: string, timeoutMs = this.operationTimeout()): Promise<T> {
    return await rejectAfterTimeout(promise, timeoutMs, `Timed out after ${timeoutMs}ms while ${description}.`);
  }

  async captureSnapshot(boxes?: boolean): Promise<TabSnapshot> {
    let tabSnapshot: TabSnapshot | undefined;
    const capture = { valid: true };
    const snapshotGeneration = this._ariaSnapshotGeneration;
    const modalStates = await this._raceAgainstModalStates(async () => {
      const [snapshot, title] = await Promise.all([
        this.withPageStateTimeout(
            this._captureAriaSnapshot(capture, boxes),
            'capturing page accessibility snapshot',
        ).catch(error => {
          if (!(error instanceof StaleAriaSnapshotError)) {
            capture.valid = false;
            logUnhandledError(error);
            if (snapshotGeneration === this._ariaSnapshotGeneration)
              this._invalidateAriaSnapshot();
          }
          return `# Page snapshot unavailable: ${errorMessage(error)}`;
        }),
        this.withPageStateTimeout(
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
    if (!tabSnapshot) {
      capture.valid = false;
      this._invalidateAriaSnapshot();
      return {
        url: this.page.url(),
        title: '',
        mainDocumentStatus: this._mainDocumentStatus,
        ariaSnapshot: '',
        modalStates,
        consoleMessages: [],
        downloads: [],
      };
    }
    tabSnapshot.consoleMessages = this._recentConsoleMessages;
    this._recentConsoleMessages = [];
    return tabSnapshot;
  }

  private _javaScriptBlocked(): boolean {
    return this._modalStates.some(state => state.type === 'dialog');
  }

  private async _raceAgainstModalStates(action: () => Promise<void>): Promise<ModalState[]> {
    if (this.modalStates().length)
      return this.modalStates();

    const promise = new ManualPromise<ModalState[]>();
    const listener = (modalState: ModalState) => promise.resolve([modalState]);
    this.once(TabEvents.modalState, listener);

    try {
      return await Promise.race([
        action().then(() => []),
        promise,
      ]);
    } finally {
      this.off(TabEvents.modalState, listener);
    }
  }

  async waitForCompletion(callback: () => Promise<void>) {
    await this._raceAgainstModalStates(() => waitForCompletion(this, callback));
  }

  async refLocator(params: { element: string, ref: string }): Promise<playwright.Locator> {
    return (await this.refLocators([params]))[0];
  }

  async refLocators(params: { element: string, ref: string }[]): Promise<playwright.Locator[]> {
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
    const timeout = Math.min(this.operationTimeout(), 1000);
    const matches = await Promise.all(params.map(async param => {
      const cached = lines.find(line => line.includes(`[ref=${param.ref}]`));
      if (!cached)
        return false;
      const current = await this.page.locator(`aria-ref=${param.ref}`)
          .ariaSnapshot({ mode: 'ai', depth: 1, timeout })
          .catch(() => '');
      return withoutSnapshotBox(current.split('\n', 1)[0]?.trim() ?? '') === withoutSnapshotBox(cached.trim());
    }));
    return pageGeneration === this._pageGeneration && matches.every(Boolean);
  }

  private async _captureAriaSnapshot(capture = { valid: true }, boxes?: boolean): Promise<string> {
    const pageGeneration = this._pageGeneration;
    const snapshot = await this.page.ariaSnapshot({ mode: 'ai', boxes });
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

function withoutSnapshotBox(line: string): string {
  return line.replace(/ \[box=[^\]]+\](?='?(?::|$))/, '');
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

function pageErrorToConsoleMessage(errorOrValue: unknown): ConsoleMessage {
  const text = errorMessage(errorOrValue);
  const details = (errorOrValue instanceof Error && errorOrValue.stack) || text;
  return { type: undefined, text, toString: () => details };
}

function navigationFailureToConsoleMessage(error: unknown): ConsoleMessage {
  const text = `Navigation failed after dialog interruption: ${errorMessage(error)}`;
  return { type: undefined, text, toString: () => `Error: ${text}` };
}

export function renderModalStates(context: Context, modalStates: ModalState[]): string[] {
  const result: string[] = ['### Modal state'];
  if (modalStates.length === 0)
    result.push('- There is no modal state present');
  for (const state of modalStates) {
    const tool = context.modalStateTools.find(tool => tool.clearsModalState === state.type);
    const description = truncateDataUrls(state.description);
    if (tool && isToolBlocked(context.config, tool.schema.name))
      result.push(`- [${description}]: would be handled by the "${tool.schema.name}" tool, but this server blocks it (blockedTools)`);
    else
      result.push(`- [${description}]: can be handled by the "${tool?.schema.name}" tool`);
  }
  return result;
}
