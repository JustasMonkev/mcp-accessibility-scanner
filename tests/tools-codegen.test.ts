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

import { describe, expect, it, vi } from 'vitest';
import keyboardTools from '../src/tools/keyboard.js';
import navigateTools from '../src/tools/navigate.js';
import { Response } from '../src/response.js';

describe('tool code generation', () => {
  it.each([
    ['browser_navigate', { url: `https://example.com/it's` }, ['goto', `https://example.com/it's`]],
    ['browser_press_key', { key: `'` }, ['press', `'`]],
    ['browser_press_key', { key: '\ninvalid javascript }' }, ['press', '\ninvalid javascript }']],
  ])('escapes user input for %s', async (toolName, args, expectedCall) => {
    const tab = {
      modalStates: () => [],
      navigate: vi.fn(),
      page: { keyboard: { press: vi.fn() } },
      waitForCompletion: async (callback: () => Promise<void>) => await callback(),
    };
    const context = {
      config: {},
      currentTabOrDie: () => tab,
      ensureTab: async () => tab,
    };
    const response = new Response(context as any, toolName, args);
    const tool = [...navigateTools, ...keyboardTools].find(candidate => candidate.schema.name === toolName)!;

    await tool.handle(context as any, args as any, response);

    const calls: unknown[][] = [];
    const page = {
      goto: async (url: string) => { calls.push(['goto', url]); },
      keyboard: { press: async (key: string) => { calls.push(['press', key]); } },
    };
    await new Function('page', `return (async () => {\n${response.code()}\n})();`)(page);

    expect(calls).toEqual([expectedCall]);
  });
});
