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

import { logUnhandledError } from './utils/log.js';

import type * as playwright from 'playwright';
import type * as actions from './actions.js';
import type { Context } from './context.js';

export const recorderBufferMs = 500;
const expectPrelude = "const { expect } = require('playwright/test');";

export type RecordedAction = { page: playwright.Page, code: string, sequence?: number };
export type RecordingTarget = {
  actions: RecordedAction[];
  pageIndexes: Map<playwright.Page, number>;
  state: { stopping: boolean };
};
export type Recording = { target: RecordingTarget, ready: Promise<playwright.BrowserContext>, lastActivityAt: number };
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
const recorderParams = { language: 'javascript' };

type RecorderSink = {
  actionAdded: (page: playwright.Page, data: actions.Action | actions.ActionInContext, code: string) => void;
  actionUpdated: (page: playwright.Page, data: actions.Action | actions.ActionInContext, code: string) => void;
  signalAdded: (page: playwright.Page, data: actions.Signal | actions.SignalInContext, code: string) => void;
};

// Playwright starts one programmatic recording per client connection, always in
// 'recording' mode with call tracking omitted; starting a second one throws.
type PlaywrightRecorderControl = {
  _startRecording(params: typeof recorderParams, sink: RecorderSink): Promise<void>;
  _stopRecording(): Promise<void>;
};

class RecorderHub {
  readonly recorders = new Set<InputRecorder>();
  readonly recordings = new Map<Context, RecordingTarget>();
  starting = 0;
  readonly ready: Promise<void>;
  private readonly _browserContext: playwright.BrowserContext;
  private readonly _lastActionSequence = new WeakMap<playwright.Page, number>();
  private _actionSequence = 0;
  private _armed = false;
  private _transition = Promise.resolve();

  constructor(browserContext: playwright.BrowserContext) {
    this._browserContext = browserContext;
    this.ready = this.ensureArmed();
  }

  ensureArmed(): Promise<void> {
    return this._enqueue(async () => {
      if (!this._armed)
        await this._arm();
    });
  }

  standbyIfIdle(): Promise<void> {
    return this._enqueue(async () => {
      if (this.starting || this.recorders.size || this.recordings.size)
        return;
      try {
        await this._control()._stopRecording();
      } finally {
        this._armed = false;
      }
    });
  }

  private _control(): PlaywrightRecorderControl {
    return this._browserContext as unknown as PlaywrightRecorderControl;
  }

  private async _arm(): Promise<void> {
    await this._control()._startRecording(recorderParams, this._sink);
    this._armed = true;
  }

  private _enqueue(callback: () => Promise<void>): Promise<void> {
    const result = this._transition.then(callback, callback);
    this._transition = result.catch(() => {});
    return result;
  }

  private _dispatch(buffered: boolean, flushable: boolean, log: (recorder: InputRecorder) => void, record: (target: RecordingTarget) => void): void {
    const contexts = new Set<Context>(recorderContexts.get(this._browserContext));
    for (const context of this.recordings.keys())
      contexts.add(context);
    const running = [...contexts].filter(context => context.isRunningToolForRecording(buffered));
    if (!running.length) {
      for (const recorder of this.recorders)
        log(recorder);
    }
    for (const [context, target] of this.recordings) {
      if ((!target.state.stopping || flushable) && !running.some(runningContext => runningContext !== context)) {
        record(target);
        context.markRecordingActivity();
      }
    }
  }

  private readonly _sink: RecorderSink = {
    actionAdded: (page, data, code) => {
      const sequence = ++this._actionSequence;
      this._lastActionSequence.set(page, sequence);
      const action = 'action' in data ? data.action : data;
      const isAssertion = action.name.startsWith('assert');
      if (isAssertion)
        code = code.replace(/^(\s*)\/\/ ?/gm, '$1');
      const buffered = actionIsBuffered(action);
      this._dispatch(
          buffered,
          buffered || action.name === 'closePage',
          recorder => recorder.logActionAdded(page, action, isAssertion ? `${expectPrelude}\n${code}` : code, sequence),
          target => {
            if (isAssertion && !target.actions.some(recorded => recorded.code === expectPrelude))
              target.actions.push({ page, code: expectPrelude });
            addMissingPageAlias(target.actions, page, code, target.pageIndexes, this._browserContext);
            target.actions.push({ page, code, sequence });
          },
      );
    },
    actionUpdated: (page, data, code) => {
      const sequence = this._lastActionSequence.get(page);
      if (sequence === undefined)
        return;
      const action = 'action' in data ? data.action : data;
      this._dispatch(
          true,
          true,
          recorder => recorder.logActionUpdated(page, action, code, sequence),
          target => {
            const recorded = target.actions.findLast(candidate => candidate.sequence === sequence);
            if (recorded)
              recorded.code = code;
          },
      );
    },
    signalAdded: (page, data, code) => {
      const sequence = this._lastActionSequence.get(page);
      const signal = 'signal' in data ? data.signal : data;
      this._dispatch(
          true,
          true,
          recorder => recorder.logSignalAdded(page, signal, code, sequence),
          target => {
            if (sequence === undefined)
              return;
            const recorded = target.actions.findLast(candidate => candidate.sequence === sequence);
            if (recorded && code)
              recorded.code = code;
          },
      );
    },
  };
}

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
        await hub.ensureArmed();
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
    const recordings = recorderHubs.get(browserContext)?.recordings;
    await new Promise(resolve => setTimeout(resolve, recorderBufferMs));
    if (recordings?.get(context) === target) {
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
    const existing = recorderHubs.get(browserContext);
    if (existing)
      return existing;
    const created = new RecorderHub(browserContext);
    created.ready.catch(() => {
      if (recorderHubs.get(browserContext) === created)
        recorderHubs.delete(browserContext);
    });
    recorderHubs.set(browserContext, created);
    return created;
  }

  logActionAdded(page: playwright.Page, action: actions.Action, code: string, sequence: number) {
    this._lastActions.set(page, { action, sequence });
    const tab = this._context.tabForPage(page);
    if (tab)
      this._context.sessionLog!.logUserAction(action, tab, code, false);
  }

  logActionUpdated(page: playwright.Page, action: actions.Action, code: string, sequence: number) {
    if (this._lastActions.get(page)?.sequence !== sequence)
      return;
    this._lastActions.set(page, { action, sequence });
    const tab = this._context.tabForPage(page);
    if (tab)
      this._context.sessionLog!.logUserAction(action, tab, code, true);
  }

  logSignalAdded(page: playwright.Page, signal: actions.Signal, code: string, sequence?: number) {
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
