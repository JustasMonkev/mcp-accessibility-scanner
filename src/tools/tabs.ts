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
import { defineTool } from './tool.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const browserTabs = defineTool({
  capability: 'core-tabs',
  schema: {
    name: 'browser_tabs',
    title: 'Manage tabs',
    description: 'List, create, close, or select a browser tab.',
    inputSchema: z.object({
      action: z.enum(['list', 'new', 'close', 'select']).describe('Operation to perform'),
      index: z.number().optional().describe('Tab index, used for close/select. If omitted for close, current tab is closed.'),
    }),
    type: 'destructive',
  },
  handle: async (context, params, response) => {
    switch (params.action) {
      case 'list': {
        await context.ensureTab();
        response.setIncludeTabs();
        return;
      }
      case 'new': {
        await context.newTab();
        response.setIncludeTabs();
        return;
      }
      case 'close': {
        await context.closeTab(params.index);
        response.setIncludeSnapshot();
        return;
      }
      case 'select': {
        if (params.index === undefined)
          throw new Error('Tab index is required');
        await context.selectTab(params.index);
        response.setIncludeSnapshot();
        return;
      }
    }
  },
});

const navigationTimeout = defineTool({
  capability: 'core-tabs',
  schema: {
    name: 'browser_navigation_timeout',
    title: 'Navigation timeout',
    description: 'Sets the timeout for navigation and page load actions. Only affects the current tab and does not persist across browser context recreation.',
    inputSchema: z.object({
      timeout: z.number().min(SECOND * 30).max(MINUTE * 20).describe('Timeout in milliseconds for navigation (0-300000ms)'),
    }),
    type: 'destructive',
  },
  handle: async (context, params, response) => {
    const tabs = context.tabs();
    for (const tab of tabs) {
      tab.page.setDefaultNavigationTimeout(params.timeout);
    }
    response.addResult(`Navigation timeout set to ${params.timeout}ms for all tabs.`);
    response.setIncludeTabs();
  },
});

const defaultTimeout = defineTool({
  capability: 'core-tabs',
  schema: {
    name: 'browser_default_timeout',
    title: 'Default timeout',
    description: 'Sets the default timeout for all Playwright operations (clicks, fills, etc). Only affects existing tabs and does not persist across browser context recreation.',
    inputSchema: z.object({
      timeout: z.number().min(SECOND * 30).max(MINUTE * 20).describe('Timeout in milliseconds for default operations (0-300000ms)'),
    }),
    type: 'destructive',
  },
  handle: async (context, params, response) => {
    const tabs = context.tabs();
    for (const tab of tabs) {
      tab.page.setDefaultTimeout(params.timeout);
    }

    response.addResult(`Default timeout set to ${params.timeout}ms for all tabs.`);
    response.setIncludeTabs();
  },
});

export default [
  browserTabs,
  navigationTimeout,
  defaultTimeout
];
