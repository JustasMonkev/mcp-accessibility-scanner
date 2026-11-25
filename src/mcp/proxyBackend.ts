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
  private _transition: Promise<unknown> = Promise.resolve();
  private _closed = false;
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
    await this._setCurrentClient(() => this._connectClient(this._mcpProviders[0]), false);
  }

  async listTools(requestContext?: Partial<Pick<CallToolRequestContext, 'signal' | '_meta'>>): Promise<Tool[]> {
    const client = this._client();
    const downstreamTools = await this._withLease(client, () => this._relay.listTools(client, requestContext));
    const tools = this._mcpProviders.length === 1 ? downstreamTools : [...downstreamTools, this._contextSwitchTool];
    return tools.filter(tool => !isToolBlocked(this._toolPolicy, tool.name));
  }

  async callTool(name: string, args: CallToolRequest['params']['arguments'], requestContext?: CallToolRequestContext): Promise<CallToolResult> {
    assertToolNotBlocked(this._toolPolicy, name);
    if (name === this._contextSwitchTool.name)
      return this._callContextSwitchTool(args);
    const client = this._client();
    return await this._withLease(client, () => this._relay.callTool(client, name, args, requestContext));
  }

  private _client(): Client {
    if (!this._currentClient)
      throw new Error('Initialize the proxy backend before running tools.');
    return this._currentClient;
  }

  // A switch can publish a replacement while a forwarded request is still
  // awaiting `client`; the lease keeps it open until that request settles.
  // Call in the same tick that read `client` from `_currentClient`.
  private _withLease<T>(client: Client, use: () => Promise<T>): Promise<T> {
    const slot = this._ownsCurrentClient ? this._ownedSlot : this._sharedSelection?.slot;
    return slot ? slot.withLease(client, use) : use();
  }

  serverClosed?(): void {
    if (this._closed)
      return;
    this._closed = true;
    this._relay.close();
    this._backendContext = undefined;
    void this._ownedSlot.dispose().catch(logUnhandledError);
    // The shared lease is released once, after any in-progress switch
    // settles: that switch may still release the client it replaces, or move
    // this backend onto the client it publishes.
    const released = this._transition.then(async () => {
      if (!this._ownsCurrentClient && this._currentClient)
        await this._sharedSelection?.slot.release(this._currentClient);
    });
    this._transition = released.catch(() => {});
    void released.catch(logUnhandledError);
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
        await this._setCurrentClient(() => this._connectClient(factory), true);
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

  // A shared switch spans two slots: the process-wide one and this backend's
  // owned one. The whole transition (shared publication, owned clear, owned
  // publication) runs as one step, one switch at a time, so an owned
  // replacement still connecting for an earlier switch cannot publish after a
  // later shared publication and then be closed by its clear.
  private async _switchSharedClient(selection: SharedProxySelection, name: string): Promise<void> {
    const result = this._transition.then(() => this._applySharedSwitch(selection, name));
    this._transition = result.catch(() => {});
    await result;
  }

  private async _applySharedSwitch({ slot, providers }: SharedProxySelection, name: string): Promise<void> {
    this._assertOpen();
    const provider = providers.find(factory => factory.name === name);
    if (!provider)
      throw new Error('Unknown connection method: ' + name);
    const previousShared = this._ownsCurrentClient ? undefined : this._currentClient;
    const toDefault = provider === providers[0];
    // Switching back to the default readies this backend's default client,
    // handshake included, as the process-wide step that clears the shared
    // selection: a default that fails to start fails the switch and leaves
    // every request, existing or new, on the shared provider, and a later
    // switch from another request waits for this one instead of being
    // cleared by it.
    const defaultClient = toDefault ? await slot.clearAfter(this._whileOpen(() => this._connectClient(this._mcpProviders[0]))) : undefined;
    const shared = toDefault ? undefined : await slot.replace(this._whileOpen(() => this._connectClient(provider)));
    if (this._closed) {
      // serverClosed() ran while the replacement connected: the switch still
      // applies process-wide, but this backend keeps no lease on its
      // replacement and publishes nothing into its disposed owned slot. Its
      // lease on `previousShared`, still the current client, is released by
      // serverClosed() once this settles.
      await defaultClient?.close().catch(logUnhandledError);
      if (shared)
        await slot.release(shared);
      return;
    }
    if (defaultClient) {
      // The owned slot refuses a client it never took if it was disposed in
      // the meantime; close it here then.
      await this._setCurrentClient(async () => defaultClient, false).catch(async error => {
        await defaultClient.close().catch(logUnhandledError);
        throw error;
      });
    } else if (shared) {
      this._currentClient = shared;
      this._ownsCurrentClient = false;
      await this._ownedSlot.replace(undefined);
    }
    if (previousShared)
      await slot.release(previousShared);
  }

  private _assertOpen(): void {
    if (this._closed)
      throw new Error('The connection closed before the switch could run.');
  }

  // Wraps a process-wide slot step's connect: the step can wait in the
  // slot's queue behind other requests' switches, so a request closed by the
  // time it starts connects nothing and the step fails, leaving the shared
  // selection as it is. A connect already under way when the request closes
  // carries on.
  private _whileOpen<T>(connect: () => Promise<T>): () => Promise<T> {
    return async () => {
      this._assertOpen();
      return await connect();
    };
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
  // client, and overlapping switches apply in call order. Once serverClosed()
  // has disposed the owned slot, a replacement still queued is not connected,
  // and one that finishes connecting afterwards is closed, not published.
  private async _setCurrentClient(connect: () => Promise<Client>, notifyOnChange: boolean) {
    await this._ownedSlot.replace(connect, {
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
