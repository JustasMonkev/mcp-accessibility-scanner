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

import { isToolBlocked } from './mcp/toolPolicy.js';
import type { ToolPolicy } from './mcp/toolPolicy.js';
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

export function validateToolPolicy(config: ToolPolicy): void {
  // browser_connect belongs to the proxies, not the browser tool registry.
  const knownNames = new Set([...allTools.map(tool => tool.schema.name), 'browser_connect']);
  for (const option of ['allowedTools', 'blockedTools'] as const) {
    const names = config[option];
    if (names === undefined)
      continue;
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !name.trim()))
      throw new Error(`${option} must be an array of non-blank exact tool names. Use [] to clear the list.`);
    for (const name of names) {
      if (knownNames.has(name))
        continue;
      // Generated page-tool names hash a per-process scope id, a per-document
      // id and the document's timeOrigin (see listWebMCPTools), so a name
      // copied from tools/list can never match once the server restarts.
      // Accepting it would leave the page tool silently exposed.
      throw new Error(name.startsWith('webmcp_')
        ? `Unknown tool in ${option}: ${name}. Page-registered WebMCP tool names are generated for each server run and registration, so they cannot be configured ahead of time.`
        : `Unknown tool in ${option}: ${name}`);
    }
  }
}

export function filteredTools(config: FullConfig) {
  validateToolPolicy(config);
  return allTools.filter(tool => !isToolBlocked(config, tool.schema.name) && (
    tool.capability.startsWith('core')
    || config.capabilities?.includes(tool.capability)
    || config.allowedTools?.includes(tool.schema.name)
    || (tool.capability === 'install' && config.capabilities?.includes('core-install'))));
}

const auditGuidance: [tool: string, purpose: string][] = [
  ['audit_site', 'to crawl and scan multiple pages of a site'],
  ['scan_page_matrix', 'to scan the current page across viewports and WCAG tag sets'],
  ['audit_keyboard', 'to check keyboard navigation, focus visibility and skip links'],
  ['audit_screen_reader', 'to check accessible name quality and reading order'],
];

const interactionTools: [label: string, tool: string][] = [
  ['click', 'browser_click'],
  ['type', 'browser_type'],
  ['snapshot', 'browser_snapshot'],
  ['screenshot', 'browser_take_screenshot'],
  ['tabs', 'browser_tabs'],
];

const joinList = (items: string[]) => items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;

/** Names only tools the policy leaves callable, so clients are never pointed at a guaranteed InvalidParams. */
export function serverInstructions(policy: ToolPolicy): string {
  const usable = (name: string) => !isToolBlocked(policy, name);
  const canNavigate = usable('browser_navigate');
  const audits = auditGuidance.filter(([tool]) => usable(tool)).map(([tool, purpose]) => `\`${tool}\` ${purpose}`);
  const interaction = interactionTools.filter(([, tool]) => usable(tool)).map(([label]) => label);
  const parts = ['This server runs automated web accessibility audits (axe-core / WCAG) and drives a real browser via Playwright.'];
  if (canNavigate)
    parts.push('Use `browser_navigate` to load a page first.');
  if (audits.length) {
    parts.push(`${canNavigate ? 'Then use' : 'Use'} ${joinList(audits)}.`);
    parts.push('Results are returned as markdown with axe-core rule ids, impact levels, failure summaries and remediation links.');
  }
  if (interaction.length)
    parts.push(`Regular browser interaction tools (${interaction.join(', ')}) are also available for navigating to the state you want to audit.`);
  if (usable('browser_session_open')) {
    parts.push('To work with several separate browsers at once, `browser_session_open` returns a browserSessionId that the non-session browser tools accept as an optional argument; omit it to use the default session'
      + (usable('browser_session_close') ? ', and close extra sessions with `browser_session_close` when done.' : '.'));
    parts.push('Modes that share one live browser context (non-isolated CDP attach, extension) reject browser_session_open instead of handing out a session that is not separate.');
  }
  return parts.join(' ');
}
