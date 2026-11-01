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

import debug from 'debug';
import { z } from 'zod';

import { Client } from '@modelcontextprotocol/client';

import { ToolRelay } from './toolRelay.js';
import { assertToolNotBlocked, isToolBlocked } from './toolPolicy.js';
import type { ToolPolicy } from './toolPolicy.js';
import type { CallToolRequestContext, ServerBackend, ClientVersion, ServerBackendContext, Tool, CallToolResult, CallToolRequest } from './server.js';
import type { SharedClientSlot } from './sharedClientSlot.js';
import type { Transport } from '@modelcontextprotocol/client';

export type MCPProvider = {
  name: string;
  description: string;
  validate?(): void;
  connect(): Promise<Transport>;
};

export type SharedProxySelection = {
  slot: SharedClientSlot;
  providers: MCPProvider[];
};

const errorsDebug = debug('pw:mcp:errors');

export class ProxyBackend implements ServerBackend {
  readonly dynamicToolList = true;
  private _mcpProviders: MCPProvider[];
  private _currentClient: Client | undefined;
  private _ownsCurrentClient = true;
  private _contextSwitchTool: Tool;
  private _backendContext: ServerBackendContext | undefined;
  private _sharedSelection: SharedProxySelection | undefined;
  private _relay = new ToolRelay(client => {
    if (this._ownsCurrentClient && this._currentClient === client)
      return this._backendContext?.notifyToolListChanged();
  }, errorsDebug);

  constructor(mcpProviders: MCPProvider[], sharedSelection?: SharedProxySelection, private readonly _toolPolicy: ToolPolicy = {}) {
    this._mcpProviders = mcpProviders;
    this._sharedSelection = sharedSelection;
    this._contextSwitchTool = this._defineContextSwitchTool();
  }

  async initialize(context: ServerBackendContext, _clientVersion: ClientVersion): Promise<void> {
    this._backendContext = context;
    const shared = this._sharedSelection?.slot.acquire();
    if (shared) {
      this._currentClient = shared;
      this._ownsCurrentClient = false;
      return;
    }
    await this._setCurrentClient(this._mcpProviders[0], false);
  }

  async listTools(requestContext?: Partial<Pick<CallToolRequestContext, 'signal' | '_meta'>>): Promise<Tool[]> {
    const client = this._currentClient!;
    const downstreamTools = await this._relay.listTools(client, requestContext);
    const tools = this._mcpProviders.length === 1 ? downstreamTools : [...downstreamTools, this._contextSwitchTool];
    return tools.filter(tool => !isToolBlocked(this._toolPolicy, tool.name));
  }

  async callTool(name: string, args: CallToolRequest['params']['arguments'], requestContext?: CallToolRequestContext): Promise<CallToolResult> {
    assertToolNotBlocked(this._toolPolicy, name);
    if (name === this._contextSwitchTool.name)
      return this._callContextSwitchTool(args);
    return await this._relay.callTool(this._currentClient!, name, args, requestContext);
  }

  serverClosed?(): void {
    this._relay.close();
    this._backendContext = undefined;
    if (this._ownsCurrentClient)
      void this._currentClient?.close().catch(errorsDebug);
    else if (this._currentClient)
      void this._sharedSelection?.slot.release(this._currentClient);
  }

  private async _callContextSwitchTool(params: any): Promise<CallToolResult> {
    try {
      const factory = this._mcpProviders.find(factory => factory.name === params.name);
      if (!factory)
        throw new Error('Unknown connection method: ' + params.name);

      factory.validate?.();
      if (this._sharedSelection)
        await this._switchSharedClient(factory.name);
      else
        await this._setCurrentClient(factory, true);
      return {
        content: [{ type: 'text', text: '### Result\nSuccessfully changed connection method.\n' }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `### Result\nError: ${error}\n` }],
        isError: true,
      };
    }
  }

  private async _switchSharedClient(name: string): Promise<void> {
    const { slot, providers } = this._sharedSelection!;
    const provider = providers.find(factory => factory.name === name);
    if (!provider)
      throw new Error('Unknown connection method: ' + name);
    const previousOwned = this._ownsCurrentClient ? this._currentClient : undefined;
    const previousShared = this._ownsCurrentClient ? undefined : this._currentClient;
    const shared = await slot.replace(provider === providers[0] ? undefined : () => this._connectClient(provider));
    if (shared) {
      this._currentClient = shared;
      this._ownsCurrentClient = false;
    } else {
      this._currentClient = await this._connectClient(this._mcpProviders[0]);
      this._ownsCurrentClient = true;
    }
    if (previousShared)
      await slot.release(previousShared);
    await previousOwned?.close().catch(errorsDebug);
  }

  private _defineContextSwitchTool(): Tool {
    return {
      name: 'browser_connect',
      description: [
        'Connect to a browser using one of the available methods:',
        ...this._mcpProviders.map(factory => `- "${factory.name}": ${factory.description}`),
      ].join('\n'),
      inputSchema: z.toJSONSchema(z.object({
        name: z.enum(this._mcpProviders.map(factory => factory.name) as [string, ...string[]]).default(this._mcpProviders[0].name).describe('The method to use to connect to the browser'),
      })) as Tool['inputSchema'],
      annotations: {
        title: 'Connect to a browser context',
        readOnlyHint: true,
        openWorldHint: false,
      },
    };
  }

  private async _setCurrentClient(factory: MCPProvider, notifyOnChange: boolean) {
    await this._currentClient?.close();
    this._currentClient = undefined;

    const client = await this._connectClient(factory);
    this._currentClient = client;
    this._ownsCurrentClient = true;
    if (notifyOnChange)
      await this._backendContext?.notifyToolListChanged().catch(errorsDebug);
  }

  private async _connectClient(factory: MCPProvider): Promise<Client> {
    const client = new Client({ name: 'Playwright MCP Proxy', version: '0.0.0' });
    client.setRequestHandler('ping', () => ({}));
    this._relay.observe(client);

    const transport = await factory.connect();
    await client.connect(transport);
    return client;
  }
}
