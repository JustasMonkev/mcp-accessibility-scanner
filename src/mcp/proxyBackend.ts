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
import { notifyToolListChanged } from './toolListChanged.js';

import type { CallToolRequestContext, ServerBackend, ClientVersion, ServerBackendContext, Tool, CallToolResult, CallToolRequest } from './server.js';
import type { SharedClientSlot } from './sharedClientSlot.js';
import type { Transport } from '@modelcontextprotocol/client';

export type MCPProvider = {
  name: string;
  description: string;
  /**
   * Throws when this provider cannot serve the current configuration (e.g. a
   * storage state the extension provider would silently drop). Runs before the
   * current client is torn down, so a rejected switch leaves the session on
   * its previous provider instead of stranding it with none.
   */
  validate?(): void;
  connect(): Promise<Transport>;
};

/**
 * Wiring for stateless (per-request) proxy backends: the slot carries a
 * `browser_connect` switch across handshake-free requests, and `providers`
 * is the stateful-flavored provider list used to connect the shared client —
 * a process-scoped client outlives any single response, so it must not run
 * its default context in the throwaway per-request (ephemeral) shape. The
 * list must mirror the per-request providers name-for-name.
 */
export type SharedProxySelection = {
  slot: SharedClientSlot;
  providers: MCPProvider[];
};

const errorsDebug = debug('pw:mcp:errors');

export class ProxyBackend implements ServerBackend {
  private _mcpProviders: MCPProvider[];
  private _currentClient: Client | undefined;
  // False when _currentClient is adopted from the shared slot: response
  // cleanup (serverClosed) must not tear down a process-scoped client that
  // later requests still route through.
  private _ownsCurrentClient = true;
  private _contextSwitchTool: Tool;
  private _backendContext: ServerBackendContext | undefined;
  private _sharedSelection: SharedProxySelection | undefined;

  constructor(mcpProviders: MCPProvider[], sharedSelection?: SharedProxySelection) {
    this._mcpProviders = mcpProviders;
    this._sharedSelection = sharedSelection;
    this._contextSwitchTool = this._defineContextSwitchTool();
  }

  async initialize(context: ServerBackendContext, _clientVersion: ClientVersion): Promise<void> {
    this._backendContext = context;
    // A process-scoped browser_connect switch is in effect: adopt it instead
    // of connecting the default provider, so the selection made in an earlier
    // handshake-free request keeps governing this one. The adoption holds a
    // lease on the shared client (released in serverClosed, or earlier when
    // this request switches away), so a concurrent switch cannot close it
    // under this request's in-flight calls.
    const shared = this._sharedSelection?.slot.acquire();
    if (shared) {
      this._currentClient = shared;
      this._ownsCurrentClient = false;
      return;
    }
    await this._setCurrentClient(this._mcpProviders[0], false);
  }

  async listTools(): Promise<Tool[]> {
    const response = await this._currentClient!.listTools();
    if (this._mcpProviders.length === 1)
      return response.tools;
    return [
      ...response.tools,
      this._contextSwitchTool,
    ];
  }

  async callTool(name: string, args: CallToolRequest['params']['arguments'], requestContext?: CallToolRequestContext): Promise<CallToolResult> {
    if (name === this._contextSwitchTool.name)
      return this._callContextSwitchTool(args);
    const progressToken = requestContext?._meta?.progressToken;
    return await this._currentClient!.callTool({
      name,
      arguments: args,
      _meta: requestContext?._meta,
    }, progressToken === undefined ? undefined : {
      onprogress: params => {
        void this._forwardProgressNotification(requestContext, progressToken, params);
      },
    });
  }

  serverClosed?(): void {
    if (this._ownsCurrentClient)
      void this._currentClient?.close().catch(errorsDebug);
    else if (this._currentClient)
      // Adopted from the shared slot: release the lease instead of closing —
      // the slot closes the client once it is retired and fully drained.
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

  // Stateless serving: publish the switch through the process-scoped slot so
  // later per-request backends adopt it. The slot closes the previously
  // shared client itself (exactly once, after the swap, once every adopting
  // request has released it); only a client this request owned — its
  // per-request default — is closed here.
  private async _switchSharedClient(name: string): Promise<void> {
    const { slot, providers } = this._sharedSelection!;
    // The stateful-flavored list mirrors this._mcpProviders name-for-name;
    // the name was already resolved and validated against the latter.
    const provider = providers.find(factory => factory.name === name);
    if (!provider)
      throw new Error('Unknown connection method: ' + name);
    const previousTools = await this._getExposedTools(this._currentClient).catch(() => undefined);
    const previousOwned = this._ownsCurrentClient ? this._currentClient : undefined;
    const previousShared = this._ownsCurrentClient ? undefined : this._currentClient;
    const shared = await slot.replace(provider === providers[0] ? undefined : () => this._connectClient(provider));
    if (shared) {
      this._currentClient = shared;
      this._ownsCurrentClient = false;
    } else {
      // Back to the default provider, which stateless serving runs
      // per-request: finish this exchange on an owned per-request client.
      this._currentClient = await this._connectClient(this._mcpProviders[0]);
      this._ownsCurrentClient = true;
    }
    // This request no longer routes through the shared client it adopted;
    // when it was the retiring client's last adopter, this runs the close
    // the replace deferred. Only on success — a failed replace threw above,
    // and the request keeps using its adopted client.
    if (previousShared)
      await slot.release(previousShared);
    await previousOwned?.close().catch(errorsDebug);
    await notifyToolListChanged(this._backendContext, previousTools, await this._getExposedTools(this._currentClient));
  }

  private async _forwardProgressNotification(
    requestContext: CallToolRequestContext | undefined,
    progressToken: string | number,
    params: { progress: number; total?: number; message?: string },
  ): Promise<void> {
    try {
      await requestContext?.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          ...params,
        },
      });
    } catch (error) {
      errorsDebug('Failed to forward downstream progress notification: %o', error);
    }
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
    const previousTools = notifyOnChange ? await this._getExposedTools(this._currentClient).catch(() => undefined) : undefined;
    await this._currentClient?.close();
    this._currentClient = undefined;

    const client = await this._connectClient(factory);
    this._currentClient = client;
    this._ownsCurrentClient = true;
    await notifyToolListChanged(this._backendContext, previousTools, await this._getExposedTools(client));
  }

  private async _connectClient(factory: MCPProvider): Promise<Client> {
    const client = new Client({ name: 'Playwright MCP Proxy', version: '0.0.0' });
    client.setRequestHandler('ping', () => ({}));

    const transport = await factory.connect();
    await client.connect(transport);
    return client;
  }

  private async _getExposedTools(client: Client | undefined): Promise<Tool[]> {
    if (!client)
      return [];

    const { tools } = await client.listTools();
    const toolDescriptors = [...tools];
    if (this._mcpProviders.length > 1)
      toolDescriptors.push(this._contextSwitchTool);
    return toolDescriptors;
  }
}
