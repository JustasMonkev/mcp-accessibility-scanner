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

import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import auditKeyboardTools from '../src/tools/auditKeyboard.js';
import { Response } from '../src/response.js';
import type { FocusPoint } from '../src/tools/auditKeyboard.js';

function focusPoint(overrides: Partial<FocusPoint>): FocusPoint {
  return {
    role: null,
    name: null,
    tagName: 'DIV',
    id: null,
    href: null,
    text: null,
    boundingBox: { x: 0, y: 0, width: 40, height: 20 },
    inViewport: true,
    hasVisibleIndicator: true,
    isPointerTarget: false,
    inlineTarget: false,
    neighborTargets: [],
    obstruction: null,
    scrollX: 0,
    scrollY: 0,
    ...overrides,
  };
}

function createHarness(sequence: FocusPoint[], requestContext?: any) {
  let index = 0;
  const page = {
    evaluate: vi.fn(async () => {
      const point = sequence[index];
      index++;
      return point;
    }),
    keyboard: {
      press: vi.fn(async () => undefined),
    },
    url: vi.fn(() => 'https://example.com/'),
    goBack: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => undefined),
  };

  const tab: any = {
    modalStates: vi.fn(() => []),
    waitForCompletion: vi.fn(async (callback: () => Promise<void>) => await callback()),
    page,
    context: {
      outputFile: vi.fn(async (name: string) => `/tmp/${name}`),
    },
  };

  const context: any = {
    currentTabOrDie: vi.fn(() => tab),
    config: {},
  };

  const response = new Response(context, 'audit_keyboard', {}, requestContext);
  return { context, tab, page, response };
}

describe('audit_keyboard tool', () => {
  const tool = auditKeyboardTools.find(entry => entry.schema.name === 'audit_keyboard')!;
  let writeFileSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);
  });

  it('writes report with custom reportFile name', async () => {
    const { context, response } = createHarness([
      focusPoint({ role: 'document', tagName: 'BODY' }),
      focusPoint({ role: 'button', name: 'One', tagName: 'BUTTON', id: 'one' }),
    ]);

    await tool.handle(context as any, {
      maxTabs: 1,
      includeShiftTab: false,
      stopOnCycle: true,
      cycleWindow: 10,
      checkSkipLink: true,
      skipLinkMaxTabs: 3,
      activateSkipLink: false,
      checkFocusTrap: true,
      checkFocusVisibility: true,
      checkFocusJumps: true,
      checkTargetSize: false,
      checkFocusObscured: false,
      jumpScrollThresholdPx: 800,
      screenshotOnIssue: false,
      maxIssueScreenshots: 3,
      reportFile: 'my-keyboard-audit.json',
    } as any, response);

    expect(writeFileSpy).toHaveBeenCalledWith('/tmp/my-keyboard-audit.json', expect.any(String), 'utf-8');
    expect(response.result()).toContain('JSON report: /tmp/my-keyboard-audit.json');
  });

  it('includes issue screenshot paths and respects maxIssueScreenshots', async () => {
    const { context, page, response } = createHarness([
      focusPoint({ role: 'document', tagName: 'BODY' }),
      focusPoint({ role: 'button', name: 'One', tagName: 'BUTTON', id: 'one', hasVisibleIndicator: false, boundingBox: null, inViewport: false }),
      focusPoint({ role: 'button', name: 'One', tagName: 'BUTTON', id: 'one', hasVisibleIndicator: false, boundingBox: null, inViewport: false }),
      focusPoint({ role: 'button', name: 'Two', tagName: 'BUTTON', id: 'two', hasVisibleIndicator: false, boundingBox: null, inViewport: false }),
    ]);

    await tool.handle(context as any, {
      maxTabs: 2,
      includeShiftTab: false,
      stopOnCycle: false,
      cycleWindow: 10,
      checkSkipLink: false,
      skipLinkMaxTabs: 3,
      activateSkipLink: false,
      checkFocusTrap: false,
      checkFocusVisibility: true,
      checkFocusJumps: true,
      checkTargetSize: false,
      checkFocusObscured: false,
      jumpScrollThresholdPx: 10,
      screenshotOnIssue: true,
      maxIssueScreenshots: 1,
    } as any, response);

    expect(page.screenshot).toHaveBeenCalledTimes(1);
    expect(response.result()).toContain('Issue screenshots:');
  });

  it('reports WCAG 2.2 target size and obscured focus findings without flagging compliant stops', async () => {
    const { context, response } = createHarness([
      focusPoint({ role: 'document', tagName: 'BODY' }),
      focusPoint({
        role: 'link', tagName: 'A', name: 'Tiny link', isPointerTarget: true,
        boundingBox: { x: 0, y: 0, width: 12, height: 12 },
        neighborTargets: [{ x: 14, y: 0, width: 12, height: 12 }],
      }),
      focusPoint({
        role: 'button', tagName: 'BUTTON', name: 'Compliant', isPointerTarget: true,
        boundingBox: { x: 0, y: 100, width: 24, height: 24 },
        obstruction: { sampled: 5, blocked: 2, blockedBy: 'div.sticky' },
      }),
      focusPoint({
        role: 'link', tagName: 'A', name: 'Buried', isPointerTarget: true,
        boundingBox: { x: 0, y: 400, width: 80, height: 30 },
        obstruction: { sampled: 5, blocked: 5, blockedBy: 'div#sticky-footer' },
      }),
    ]);

    await tool.handle(context as any, {
      maxTabs: 3,
      includeShiftTab: false,
      stopOnCycle: false,
      cycleWindow: 10,
      checkSkipLink: false,
      skipLinkMaxTabs: 3,
      activateSkipLink: false,
      checkFocusTrap: false,
      checkFocusVisibility: false,
      checkFocusJumps: false,
      checkTargetSize: true,
      checkFocusObscured: true,
      jumpScrollThresholdPx: 800,
      screenshotOnIssue: false,
      maxIssueScreenshots: 3,
    } as any, response);

    const text = response.result();
    expect(text).toContain('Target size below 24x24 CSS px');
    expect(text).toContain('Tiny link is 12x12 CSS px');
    expect(text).toContain('Buried hidden behind div#sticky-footer');
    expect(text).not.toContain('Compliant');
    const report = JSON.parse(writeFileSpy.mock.calls[0]?.[1] as string);
    expect(report.targetSizeIssues).toHaveLength(1);
    expect(report.focusObscuredIssues).toHaveLength(1);
    expect((response.structuredContent() as any).summary).toMatchObject({
      targetSizeIssueCount: 1,
      focusObscuredIssueCount: 1,
    });
  });

  it('reports an obscured non-pointer-target and keeps inline-block and disabled-neighbour stops clean', async () => {
    const { context, response } = createHarness([
      focusPoint({ role: 'document', tagName: 'BODY' }),
      // Inline-level link inside a sentence: crowded, but exempt.
      focusPoint({
        role: 'link', tagName: 'A', name: 'Inline block terms', isPointerTarget: true, inlineTarget: true,
        boundingBox: { x: 0, y: 340, width: 12, height: 18 },
        neighborTargets: [{ x: 16, y: 340, width: 12, height: 18 }],
      }),
      // Only neighbour is a disabled button, which measurement no longer collects.
      focusPoint({
        role: 'link', tagName: 'A', name: 'Isolated link', isPointerTarget: true,
        boundingBox: { x: 0, y: 400, width: 18, height: 18 },
      }),
      // Transparent click-catcher: hit-tested but paints nothing.
      focusPoint({
        role: 'button', tagName: 'BUTTON', name: 'Covered control', isPointerTarget: true,
        boundingBox: { x: 300, y: 400, width: 40, height: 30 },
        obstruction: { sampled: 5, blocked: 0, blockedBy: null },
      }),
      // Focusable but not a pointer target, fully hidden by an opaque sticky panel.
      focusPoint({
        role: 'div', tagName: 'DIV', name: 'Editable region', isPointerTarget: false,
        boundingBox: { x: 0, y: 460, width: 200, height: 40 },
        obstruction: { sampled: 5, blocked: 5, blockedBy: 'div#panel' },
      }),
    ]);

    await tool.handle(context as any, {
      maxTabs: 4,
      includeShiftTab: false,
      stopOnCycle: false,
      cycleWindow: 10,
      checkSkipLink: false,
      skipLinkMaxTabs: 3,
      activateSkipLink: false,
      checkFocusTrap: false,
      checkFocusVisibility: false,
      checkFocusJumps: false,
      checkTargetSize: true,
      checkFocusObscured: true,
      jumpScrollThresholdPx: 800,
      screenshotOnIssue: false,
      maxIssueScreenshots: 3,
    } as any, response);

    const text = response.result();
    expect(text).toContain('Editable region hidden behind div#panel');
    expect(text).not.toContain('Inline block terms is');
    expect(text).not.toContain('Isolated link is');
    expect(text).not.toContain('Covered control');
    expect((response.structuredContent() as any).summary).toMatchObject({
      targetSizeIssueCount: 0,
      focusObscuredIssueCount: 1,
    });
  });

  it('applies SC 2.5.8 to a crowded contenteditable region but not to a roomy one', async () => {
    const { context, response } = createHarness([
      focusPoint({ role: 'document', tagName: 'BODY' }),
      // Measurement now matches contenteditable as a pointer target, so a crowded
      // 12x12 editable region is a real target-size failure.
      focusPoint({
        role: 'div', tagName: 'DIV', name: 'Tiny editor', isPointerTarget: true,
        boundingBox: { x: 450, y: 20, width: 12, height: 12 },
        neighborTargets: [{ x: 464, y: 20, width: 40, height: 30 }],
      }),
      focusPoint({
        role: 'div', tagName: 'DIV', name: 'Editable region', isPointerTarget: true,
        boundingBox: { x: 0, y: 460, width: 200, height: 40 },
      }),
    ]);

    await tool.handle(context as any, {
      maxTabs: 2,
      includeShiftTab: false,
      stopOnCycle: false,
      cycleWindow: 10,
      checkSkipLink: false,
      skipLinkMaxTabs: 3,
      activateSkipLink: false,
      checkFocusTrap: false,
      checkFocusVisibility: false,
      checkFocusJumps: false,
      checkTargetSize: true,
      checkFocusObscured: true,
      jumpScrollThresholdPx: 800,
      screenshotOnIssue: false,
      maxIssueScreenshots: 3,
    } as any, response);

    const text = response.result();
    expect(text).toContain('Tiny editor is 12x12 CSS px');
    expect(text).not.toContain('Editable region is');
    expect((response.structuredContent() as any).summary).toMatchObject({ targetSizeIssueCount: 1 });
  });

  it('emits progress notifications for each keyboard step', async () => {
    const sendNotification = vi.fn(async () => undefined);
    const { context, response } = createHarness([
      focusPoint({ role: 'document', tagName: 'BODY' }),
      focusPoint({ role: 'button', name: 'One', tagName: 'BUTTON', id: 'one' }),
      focusPoint({ role: 'button', name: 'One', tagName: 'BUTTON', id: 'one' }),
      focusPoint({ role: 'button', name: 'Two', tagName: 'BUTTON', id: 'two' }),
    ], {
      _meta: { progressToken: 'progress-keyboard' },
      sendNotification,
      signal: new AbortController().signal,
      requestId: 1,
    });

    await tool.handle(context as any, {
      maxTabs: 2,
      includeShiftTab: false,
      stopOnCycle: false,
      cycleWindow: 10,
      checkSkipLink: false,
      skipLinkMaxTabs: 3,
      activateSkipLink: false,
      checkFocusTrap: false,
      checkFocusVisibility: false,
      checkFocusJumps: false,
      checkTargetSize: false,
      checkFocusObscured: false,
      jumpScrollThresholdPx: 800,
      screenshotOnIssue: false,
      maxIssueScreenshots: 3,
    } as any, response);

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: 'notifications/progress',
      params: expect.objectContaining({
        progressToken: 'progress-keyboard',
        progress: 1,
        total: 2,
        message: expect.stringContaining('1/2'),
      }),
    }));
    expect(sendNotification).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: 'notifications/progress',
      params: expect.objectContaining({
        progressToken: 'progress-keyboard',
        progress: 2,
        total: 2,
        message: expect.stringContaining('2/2'),
      }),
    }));
  });
});
