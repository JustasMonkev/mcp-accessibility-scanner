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
    const transport = await this._defaultTransportFactory();
    await this._setCurrentClient(transport, false, true);
  }

  async listTools(requestContext?: Partial<Pick<mcpServer.CallToolRequestContext, 'signal' | '_meta'>>): Promise<Tool[]> {
    const providerClient = this._currentClient;
    const generation = this._providerGeneration;
    const client = await this._clientForTool('webmcp_', undefined, requestContext);
    const tools = await this._relay.listTools(client, requestContext);
    const currentProvider = generation === this._providerGeneration && client === this._currentClient;
    const activeHostSession = client !== providerClient && !this._currentClientIsDefault;
    if (currentProvider || activeHostSession)
      this._listedClient = client;
    return [...tools, this._contextSwitchTool].filter(tool => !isToolBlocked(this._config, tool.name));
  }

  async callTool(name: string, args: CallToolRequest['params']['arguments'], requestContext?: mcpServer.CallToolRequestContext): Promise<CallToolResult> {
    assertToolNotBlocked(this._config, name);
    if (name === this._contextSwitchTool.name) {
      const parsed = contextSwitchOptions.safeParse(args ?? {});
      if (!parsed.success)
        throw new Error(`Invalid input for tool "${name}":\n${z.prettifyError(parsed.error)}`);
      return this._callContextSwitchTool(parsed.data, requestContext);
    }
    const client = await this._clientForTool(name, args, requestContext);
    return await this._relay.callTool(client, name, args, requestContext);
  }

  private async _clientForTool(name: string, args: CallToolRequest['params']['arguments'], requestContext?: Pick<mcpServer.CallToolRequestContext, '_meta'>): Promise<Client> {
    const sessionTraffic = name.startsWith('webmcp_')
      ? requestContext?._meta?.browserSessionId !== undefined
      : name === 'browser_session_open' || name === 'browser_session_close' || typeof args?.browserSessionId === 'string';
    if (!sessionTraffic || this._currentClientIsDefault) {
      if (!this._currentClient)
        throw new Error('Initialize the VS Code backend before running tools.');
      return this._currentClient;
    }
    if (!this._sessionClient) {
      const creation = (async () => this._connectClient(await this._defaultTransportFactory()))();
      creation.catch(() => {
        if (this._sessionClient === creation)
          this._sessionClient = undefined;
      });
      this._sessionClient = creation;
    }
    return await this._sessionClient;
  }

  serverClosed?(): void {
    this._relay.close();
    this._backendContext = undefined;
    this._listedClient = undefined;
    void this._ownedSlot.dispose().catch(logUnhandledError);
    if (!this._ownsCurrentClient && this._currentClient)
      void this._sharedSlot?.release(this._currentClient);
    void this._sessionClient?.then(client => client.close()).catch(logUnhandledError);
  }

  private async _callContextSwitchTool(params: z.infer<typeof contextSwitchOptions>, _requestContext?: mcpServer.CallToolRequestContext): Promise<CallToolResult> {
    // Only an empty request disconnects. A request naming either field is a
    // switch and needs both as non-blank strings; anything partial is an
    // error that keeps the current provider.
    if (params.connectionString === undefined && params.lib === undefined) {
      if (this._sharedSlot)
        await this._switchSharedClient(this._sharedSlot, undefined);
      else
        await this._setCurrentClient(await this._defaultTransportFactory(), true, true);
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
      await this._setCurrentClient(await this._createSwitchTransport(connectionString, lib), true, false);
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
    const previousShared = this._ownsCurrentClient ? undefined : this._currentClient;
    const shared = await sharedSlot.replace(createTransport ? async () => this._connectClient(await createTransport()) : undefined);
    if (shared) {
      this._currentClient = shared;
      this._ownsCurrentClient = false;
      this._currentClientIsDefault = false;
      await this._ownedSlot.replace(undefined);
    } else {
      await this._setCurrentClient(await this._defaultTransportFactory(), false, true);
    }
    if (previousShared)
      await sharedSlot.release(previousShared);
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
  // provider, and overlapping switches apply in call order.
  private async _setCurrentClient(transport: Transport, notifyOnChange: boolean, isDefault = false) {
    await this._ownedSlot.replace(() => this._connectClient(transport), {
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
