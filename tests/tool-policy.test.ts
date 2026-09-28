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
import { ProxyBackend } from '../src/mcp/proxyBackend.js';
import { wrapInProcess } from '../src/mcp/server.js';
import type { ServerBackendContext } from '../src/mcp/server.js';
import { allTools, filteredTools } from '../src/tools.js';
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
