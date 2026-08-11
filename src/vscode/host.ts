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
import { SharedClientSlot } from '../mcp/sharedClientSlot.js';
import { notifyToolListChanged } from '../mcp/toolListChanged.js';
import { logUnhandledError } from '../utils/log.js';
import { packageJSON } from '../utils/package.js';

import { resolveOutputDir } from '../config.js';
import type { FullConfig } from '../config.js';
import { BrowserServerBackend } from '../browserServerBackend.js';
import { BrowserSessionRegistry } from '../browserSessions.js';
import { assertStorageStateDoesNotResetUserProfile, contextFactory } from '../browserContextFactory.js';
import { vscodeProfileConflictRemedy } from './browserContextFactory.js';
import type { Transport } from '@modelcontextprotocol/client';
import type { ClientVersion, ServerBackend, ServerBackendContext, Tool, CallToolResult, CallToolRequest } from '../mcp/server.js';

const contextSwitchOptions = z.object({
  connectionString: z.string().optional().describe('The connection string to use to connect to the browser'),
  lib: z.string().optional().describe('The library to use for the connection'),
});

export class VSCodeProxyBackend implements ServerBackend {
  name = 'Playwright MCP Client Switcher';
  version = packageJSON.version;

  private _currentClient: Client | undefined;
  // False when _currentClient is adopted from the shared slot: response
  // cleanup (serverClosed) must not tear down the process-scoped client (and
  // the spawned VS Code child behind it) that later requests route through.
  private _ownsCurrentClient = true;
  private _contextSwitchTool: Tool;
  private _clientVersion?: ClientVersion;
  private _backendContext: ServerBackendContext | undefined;

  constructor(private readonly _config: FullConfig, private readonly _defaultTransportFactory: () => Promise<Transport>, private readonly _sharedSlot?: SharedClientSlot) {
    this._contextSwitchTool = this._defineContextSwitchTool();
  }

  async initialize(context: ServerBackendContext, clientVersion: ClientVersion): Promise<void> {
    this._backendContext = context;
    this._clientVersion = clientVersion;
    // A process-scoped browser_connect switch is in effect: adopt it instead
    // of connecting the default provider, so the selection made in an earlier
    // handshake-free request keeps governing this one.
    const shared = this._sharedSlot?.current();
    if (shared) {
      this._currentClient = shared;
      this._ownsCurrentClient = false;
      return;
    }
    const transport = await this._defaultTransportFactory();
    await this._setCurrentClient(transport, false);
  }

  async listTools(): Promise<Tool[]> {
    const response = await this._currentClient!.listTools();
    return [
      ...response.tools,
      this._contextSwitchTool,
    ];
  }

  async callTool(name: string, args: CallToolRequest['params']['arguments'], requestContext?: mcpServer.CallToolRequestContext): Promise<CallToolResult> {
    if (name === this._contextSwitchTool.name)
      return this._callContextSwitchTool(args as any, requestContext);
    return await this._currentClient!.callTool({
      name,
      arguments: args,
      _meta: requestContext?._meta,
    });
  }

  serverClosed?(): void {
    if (this._ownsCurrentClient)
      void this._currentClient?.close().catch(logUnhandledError);
  }

  private async _callContextSwitchTool(params: z.infer<typeof contextSwitchOptions>, _requestContext?: mcpServer.CallToolRequestContext): Promise<CallToolResult> {
    if (!params.connectionString || !params.lib) {
      if (this._sharedSlot)
        await this._switchSharedClient(undefined);
      else
        await this._setCurrentClient(await this._defaultTransportFactory(), true);
      return {
        content: [{ type: 'text', text: '### Result\nSuccessfully disconnected.\n' }],
      };
    }

    // The child's factory would only surface this on the first browser
    // operation — after the working provider has already been torn down,
    // leaving the session attached to a provider that can never create a
    // context. Validated here instead, so a rejected switch keeps the
    // session on the previous provider.
    try {
      assertStorageStateDoesNotResetUserProfile(this._config, vscodeProfileConflictRemedy);
    } catch (error) {
      return {
        content: [{ type: 'text', text: `### Result\n${error instanceof Error ? error.message : String(error)}\n` }],
        isError: true,
      };
    }

    if (this._sharedSlot)
      await this._switchSharedClient(() => this._createSwitchTransport(params.connectionString!, params.lib!));
    else
      await this._setCurrentClient(await this._createSwitchTransport(params.connectionString, params.lib), true);
    return {
      content: [{ type: 'text', text: '### Result\nSuccessfully connected.\n' }],
    };
  }

  private async _createSwitchTransport(connectionString: string, lib: string): Promise<Transport> {
    return new StdioClientTransport({
      command: process.execPath,
      cwd: process.cwd(),
      args: [
        path.join(fileURLToPath(import.meta.url), '..', 'main.js'),
        // The fallback output dir is memoized on the config OBJECT, and
        // JSON round-tripping into the child mints a new object — without
        // materializing the resolved dir here, the spawned provider would
        // open a second temp root and scatter one run's artifacts across
        // the provider switch.
        JSON.stringify({ ...this._config, outputDir: resolveOutputDir(this._config) }),
        connectionString,
        lib,
      ],
    });
  }

  // Stateless serving: publish the switch through the process-scoped slot so
  // later per-request backends adopt it. The slot closes the previously
  // shared client itself (exactly once, after the swap, terminating that
  // client's spawned child); only a client this request owned — its
  // per-request default — is closed here.
  private async _switchSharedClient(createTransport: (() => Promise<Transport>) | undefined): Promise<void> {
    const previousTools = await this._getExposedTools(this._currentClient).catch(() => undefined);
    const previousOwned = this._ownsCurrentClient ? this._currentClient : undefined;
    // The transport is created inside the serialized replace(), so a queued
    // concurrent switch never reuses an already-consumed transport.
    const shared = await this._sharedSlot!.replace(createTransport ? async () => this._connectClient(await createTransport()) : undefined);
    if (shared) {
      this._currentClient = shared;
      this._ownsCurrentClient = false;
    } else {
      // Back to the default provider, which stateless serving runs
      // per-request: finish this exchange on an owned per-request client.
      this._currentClient = await this._connectClient(await this._defaultTransportFactory());
      this._ownsCurrentClient = true;
    }
    await previousOwned?.close().catch(logUnhandledError);
    await notifyToolListChanged(this._backendContext, previousTools, await this._getExposedTools(this._currentClient));
  }

  private _defineContextSwitchTool(): Tool {
    return {
      name: 'browser_connect',
      description: 'Do not call, this tool is used in the integration with the Playwright VS Code Extension and meant for programmatic usage only.',
      inputSchema: z.toJSONSchema(contextSwitchOptions) as Tool['inputSchema'],
      annotations: {
        title: 'Connect to a browser running in VS Code.',
        readOnlyHint: true,
        openWorldHint: false,
      },
    };
  }

  private async _setCurrentClient(transport: Transport, notifyOnChange: boolean) {
    const previousTools = notifyOnChange ? await this._getExposedTools(this._currentClient).catch(() => undefined) : undefined;
    await this._currentClient?.close();
    this._currentClient = undefined;

    const client = await this._connectClient(transport);
    this._currentClient = client;
    this._ownsCurrentClient = true;
    await notifyToolListChanged(this._backendContext, previousTools, await this._getExposedTools(client));
  }

  private async _connectClient(transport: Transport): Promise<Client> {
    const client = new Client(this._clientVersion!);
    client.setRequestHandler('ping', () => ({}));

    await client.connect(transport);
    return client;
  }

  private async _getExposedTools(client: Client | undefined): Promise<Tool[]> {
    if (!client)
      return [];

    const { tools } = await client.listTools();
    return [
      ...tools,
      this._contextSwitchTool,
    ];
  }
}

export async function runVSCodeTools(config: FullConfig, registerExitCleanup?: (cleanup: () => Promise<void>) => void) {
  // Both process-scoped, mirroring the direct factories in program.ts: over
  // stateless HTTP each handshake-free POST builds a fresh proxy whose
  // default transport creates a fresh inner backend, and a browserSessionId
  // minted in one request must resolve in the next instead of being disposed
  // when the response closes. Hoisting the context factory also lets those
  // inner backends share one launched browser instead of one per request.
  const browserContextFactory = contextFactory(config);
  const sessionRegistry = new BrowserSessionRegistry();
  // Process-scoped as well: a browser_connect switch made in one
  // handshake-free POST must keep governing the next one — stored only on
  // the per-request proxy it would be closed with the response and silently
  // revert to the default provider. The slot owns the switched client (and
  // the VS Code child process behind it); per-request backends adopt it
  // without owning it.
  const sharedSlot = new SharedClientSlot();
  // The switched child outlives every response, so process shutdown must
  // close it explicitly instead of relying on stdio teardown alone.
  registerExitCleanup?.(async () => {
    await sharedSlot.replace(undefined);
  });
  // A stateless per-request proxy flags its inner default context ephemeral
  // (disposable profile, see startMCPServer in program.ts); stateful proxies
  // keep the stable profile.
  const createBackend = (ephemeralDefaultContext: boolean, slot?: SharedClientSlot) =>
    new VSCodeProxyBackend(config, () => mcpServer.wrapInProcess(new BrowserServerBackend(config, browserContextFactory, sessionRegistry, { ephemeralDefaultContext })), slot);
  const serverBackendFactory: mcpServer.ServerBackendFactory = {
    name: 'Playwright w/ vscode',
    nameInConfig: 'playwright-vscode',
    version: packageJSON.version,
    create: () => createBackend(false),
    createStateless: () => createBackend(true, sharedSlot),
  };
  await mcpServer.start(serverBackendFactory, config.server);
  return;
}
