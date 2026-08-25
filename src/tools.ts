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

import common from './tools/common.js';
import console from './tools/console.js';
import dialogs from './tools/dialogs.js';
import evaluate from './tools/evaluate.js';
import files from './tools/files.js';
import form from './tools/form.js';
import install from './tools/install.js';
import keyboard from './tools/keyboard.js';
import mouse from './tools/mouse.js';
import navigate from './tools/navigate.js';
import network from './tools/network.js';
import pdf from './tools/pdf.js';
import recorder from './tools/recorder.js';
import session from './tools/session.js';
import snapshot from './tools/snapshot.js';
import tabs from './tools/tabs.js';
import screenshot from './tools/screenshot.js';
import wait from './tools/wait.js';
import verify from './tools/verify.js';
import auditSite from './tools/auditSite.js';
import scanPageMatrix from './tools/scanPageMatrix.js';
import auditKeyboard from './tools/auditKeyboard.js';
import auditScreenReader from './tools/auditScreenReader.js';

import type { Tool } from './tools/tool.js';
import type { FullConfig } from './config.js';

/** Also imported dynamically by bench/mcp-bench.mjs from the compiled lib. @public */
export const allTools: Tool<any>[] = [
  ...common,
  ...console,
  ...dialogs,
  ...evaluate,
  ...files,
  ...form,
  ...install,
  ...keyboard,
  ...navigate,
  ...network,
  ...mouse,
  ...pdf,
  ...recorder,
  ...screenshot,
  ...session,
  ...snapshot,
  ...tabs,
  ...wait,
  ...verify,
  ...auditSite,
  ...scanPageMatrix,
  ...auditKeyboard,
  ...auditScreenReader,
];

export function filteredTools(config: FullConfig) {
  return allTools.filter(tool => tool.capability.startsWith('core') || config.capabilities?.includes(tool.capability));
}

export const serverInstructions = [
  'This server runs automated web accessibility audits (axe-core / WCAG) and drives a real browser via Playwright.',
  'Use `browser_navigate` to load a page first. Then use `audit_site` to crawl and scan multiple pages of a site,',
  '`scan_page_matrix` to scan the current page across viewports and WCAG tag sets, `audit_keyboard` to check',
  'keyboard navigation, focus visibility and skip links, and `audit_screen_reader` to check accessible name quality',
  'and reading order. Results are returned as markdown with axe-core rule ids,',
  'impact levels, failure summaries and remediation links. Regular browser interaction tools (click, type, snapshot,',
  'screenshot, tabs) are also available for navigating to the state you want to audit.',
  'To work with several separate browsers at once, `browser_session_open` returns a browserSessionId that the',
  'non-session browser tools accept as an optional argument; omit it to use the default session, and close extra',
  'sessions with `browser_session_close` when done. Modes that share one live browser context (non-isolated CDP',
  'attach, extension) reject browser_session_open instead of handing out a session that is not separate.',
].join(' ');
