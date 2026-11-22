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

import { Client } from '@modelcontextprotocol/client';

import { ToolRelay } from './toolRelay.js';
import { assertToolNotBlocked, isToolBlocked } from './toolPolicy.js';
import { logUnhandledError } from '../utils/log.js';
import type { ToolPolicy } from './toolPolicy.js';
import type { CallToolRequestContext, ServerBackend, ClientVersion, ServerBackendContext, Tool, CallToolResult, CallToolRequest } from './server.js';
import { SharedClientSlot } from './sharedClientSlot.js';
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

export class ProxyBackend implements ServerBackend {
  readonly dynamicToolList = true;
  private _mcpProviders: MCPProvider[];
  private _currentClient: Client | undefined;
  private _ownsCurrentClient = true;
  private _contextSwitchTool: Tool;
  private _backendContext: ServerBackendContext | undefined;
  private _sharedSelection: SharedProxySelection | undefined;
  private _ownedSlot = new SharedClientSlot();
  private _relay = new ToolRelay(client => {
    if (this._ownsCurrentClient && this._currentClient === client)
      return this._backendContext?.notifyToolListChanged();
  }, logUnhandledError);

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
    const downstreamTools = await this._relay.listTools(this._client(), requestContext);
    const tools = this._mcpProviders.length === 1 ? downstreamTools : [...downstreamTools, this._contextSwitchTool];
    return tools.filter(tool => !isToolBlocked(this._toolPolicy, tool.name));
  }

  async callTool(name: string, args: CallToolRequest['params']['arguments'], requestContext?: CallToolRequestContext): Promise<CallToolResult> {
    assertToolNotBlocked(this._toolPolicy, name);
    if (name === this._contextSwitchTool.name)
      return this._callContextSwitchTool(args);
    return await this._relay.callTool(this._client(), name, args, requestContext);
  }

  private _client(): Client {
    if (!this._currentClient)
      throw new Error('Initialize the proxy backend before running tools.');
    return this._currentClient;
  }

  serverClosed?(): void {
    this._relay.close();
    this._backendContext = undefined;
    void this._ownedSlot.dispose().catch(logUnhandledError);
    if (!this._ownsCurrentClient && this._currentClient)
      void this._sharedSelection?.slot.release(this._currentClient);
  }

  private async _callContextSwitchTool(params: CallToolRequest['params']['arguments']): Promise<CallToolResult> {
    try {
      const factory = this._mcpProviders.find(factory => factory.name === params?.name);
      if (!factory)
        throw new Error('Unknown connection method: ' + params?.name);

      factory.validate?.();
      if (this._sharedSelection)
        await this._switchSharedClient(this._sharedSelection, factory.name);
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

  private async _switchSharedClient({ slot, providers }: SharedProxySelection, name: string): Promise<void> {
    const provider = providers.find(factory => factory.name === name);
    if (!provider)
      throw new Error('Unknown connection method: ' + name);
    const previousShared = this._ownsCurrentClient ? undefined : this._currentClient;
    const shared = await slot.replace(provider === providers[0] ? undefined : () => this._connectClient(provider));
    if (shared) {
      this._currentClient = shared;
      this._ownsCurrentClient = false;
      await this._ownedSlot.replace(undefined);
    } else {
      await this._setCurrentClient(this._mcpProviders[0], false);
    }
    if (previousShared)
      await slot.release(previousShared);
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

  // The replacement is connected before it is published, and the client it
  // replaces is closed only afterwards: a failed handshake keeps the working
  // client, and overlapping switches apply in call order.
  private async _setCurrentClient(factory: MCPProvider, notifyOnChange: boolean) {
    await this._ownedSlot.replace(() => this._connectClient(factory), {
      lease: false,
      publish: client => {
        this._currentClient = client;
        this._ownsCurrentClient = true;
      },
    });
    if (notifyOnChange)
      await this._backendContext?.notifyToolListChanged().catch(logUnhandledError);
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
