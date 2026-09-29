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

import { Client } from '@modelcontextprotocol/client';
import { ProtocolErrorCode } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { resolveConfig } from '../src/config.js';
import { createConnection } from '../src/index.js';
import { InProcessTransport } from '../src/mcp/inProcessTransport.js';
import { ProxyBackend } from '../src/mcp/proxyBackend.js';
import { wrapInProcess } from '../src/mcp/server.js';
import type { ServerBackendContext } from '../src/mcp/server.js';
import { allTools, filteredTools, serverInstructions } from '../src/tools.js';
import { VSCodeProxyBackend } from '../src/vscode/host.js';

const pageTool = 'webmcp_prepare_0123456789abcdef0123';
const names = (tools: { name: string }[]) => tools.map(tool => tool.name);
const unusedFactory = { createContext: vi.fn(async () => { throw new Error('unexpected browser launch'); }) };

describe('exact-name tool policy', () => {
  it('preserves defaults and adds only the named optional tools', async () => {
    const defaults = filteredTools(await resolveConfig({})).map(tool => tool.schema.name);
    expect(defaults).not.toContain('browser_install');
    expect(defaults).not.toContain('browser_pdf_save');
    const cleared = filteredTools(await resolveConfig({ allowedTools: [], blockedTools: [] }));
    expect(cleared.map(tool => tool.schema.name)).toEqual(defaults);
    const added = filteredTools(await resolveConfig({ allowedTools: ['browser_pdf_save', 'browser_pdf_save'] }));
    expect(added.map(tool => tool.schema.name).sort()).toEqual([...defaults, 'browser_pdf_save'].sort());
  });

  it('lets blocking override core, capabilities, allowed names and the install alias', async () => {
    const blockedTools = ['browser_navigate', 'audit_site', 'browser_session_open', 'browser_session_close', 'browser_pdf_save', 'browser_install'];
    const config = await resolveConfig({ capabilities: ['pdf', 'core-install'], allowedTools: blockedTools, blockedTools });
    const backend = new BrowserServerBackend(config, unusedFactory);
    expect(names(await backend.listTools())).toContain('browser_snapshot');
    for (const name of blockedTools) {
      expect(names(await backend.listTools())).not.toContain(name);
      // Denial must precede argument parsing, session lookup and browser work.
      await expect(backend.callTool(name, { browserSessionId: 'unknown' })).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams, message: expect.stringContaining('not found'),
      });
    }
    expect(unusedFactory.createContext).not.toHaveBeenCalled();
  });

  it('can explicitly enable browser installation without broadening other capabilities', async () => {
    const backend = new BrowserServerBackend(await resolveConfig({ allowedTools: ['browser_install'] }), unusedFactory);
    expect(names(await backend.listTools())).toContain('browser_install');
    expect(names(await backend.listTools())).not.toContain('browser_pdf_save');
  });

  it('can remove every built-in, including the otherwise always-on core tools', async () => {
    const backend = new BrowserServerBackend(await resolveConfig({ blockedTools: allTools.map(tool => tool.schema.name) }), unusedFactory);
    expect(await backend.listTools()).toEqual([]);
  });

  it.each(['allowedTools', 'blockedTools'] as const)('validates %s before startup', async option => {
    for (const value of [null, 'browser_navigate', [4], [''], [' '], ['browser_nav'], ['browser_*'], ['webmcp_prepare']])
      await expect(resolveConfig({ [option]: value } as any)).rejects.toThrow(new RegExp(`${option}|Unknown tool`));
    await expect(resolveConfig({ [option]: ['browser_connect', pageTool] })).resolves.toHaveProperty(option, ['browser_connect', pageTool]);
  });
});

describe('server instructions follow the tool policy', () => {
  const intro = 'This server runs automated web accessibility audits (axe-core / WCAG) and drives a real browser via Playwright.';
  const advertised = (text: string) => [...text.matchAll(/`([a-z_]+)`/g)].map(match => match[1]);

  it('is unchanged when nothing is blocked', () => {
    expect(serverInstructions({})).toBe(intro + ' Use `browser_navigate` to load a page first. Then use `audit_site` to crawl and scan multiple pages of a site, '
      + '`scan_page_matrix` to scan the current page across viewports and WCAG tag sets, `audit_keyboard` to check keyboard navigation, focus visibility and skip links, '
      + 'and `audit_screen_reader` to check accessible name quality and reading order. Results are returned as markdown with axe-core rule ids, impact levels, '
      + 'failure summaries and remediation links. Regular browser interaction tools (click, type, snapshot, screenshot, tabs) are also available for navigating to '
      + 'the state you want to audit. To work with several separate browsers at once, `browser_session_open` returns a browserSessionId that the non-session browser '
      + 'tools accept as an optional argument; omit it to use the default session, and close extra sessions with `browser_session_close` when done. Modes that share '
      + 'one live browser context (non-isolated CDP attach, extension) reject browser_session_open instead of handing out a session that is not separate.');
    expect(serverInstructions({ blockedTools: [] })).toBe(serverInstructions({}));
  });

  it.each(['browser_navigate', 'audit_site', 'scan_page_matrix', 'audit_keyboard', 'audit_screen_reader', 'browser_session_open', 'browser_session_close'])(
      'never names %s once it is blocked', async name => {
        const config = await resolveConfig({ blockedTools: [name] });
        const text = serverInstructions(config);
        expect(text).not.toContain(name);
        // Whatever is still recommended must be listed and callable.
        const exposed = new Set(filteredTools(config).map(tool => tool.schema.name));
        for (const recommended of advertised(text))
          expect(exposed.has(recommended)).toBe(true);
      });

  it.each([
    ['click', 'browser_click', '(type, snapshot, screenshot, tabs)'],
    ['tabs', 'browser_tabs', '(click, type, snapshot, screenshot)'],
  ])('drops the %s interaction hint when %s is blocked', (_label, name, remaining) => {
    expect(serverInstructions({ blockedTools: [name] })).toContain(`Regular browser interaction tools ${remaining} are also available`);
  });

  it('keeps the sentences grammatical for partial catalogs', () => {
    const skipNavigate = serverInstructions({ blockedTools: ['browser_navigate', 'audit_keyboard', 'audit_screen_reader'] });
    expect(skipNavigate).toContain('Use `audit_site` to crawl and scan multiple pages of a site and `scan_page_matrix` to scan the current page across viewports and WCAG tag sets.');
    expect(skipNavigate).not.toContain('Then use');
    expect(serverInstructions({ blockedTools: ['audit_site', 'scan_page_matrix', 'audit_keyboard'] }))
        .toContain('Then use `audit_screen_reader` to check accessible name quality and reading order.');
    const noClose = serverInstructions({ blockedTools: ['browser_session_close'] });
    expect(noClose).toContain('omit it to use the default session. Modes that share');
    expect(noClose).not.toContain('close extra sessions');
    const noAudits = serverInstructions({ blockedTools: ['audit_site', 'scan_page_matrix', 'audit_keyboard', 'audit_screen_reader'] });
    expect(noAudits).toContain('Use `browser_navigate` to load a page first. Regular browser interaction tools');
    expect(noAudits).not.toContain('Results are returned as markdown');
  });

  it('collapses to the introduction when every advertised tool is blocked', () => {
    const blockedTools = [...advertised(serverInstructions({})), 'browser_click', 'browser_type', 'browser_snapshot', 'browser_take_screenshot', 'browser_tabs'];
    expect(serverInstructions({ blockedTools })).toBe(intro);
  });

  it('is what createConnection publishes at initialization', async () => {
    const server = await createConnection({ blockedTools: ['browser_navigate', 'audit_site', 'browser_session_open'] });
    const client = new Client({ name: 'instructions-test', version: '1' });
    client.setRequestHandler('ping', () => ({}));
    try {
      await client.connect(new InProcessTransport(server));
      const text = client.getInstructions()!;
      expect(text).toBe(serverInstructions({ blockedTools: ['browser_navigate', 'audit_site', 'browser_session_open'] }));
      for (const name of ['browser_navigate', 'audit_site', 'browser_session_open'])
        expect(text).not.toContain(name);
      expect(text).toContain('`scan_page_matrix`');
    } finally {
      await client.close();
    }
  });
});

for (const mode of ['browser', 'extension', 'direct proxy', 'VS Code proxy'] as const) {
  describe(`${mode} policy at the MCP boundary`, () => {
    it('hides blocked tools and rejects calls with or without a prior tools/list', async () => {
      const config = await resolveConfig({ blockedTools: ['browser_navigate', 'browser_session_open', 'browser_connect', pageTool] });
      const dispatch = vi.fn(async () => ({ content: [] }));
      const connect = async () => wrapInProcess({
        listTools: async () => [...config.blockedTools!, 'browser_snapshot'].map(name => ({ name, inputSchema: { type: 'object' as const } })),
        callTool: dispatch,
      });
      const backend = mode === 'direct proxy'
        ? new ProxyBackend([{ name: 'default', description: 'Default', connect }, { name: 'extension', description: 'Extension', connect }], undefined, config)
        : mode === 'VS Code proxy' ? new VSCodeProxyBackend(config, connect)
          : new BrowserServerBackend(config, { ...unusedFactory, ...(mode === 'extension' ? { sharedContext: true, attachNeedsUser: true, sessionsUnsupportedReason: 'extension' } : {}) });
      const client = new Client({ name: 'tool-policy-test', version: '1' });
      client.setRequestHandler('ping', () => ({}));
      try {
        await client.connect(await wrapInProcess(backend));
        for (const listFirst of [false, true]) {
          if (listFirst) {
            const listed = names((await client.listTools()).tools);
            expect(listed).toContain('browser_snapshot');
            for (const name of config.blockedTools!)
              expect(listed).not.toContain(name);
          }
          for (const name of config.blockedTools!) {
            const call = { name, arguments: { browserSessionId: 'unknown' }, _meta: { browserSessionId: 'unknown' } };
            await expect(client.callTool(call)).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
          }
        }
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await client.close();
      }
    });
  });
}

for (const kind of ['direct', 'VS Code']) {
  it(`${kind} proxy keeps filtering provider changes and dynamic list notifications`, async () => {
    const config = await resolveConfig({ blockedTools: [pageTool, 'browser_navigate'] });
    let context: ServerBackendContext;
    let catalog = [pageTool, 'browser_navigate', 'browser_snapshot'];
    const connect = async () => wrapInProcess({
      initialize: async value => { context = value; },
      listTools: async () => catalog.map(name => ({ name, inputSchema: { type: 'object' as const } })),
      callTool: async () => ({ content: [] }),
    });
    const backend = kind === 'direct'
      ? new ProxyBackend([{ name: 'default', description: 'Default', connect }, { name: 'extension', description: 'Extension', connect }], undefined, config)
      : new VSCodeProxyBackend(config, connect);
    const client = new Client({ name: 'policy-list-change-test', version: '1' });
    client.setRequestHandler('ping', () => ({}));
    try {
      await client.connect(await wrapInProcess(backend));
      expect(names((await client.listTools()).tools)).toEqual(['browser_snapshot', 'browser_connect']);
      const changed = Promise.withResolvers<void>();
      client.setNotificationHandler('notifications/tools/list_changed', () => changed.resolve());
      catalog = [pageTool, 'browser_navigate', 'browser_tabs'];
      await context!.notifyToolListChanged();
      await changed.promise;
      expect(names((await client.listTools()).tools)).toEqual(['browser_tabs', 'browser_connect']);
      const result = await client.callTool({ name: 'browser_connect', arguments: kind === 'direct' ? { name: 'extension' } : {} });
      expect(result.isError).not.toBe(true);
      expect(names((await client.listTools()).tools)).toEqual(['browser_tabs', 'browser_connect']);
      await expect(client.callTool({ name: pageTool, arguments: {} })).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
    } finally {
      await client.close();
    }
  });
}
