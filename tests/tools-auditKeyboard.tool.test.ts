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
    scrollX: 0,
    scrollY: 0,
    ...overrides,
  };
}

function createHarness(sequence: FocusPoint[]) {
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

  const response = new Response(context, 'audit_keyboard', {});
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
      jumpScrollThresholdPx: 10,
      screenshotOnIssue: true,
      maxIssueScreenshots: 1,
    } as any, response);

    expect(page.screenshot).toHaveBeenCalledTimes(1);
    expect(response.result()).toContain('Issue screenshots:');
  });
});
