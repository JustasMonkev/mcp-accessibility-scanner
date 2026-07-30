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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import dialogTools from '../src/tools/dialogs.js';
import { Response } from '../src/response.js';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { resolveConfig } from '../src/config.js';
import type { Context } from '../src/context.js';
import type { Tab } from '../src/tab.js';

const handleDialogTool = dialogTools.find(t => t.schema.name === 'browser_handle_dialog')!;

describe('browser_handle_dialog', () => {
  let mockContext: Context;
  let mockTab: Tab;
  let response: Response;
  let dialogState: any;
  let dialog: { accept: ReturnType<typeof vi.fn>, dismiss: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    dialog = {
      accept: vi.fn().mockResolvedValue(undefined),
      dismiss: vi.fn().mockResolvedValue(undefined),
    };
    dialogState = {
      type: 'dialog' as const,
      description: '"confirm" dialog with message "Proceed?"',
      dialog,
    };
    mockTab = {
      modalStates: vi.fn().mockReturnValue([dialogState]),
      modalStatesMarkdown: vi.fn().mockReturnValue([]),
      clearModalState: vi.fn(),
      waitForCompletion: vi.fn().mockImplementation(async (cb: () => Promise<void>) => await cb()),
    } as any;
    mockContext = {
      currentTabOrDie: () => mockTab,
      config: {},
    } as any;
    response = new Response(mockContext, 'browser_handle_dialog', {});
  });

  it('accepts a live dialog and clears its state', async () => {
    await handleDialogTool.handle(mockContext, { accept: true, promptText: 'hi' }, response);

    expect(dialog.accept).toHaveBeenCalledWith('hi');
    expect(mockTab.clearModalState).toHaveBeenCalledWith(dialogState);
    expect(response.isError()).not.toBe(true);
    expect(response.result()).not.toContain('already closed');
  });

  it('recovers when accept fails because the dialog was closed out of band', async () => {
    dialog.accept.mockRejectedValue(new Error('dialog.accept: Protocol error (Page.handleJavaScriptDialog): No dialog is showing'));

    await handleDialogTool.handle(mockContext, { accept: true }, response);

    expect(mockTab.clearModalState).toHaveBeenCalledWith(dialogState);
    expect(response.isError()).not.toBe(true);
    expect(response.result()).toContain('already closed out of band');
  });

  it('recovers when dismiss trips the already-handled client guard', async () => {
    dialog.dismiss.mockRejectedValue(new Error('Cannot dismiss dialog which is already handled!'));

    await handleDialogTool.handle(mockContext, { accept: false }, response);

    expect(mockTab.clearModalState).toHaveBeenCalledWith(dialogState);
    expect(response.isError()).not.toBe(true);
    expect(response.result()).toContain('already closed out of band');
  });

  it('still fails on errors that do not mean the dialog is gone', async () => {
    dialog.accept.mockRejectedValue(new Error('dialog.accept: Timeout 5000ms exceeded'));

    await expect(handleDialogTool.handle(mockContext, { accept: true }, response)).rejects.toThrow('Timeout 5000ms exceeded');
    // The state was cleared up front, so the session is not wedged even here.
    expect(mockTab.clearModalState).toHaveBeenCalledWith(dialogState);
  });

  it('does not rewrite ordinary text that merely resembles the errors', async () => {
    dialog.accept.mockRejectedValue(new Error('page crashed while a dialog was open'));

    await expect(handleDialogTool.handle(mockContext, { accept: true }, response)).rejects.toThrow('page crashed');
  });
});

const hasBundledChromium = await chromium.launch({ headless: true, chromiumSandbox: false })
    .then(async browser => {
      await browser.close();
      return true;
    })
    .catch(() => false);

describe.skipIf(!hasBundledChromium)('phantom dialog recovery in a real browser', () => {
  let browser: Browser | undefined;
  let browserContext: BrowserContext | undefined;
  let backend: BrowserServerBackend | undefined;

  afterEach(async () => {
    backend?.serverClosed();
    await browserContext?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    browser = browserContext = backend = undefined;
  });

  it('unblocks the session after a dialog is closed through a CDP side-channel', async () => {
    const config = await resolveConfig({
      browser: {
        browserName: 'chromium',
        isolated: true,
        launchOptions: { headless: true, chromiumSandbox: false },
      },
      timeouts: { navigationTimeout: 15000, defaultTimeout: 5000 },
    });

    backend = new BrowserServerBackend(config, {
      createContext: async () => {
        browser = await chromium.launch({ headless: true, chromiumSandbox: false });
        browserContext = await browser.newContext();
        await browserContext.route('http://fixture.local/**', route => route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><html lang="en"><head><title>Dialogs</title></head><body><button type="button">Ok</button></body></html>',
        }));
        return {
          browserContext,
          close: async () => {
            await browserContext?.close();
            await browser?.close();
          },
        };
      },
    });
    await backend.initialize({} as any, { name: 'vitest', version: 'dialogs' }, []);

    const navigateResult = await backend.callTool('browser_navigate', { url: 'http://fixture.local/' });
    expect(navigateResult.isError).not.toBe(true);

    // The side-channel must attach before the dialog opens: a session that
    // never saw the dialog open cannot handle it, and the paused renderer
    // will not answer new attachments while the dialog is up.
    const page = browserContext!.pages()[0];
    const cdp = await browserContext!.newCDPSession(page);
    await cdp.send('Page.enable');

    const evaluateResult = await backend.callTool('browser_evaluate', { function: '() => confirm("out of band?")' });
    expect((evaluateResult.content[0] as any).text).toContain('"confirm" dialog with message "out of band?"');

    // Close the dialog behind the tab's back, as a human would in headed mode.
    await cdp.send('Page.handleJavaScriptDialog', { accept: false });

    // The tab never learns of the close on Playwright 1.62 (no dialogclosed
    // event), so the stale modal state still starves snapshot-bearing tools:
    // the response shows only the phantom dialog, never the page content.
    const blockedResult = await backend.callTool('browser_snapshot', {});
    const blockedText = (blockedResult.content[0] as any).text as string;
    expect(blockedText).toContain('"confirm" dialog with message "out of band?"');
    expect(blockedText).not.toContain('button "Ok"');

    // ...but handling the phantom dialog recovers instead of dead-ending.
    const handleResult = await backend.callTool('browser_handle_dialog', { accept: true });
    expect(handleResult.isError).not.toBe(true);
    expect((handleResult.content[0] as any).text).toContain('already closed out of band');

    const recoveredResult = await backend.callTool('browser_snapshot', {});
    expect(recoveredResult.isError).not.toBe(true);
    const recoveredText = (recoveredResult.content[0] as any).text as string;
    expect(recoveredText).toContain('button "Ok"');
    expect(recoveredText).not.toContain('"confirm" dialog');
  });
});
