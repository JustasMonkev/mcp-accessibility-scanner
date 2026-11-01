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

import { z } from 'zod';
import { defineTabTool, defineTool } from './tool.js';
import * as javascript from '../utils/codegen.js';

import type * as playwright from 'playwright';

const close = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_close',
    title: 'Close browser',
    description: 'Close the page',
    inputSchema: z.object({}),
    type: 'readOnly',
  },

  handle: async (context, params, response) => {
    await context.closeBrowserContext();
    response.setIncludeTabs();
    response.addCode(`await page.close()`);
  },
});

const resize = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_resize',
    title: 'Resize browser window',
    description: 'Resize the browser window',
    inputSchema: z.object({
      width: z.number().describe('Width of the browser window'),
      height: z.number().describe('Height of the browser window'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    response.addCode(`await page.setViewportSize({ width: ${params.width}, height: ${params.height} });`);

    await tab.waitForCompletion(async () => {
      await tab.page.setViewportSize({ width: params.width, height: params.height });
    });
  },
});

const emulateMedia = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_emulate_media',
    title: 'Emulate media features',
    description: 'Emulate CSS media features for the page. Omitted parameters keep their current state.',
    inputSchema: z.object({
      colorScheme: z.enum(['light', 'dark']).optional().describe('Emulates prefers-color-scheme'),
      reducedMotion: z.enum(['reduce', 'no-preference']).optional().describe('Emulates prefers-reduced-motion'),
      forcedColors: z.enum(['active', 'none']).optional().describe('Emulates forced-colors'),
      contrast: z.enum(['more', 'no-preference']).optional().describe('Emulates prefers-contrast'),
      media: z.enum(['screen', 'print']).optional().describe('Changes the CSS media type'),
    }),
    type: 'stateChanging',
    idempotent: true,
  },

  handle: async (tab, params, response) => {
    const requested = {
      colorScheme: params.colorScheme,
      contrast: params.contrast,
      forcedColors: params.forcedColors,
      media: params.media,
      reducedMotion: params.reducedMotion,
    };
    const options = Object.fromEntries(Object.entries(requested).filter(([, value]) => value !== undefined)) as NonNullable<Parameters<playwright.Page['emulateMedia']>[0]>;
    if (!Object.keys(options).length) {
      response.addError('Specify at least one media feature to emulate.');
      return;
    }
    response.addCode(`await page.emulateMedia(${javascript.formatObject(options)});`);
    await tab.waitForCompletion(async () => {
      await tab.page.emulateMedia(options);
    });
  },
});

export default [
  close,
  resize,
  emulateMedia,
];
