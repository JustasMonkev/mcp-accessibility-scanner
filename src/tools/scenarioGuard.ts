/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

import type { Frame, JSHandle } from 'playwright';
import type { Tab } from '../tab.js';
import { rejectAfterTimeout, rejectOnAbort } from '../utils/timeout.js';

export type Interruption = 'aborted' | 'modal' | 'navigation' | 'popup' | 'page-closed' | 'time-budget';
export type Bounded = <T>(run: (timeout: number) => Promise<T>) => Promise<T>;
export type ScenarioGuard = ReturnType<typeof scenarioGuard>;

export function scenarioGuard(tab: Tab, signal: AbortSignal | undefined, budgetMs: number, operationTimeoutMs: number) {
  const page = tab.page;
  const controller = new AbortController();
  let reason: Interruption | undefined;
  let deadline = 0;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (interruption: Interruption) => {
    reason ??= interruption;
    controller.abort(new Error(reason));
  };
  const setBudget = (ms: number) => {
    clearTimeout(budgetTimer);
    deadline = Date.now() + ms;
    budgetTimer = setTimeout(() => stop('time-budget'), ms);
    budgetTimer.unref?.();
  };
  const onAbort = () => stop('aborted');
  const onModal = () => stop('modal');
  const onNavigation = (frame: Frame) => {
    if (frame === page.mainFrame())
      stop('navigation');
  };
  const onPopup = () => stop('popup');
  const onClose = () => stop('page-closed');
  signal?.addEventListener('abort', onAbort);
  tab.on('modalState', onModal);
  page.on('framenavigated', onNavigation);
  page.on('popup', onPopup);
  page.on('close', onClose);
  if (signal?.aborted)
    stop('aborted');
  else if (tab.modalStates().length)
    stop('modal');
  else if (page.isClosed())
    stop('page-closed');
  setBudget(budgetMs);
  const remaining = () => deadline - Date.now();
  const operationTimeout = (available = remaining()) => Math.max(1, Math.min(operationTimeoutMs, available));
  const bounded: Bounded = async run => {
    const available = remaining();
    if (available <= 0)
      stop('time-budget');
    const timeout = operationTimeout(available);
    const result = await rejectOnAbort(() => rejectAfterTimeout(run(timeout), timeout, 'time-budget'), controller.signal);
    controller.signal.throwIfAborted();
    return result;
  };
  return {
    signal: controller.signal,
    reason: () => reason,
    remaining,
    setBudget,
    bounded,
    release: async (...handles: (JSHandle | null)[]) => {
      await rejectAfterTimeout(Promise.all(handles.map(handle => handle?.dispose())), operationTimeout(), 'Handle cleanup timed out.');
    },
    dispose: () => {
      clearTimeout(budgetTimer);
      signal?.removeEventListener('abort', onAbort);
      tab.off('modalState', onModal);
      page.off('framenavigated', onNavigation);
      page.off('popup', onPopup);
      page.off('close', onClose);
    },
  };
}
