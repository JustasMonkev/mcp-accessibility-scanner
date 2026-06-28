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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import mouseTools from '../src/tools/mouse.js';
import { Response } from '../src/response.js';
import type { Context } from '../src/context.js';
import type { Tab } from '../src/tab.js';

describe('Mouse Tools', () => {
  let mockContext: Context;
  let mockClick: ReturnType<typeof vi.fn>;
  let response: Response;

  const clickTool = mouseTools.find(t => t.schema.name === 'browser_mouse_click_xy')!;

  beforeEach(() => {
    mockClick = vi.fn().mockResolvedValue(undefined);

    const mockTab = {
      modalStates: vi.fn().mockReturnValue([]),
      page: { mouse: { click: mockClick } },
      waitForCompletion: vi.fn(async (cb: () => Promise<void>) => cb()),
    } as unknown as Tab;

    mockContext = {
      currentTabOrDie: () => mockTab,
      config: {},
    } as unknown as Context;

    response = new Response(mockContext, 'browser_mouse_click_xy', {});
  });

  it('exposes button, clickCount and delay options', () => {
    const shape = (clickTool.schema.inputSchema as any).shape;
    expect(Object.keys(shape)).toEqual(
        expect.arrayContaining(['x', 'y', 'button', 'clickCount', 'delay']));
    expect(clickTool.schema.description).toBe('Click mouse button at a given position');
  });

  it('performs a default left click without emitting options', async () => {
    await clickTool.handle(mockContext, { element: 'target', x: 10, y: 20 }, response);

    expect(mockClick).toHaveBeenCalledWith(10, 20, {
      button: undefined,
      clickCount: undefined,
      delay: undefined,
    });
    expect(response.code()).toContain('await page.mouse.click(10, 20);');
  });

  it('forwards button, clickCount and delay to the click and generated code', async () => {
    await clickTool.handle(
        mockContext,
        { element: 'target', x: 5, y: 7, button: 'right', clickCount: 2, delay: 50 },
        response);

    expect(mockClick).toHaveBeenCalledWith(5, 7, {
      button: 'right',
      clickCount: 2,
      delay: 50,
    });
    const code = response.code();
    expect(code).toContain('await page.mouse.click(5, 7, {');
    expect(code).toContain(`button: 'right'`);
    expect(code).toContain('clickCount: 2');
    expect(code).toContain('delay: 50');
  });
});
