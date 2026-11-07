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

import { fileURLToPath } from 'node:url';
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
  name = 'Playwright MCP Client Switcher';
  version = packageJSON.version;

  private _currentClient: Client | undefined;
  private _ownsCurrentClient = true;
  private _currentClientIsDefault = false;
  private _sessionClient: Promise<Client> | undefined;
  private _contextSwitchTool: Tool;
  private _clientVersion?: ClientVersion;
  private _backendContext: ServerBackendContext | undefined;
  private _listedClient: Client | undefined;
  private _providerGeneration = 0;
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
    if (name === this._contextSwitchTool.name)
      return this._callContextSwitchTool(args as any, requestContext);
    const client = await this._clientForTool(name, args, requestContext);
    return await this._relay.callTool(client, name, args, requestContext);
  }

  private async _clientForTool(name: string, args: CallToolRequest['params']['arguments'], requestContext?: Pick<mcpServer.CallToolRequestContext, '_meta'>): Promise<Client> {
    const sessionTraffic = name.startsWith('webmcp_')
      ? requestContext?._meta?.browserSessionId !== undefined
      : name === 'browser_session_open' || name === 'browser_session_close' || typeof args?.browserSessionId === 'string';
    if (!sessionTraffic || this._currentClientIsDefault)
      return this._currentClient!;
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

  async serverClosed(): Promise<void> {
    this._relay.close();
    this._backendContext = undefined;
    this._listedClient = undefined;
    const client = this._currentClient;
    await Promise.all([
      this._ownsCurrentClient ? client?.close().catch(logUnhandledError) : client && this._sharedSlot?.release(client),
      this._sessionClient?.then(sessionClient => sessionClient.close()).catch(logUnhandledError),
    ]);
  }

  private async _callContextSwitchTool(params: z.infer<typeof contextSwitchOptions>, _requestContext?: mcpServer.CallToolRequestContext): Promise<CallToolResult> {
    if (!params.connectionString || !params.lib) {
      if (this._sharedSlot)
        await this._switchSharedClient(undefined);
      else
        await this._setCurrentClient(await this._defaultTransportFactory(), true, true);
      return {
        content: [{ type: 'text', text: '### Result\nSuccessfully disconnected.\n' }],
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

    if (this._sharedSlot)
      await this._switchSharedClient(() => this._createSwitchTransport(params.connectionString!, params.lib!));
    else
      await this._setCurrentClient(await this._createSwitchTransport(params.connectionString, params.lib), true, false);
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
        path.join(fileURLToPath(import.meta.url), '..', 'main.js'),
        JSON.stringify({ ...this._config, server: { ...this._config.server, authToken: undefined }, outputDir: resolveOutputDir(this._config) }),
        connectionString,
        lib,
      ],
    });
  }

  private async _switchSharedClient(createTransport: (() => Promise<Transport>) | undefined): Promise<void> {
    const previousOwned = this._ownsCurrentClient ? this._currentClient : undefined;
    const previousShared = this._ownsCurrentClient ? undefined : this._currentClient;
    const shared = await this._sharedSlot!.replace(createTransport ? async () => this._connectClient(await createTransport()) : undefined);
    if (shared) {
      this._currentClient = shared;
      this._ownsCurrentClient = false;
      this._currentClientIsDefault = false;
    } else {
      this._currentClient = await this._connectClient(await this._defaultTransportFactory());
      this._ownsCurrentClient = true;
      this._currentClientIsDefault = true;
    }
    if (previousShared)
      await this._sharedSlot!.release(previousShared);
    await previousOwned?.close().catch(logUnhandledError);
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

  private async _setCurrentClient(transport: Transport, notifyOnChange: boolean, isDefault = false) {
    ++this._providerGeneration;
    if (this._listedClient === this._currentClient)
      this._listedClient = undefined;
    await this._currentClient?.close();
    this._currentClient = undefined;
    this._currentClientIsDefault = false;

    const client = await this._connectClient(transport);
    this._currentClient = client;
    this._ownsCurrentClient = true;
    this._currentClientIsDefault = isDefault;
    if (isDefault)
      this._listedClient = undefined;
    if (notifyOnChange)
      await this._backendContext?.notifyToolListChanged();
  }

  private async _connectClient(transport: Transport): Promise<Client> {
    const client = new Client(this._clientVersion!);
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
