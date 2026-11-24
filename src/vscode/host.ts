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

import path from 'node:path';
import { z } from 'zod';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import * as mcpServer from '../mcp/server.js';
import { ToolRelay } from '../mcp/toolRelay.js';
import { SharedClientSlot } from '../mcp/sharedClientSlot.js';
import { assertToolNotBlocked, isToolBlocked } from '../mcp/toolPolicy.js';
import { logUnhandledError } from '../utils/log.js';
import { errorMessage } from '../utils/errors.js';
import { packageJSON } from '../utils/package.js';

import { resolveOutputDir } from '../config.js';
import type { FullConfig } from '../config.js';
import { BrowserServerBackend } from '../browserServerBackend.js';
import { BrowserSessionRegistry } from '../browserSessions.js';
import { assertStorageStateDoesNotResetUserProfile, contextFactory } from '../browserContextFactory.js';
import { vscodeProfileConflictRemedy } from './browserContextFactory.js';
import { assertNetworkPolicySupported } from '../networkPolicy.js';
import { validateBrowserConnectConnectionString, validateBrowserConnectLib } from './validation.js';
import type { Transport } from '@modelcontextprotocol/client';
import type { ClientVersion, ServerBackend, ServerBackendContext, Tool, CallToolResult, CallToolRequest } from '../mcp/server.js';

const contextSwitchOptions = z.object({
  connectionString: z.string().optional().describe('The connection string to use to connect to the browser'),
  lib: z.string().optional().describe('The library to use for the connection'),
});

/** @public */
export class VSCodeProxyBackend implements ServerBackend {
  readonly dynamicToolList = true;

  private _currentClient: Client | undefined;
  private _ownsCurrentClient = true;
  private _currentClientIsDefault = false;
  private _sessionClient: Promise<Client> | undefined;
  private _contextSwitchTool: Tool;
  private _clientVersion?: ClientVersion;
  private _backendContext: ServerBackendContext | undefined;
  private _listedClient: Client | undefined;
  private _providerGeneration = 0;
  private _ownedSlot = new SharedClientSlot();
  private _transition: Promise<unknown> = Promise.resolve();
  private _closed = false;
  private _relay = new ToolRelay(client => {
    if (!this._sharedSlot && this._listedClient === client)
      return this._backendContext?.notifyToolListChanged();
  }, logUnhandledError);

  constructor(private readonly _config: FullConfig, private readonly _defaultTransportFactory: () => Promise<Transport>, private readonly _sharedSlot?: SharedClientSlot) {
    this._contextSwitchTool = this._defineContextSwitchTool();
  }

  async initialize(context: ServerBackendContext, clientVersion: ClientVersion): Promise<void> {
    this._backendContext = context;
    this._clientVersion = clientVersion;
    const shared = this._sharedSlot?.acquire();
    if (shared) {
      this._currentClient = shared;
      this._ownsCurrentClient = false;
      this._currentClientIsDefault = false;
      return;
    }
    await this._setCurrentClient(() => this._connectDefaultClient(), false, true);
  }

  async listTools(requestContext?: Partial<Pick<mcpServer.CallToolRequestContext, 'signal' | '_meta'>>): Promise<Tool[]> {
    const providerClient = this._currentClient;
    const generation = this._providerGeneration;
    const tools = await this._withToolClient('webmcp_', undefined, requestContext, async client => {
      const tools = await this._relay.listTools(client, requestContext);
      const currentProvider = generation === this._providerGeneration && client === this._currentClient;
      const activeHostSession = client !== providerClient && !this._currentClientIsDefault;
      if (currentProvider || activeHostSession)
        this._listedClient = client;
      return tools;
    });
    return [...tools, this._contextSwitchTool].filter(tool => !isToolBlocked(this._config, tool.name));
  }

  async callTool(name: string, args: CallToolRequest['params']['arguments'], requestContext?: mcpServer.CallToolRequestContext): Promise<CallToolResult> {
    assertToolNotBlocked(this._config, name);
    if (name === this._contextSwitchTool.name) {
      const parsed = contextSwitchOptions.safeParse(args ?? {});
      if (!parsed.success)
        throw new Error(`Invalid input for tool "${name}":\n${z.prettifyError(parsed.error)}`);
      // Parsing strips unknown keys; keep them so a request carrying only
      // unknown fields is not mistaken for an empty (disconnect) request.
      const unknownFields = Object.keys(args ?? {}).filter(key => !Object.hasOwn(contextSwitchOptions.shape, key));
      return this._callContextSwitchTool(parsed.data, unknownFields);
    }
    return await this._withToolClient(name, args, requestContext, client => this._relay.callTool(client, name, args, requestContext));
  }

  // Runs `use` against the client that serves `name`. A provider client is
  // leased for the duration, so a switch that publishes a replacement while
  // the request is still awaiting it closes it only once `use` settles. The
  // lease is taken in the same tick that reads the current provider.
  private async _withToolClient<T>(name: string, args: CallToolRequest['params']['arguments'], requestContext: Pick<mcpServer.CallToolRequestContext, '_meta'> | undefined, use: (client: Client) => Promise<T>): Promise<T> {
    const sessionTraffic = name.startsWith('webmcp_')
      ? requestContext?._meta?.browserSessionId !== undefined
      : name === 'browser_session_open' || name === 'browser_session_close' || typeof args?.browserSessionId === 'string';
    if (!sessionTraffic || this._currentClientIsDefault) {
      const client = this._currentClient;
      if (!client)
        throw new Error('Initialize the VS Code backend before running tools.');
      const slot = this._ownsCurrentClient ? this._ownedSlot : this._sharedSlot;
      return await (slot ? slot.withLease(client, () => use(client)) : use(client));
    }
    return await use(await this._sessionClientForTool());
  }

  private async _sessionClientForTool(): Promise<Client> {
    if (!this._sessionClient) {
      const creation = this._connectDefaultClient();
      creation.catch(() => {
        if (this._sessionClient === creation)
          this._sessionClient = undefined;
      });
      this._sessionClient = creation;
    }
    return await this._sessionClient;
  }

  serverClosed?(): void {
    if (this._closed)
      return;
    this._closed = true;
    this._relay.close();
    this._backendContext = undefined;
    this._listedClient = undefined;
    void this._ownedSlot.dispose().catch(logUnhandledError);
    // The shared lease is released once, after any in-progress switch
    // settles: that switch may still release the client it replaces, or move
    // this backend onto the client it publishes.
    const released = this._transition.then(async () => {
      if (!this._ownsCurrentClient && this._currentClient)
        await this._sharedSlot?.release(this._currentClient);
    });
    this._transition = released.catch(() => {});
    void released.catch(logUnhandledError);
    void this._sessionClient?.then(client => client.close()).catch(logUnhandledError);
  }

  private async _callContextSwitchTool(params: z.infer<typeof contextSwitchOptions>, unknownFields: string[]): Promise<CallToolResult> {
    // Only an empty request disconnects. A request naming either field is a
    // switch and needs both as non-blank strings; anything partial, or any
    // other field in place of both, is an error that keeps the current
    // provider.
    if (params.connectionString === undefined && params.lib === undefined) {
      if (unknownFields.length) {
        return {
          content: [{ type: 'text', text: `### Result\nInvalid input: unknown field(s) ${unknownFields.map(field => `\`${field}\``).join(', ')}. Pass both \`connectionString\` and \`lib\` to switch providers, or omit all fields to disconnect.\n` }],
          isError: true,
        };
      }
      if (this._sharedSlot)
        await this._switchSharedClient(this._sharedSlot, undefined);
      else
        await this._setCurrentClient(() => this._connectDefaultClient(), true, true);
      return {
        content: [{ type: 'text', text: '### Result\nSuccessfully disconnected.\n' }],
      };
    }
    if (!params.connectionString?.trim() || !params.lib?.trim()) {
      return {
        content: [{ type: 'text', text: '### Result\nInvalid input: switching providers needs both `connectionString` and `lib` as non-blank strings. Omit both to disconnect.\n' }],
        isError: true,
      };
    }

    const libError = validateBrowserConnectLib(params.lib);
    if (libError) {
      return {
        content: [{ type: 'text', text: `### Result\n${libError}\n` }],
        isError: true,
      };
    }
    const connectionError = validateBrowserConnectConnectionString(params.connectionString);
    if (connectionError) {
      return {
        content: [{ type: 'text', text: `### Result\n${connectionError}\n` }],
        isError: true,
      };
    }

    try {
      assertNetworkPolicySupported(this._config, false);
      assertStorageStateDoesNotResetUserProfile(this._config, vscodeProfileConflictRemedy);
    } catch (error) {
      return {
        content: [{ type: 'text', text: `### Result\n${errorMessage(error)}\n` }],
        isError: true,
      };
    }

    const { connectionString, lib } = params;
    if (this._sharedSlot)
      await this._switchSharedClient(this._sharedSlot, () => this._createSwitchTransport(connectionString, lib));
    else
      await this._setCurrentClient(async () => this._connectClient(await this._createSwitchTransport(connectionString, lib)), true, false);
    return {
      content: [{ type: 'text', text: '### Result\nSuccessfully connected.\n' }],
    };
  }

  private async _createSwitchTransport(connectionString: string, lib: string): Promise<Transport> {
    return new StdioClientTransport({
      command: process.execPath,
      cwd: process.cwd(),
      env: { PLAYWRIGHT_MCP_VSCODE_ALLOW_REMOTE: process.env.PLAYWRIGHT_MCP_VSCODE_ALLOW_REMOTE ?? '' },
      args: [
        path.join(import.meta.dirname, 'main.js'),
        JSON.stringify({ ...this._config, server: { ...this._config.server, authToken: undefined }, outputDir: resolveOutputDir(this._config) }),
        connectionString,
        lib,
      ],
    });
  }

  // A shared switch spans two slots: the process-wide one and this backend's
  // owned one. The whole transition (shared publication, owned clear, owned
  // publication) runs as one step, one switch at a time, so an owned
  // replacement still connecting for an earlier switch cannot publish after a
  // later shared publication and then be closed by its clear.
  private async _switchSharedClient(sharedSlot: SharedClientSlot, createTransport: (() => Promise<Transport>) | undefined): Promise<void> {
    const result = this._transition.then(() => this._applySharedSwitch(sharedSlot, createTransport));
    this._transition = result.catch(() => {});
    await result;
  }

  private async _applySharedSwitch(sharedSlot: SharedClientSlot, createTransport: (() => Promise<Transport>) | undefined): Promise<void> {
    this._assertOpen();
    const previousShared = this._ownsCurrentClient ? undefined : this._currentClient;
    // A disconnect readies this backend's default provider, handshake
    // included, as the process-wide step that clears the shared selection: a
    // default that fails to start fails the switch and leaves every request,
    // existing or new, on the shared provider, and a later switch from another
    // request waits for this one instead of being cleared by it. A request
    // closed meanwhile connects no default.
    const defaultClient = createTransport ? undefined : await sharedSlot.clearAfter(this._whileOpen(async () => {
      const defaultTransport = await this._defaultTransportFactory();
      return this._closed ? undefined : await this._connectClient(defaultTransport);
    }));
    const shared = createTransport ? await sharedSlot.replace(this._whileOpen(async () => this._connectClient(await createTransport()))) : undefined;
    if (this._closed) {
      // serverClosed() ran while the replacement connected: the switch still
      // applies process-wide, but this backend keeps no lease on its
      // replacement and publishes nothing into its disposed owned slot. Its
      // lease on `previousShared`, still the current client, is released by
      // serverClosed() once this settles.
      await defaultClient?.close().catch(logUnhandledError);
      if (shared)
        await sharedSlot.release(shared);
      return;
    }
    if (defaultClient) {
      // The owned slot refuses a client it never took if it was disposed in
      // the meantime; close it here then.
      await this._setCurrentClient(async () => defaultClient, false, true).catch(async error => {
        await defaultClient.close().catch(logUnhandledError);
        throw error;
      });
    } else if (shared) {
      this._currentClient = shared;
      this._ownsCurrentClient = false;
      this._currentClientIsDefault = false;
      await this._ownedSlot.replace(undefined);
    }
    if (previousShared)
      await sharedSlot.release(previousShared);
  }

  private _assertOpen(): void {
    if (this._closed)
      throw new Error('The connection closed before the switch could run.');
  }

  // Wraps a process-wide slot step's connect: the step can wait in the
  // slot's queue behind other requests' switches, so a request closed by the
  // time it starts creates no transport and the step fails, leaving the
  // shared selection as it is. A connect already under way when the request
  // closes carries on.
  private _whileOpen<T>(connect: () => Promise<T>): () => Promise<T> {
    return async () => {
      this._assertOpen();
      return await connect();
    };
  }

  private _defineContextSwitchTool(): Tool {
    return {
      name: 'browser_connect',
      description: 'Do not call, this tool is used in the integration with the Playwright VS Code Extension and meant for programmatic usage only.',
      inputSchema: z.toJSONSchema(contextSwitchOptions) as Tool['inputSchema'],
      annotations: {
        title: 'Connect to a browser running in VS Code.',
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    };
  }

  // The replacement is connected before it is published, and the client it
  // replaces is closed only afterwards: a failed handshake keeps the working
  // provider, and overlapping switches apply in call order. The transport is
  // created inside `connect`, in turn: once serverClosed() has disposed the
  // owned slot, a replacement still queued is neither created nor published,
  // and one that finishes connecting afterwards is closed.
  private async _setCurrentClient(connect: () => Promise<Client>, notifyOnChange: boolean, isDefault = false) {
    await this._ownedSlot.replace(connect, {
      lease: false,
      publish: client => {
        ++this._providerGeneration;
        if (isDefault || this._listedClient === this._currentClient)
          this._listedClient = undefined;
        this._currentClient = client;
        this._ownsCurrentClient = true;
        this._currentClientIsDefault = isDefault;
      },
    });
    if (notifyOnChange)
      await this._backendContext?.notifyToolListChanged();
  }

  private async _connectDefaultClient(): Promise<Client> {
    return await this._connectClient(await this._defaultTransportFactory());
  }

  private async _connectClient(transport: Transport): Promise<Client> {
    if (!this._clientVersion)
      throw new Error('Initialize the VS Code backend before connecting a client.');
    const client = new Client(this._clientVersion);
    client.setRequestHandler('ping', () => ({}));
    this._relay.observe(client);

    await client.connect(transport);
    return client;
  }
}

export async function runVSCodeTools(config: FullConfig, registerExitCleanup?: (cleanup: () => Promise<void>) => void) {
  const browserContextFactory = contextFactory(config);
  const sessionRegistry = new BrowserSessionRegistry();
  const sharedSlot = new SharedClientSlot();
  registerExitCleanup?.(async () => {
    await sharedSlot.dispose();
  });
  const createBackend = (ephemeralDefaultContext: boolean, slot?: SharedClientSlot) =>
    new VSCodeProxyBackend(config, () => mcpServer.wrapInProcess(new BrowserServerBackend(config, browserContextFactory, sessionRegistry, { ephemeralDefaultContext })), slot);
  const serverBackendFactory: mcpServer.ServerBackendFactory = {
    name: 'Playwright w/ vscode',
    nameInConfig: 'playwright-vscode',
    version: packageJSON.version,
    redactUrlParams: config.redactUrlParams,
    create: () => createBackend(false),
    createStateless: () => createBackend(true, sharedSlot),
  };
  await mcpServer.start(serverBackendFactory, config.server);
}
