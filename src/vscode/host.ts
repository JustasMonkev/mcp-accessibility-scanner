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

import { fileURLToPath } from 'url';
import path from 'path';
import { z } from 'zod';


import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ListRootsRequestSchema, PingRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as mcpServer from '../mcp/server.js';
import { notifyToolListChanged } from '../mcp/toolListChanged.js';
import { logUnhandledError } from '../utils/log.js';
import { packageJSON } from '../utils/package.js';

import { FullConfig } from '../config.js';
import { BrowserServerBackend } from '../browserServerBackend.js';
import { contextFactory } from '../browserContextFactory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ClientVersion, ServerBackend, ServerBackendContext } from '../mcp/server.js';
import type { Root, Tool, CallToolResult, CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const contextSwitchOptions = z.object({
  connectionString: z.string().optional().describe('The connection string to use to connect to the browser'),
  lib: z.string().optional().describe('The library to use for the connection'),
});

export class VSCodeProxyBackend implements ServerBackend {
  name = 'Playwright MCP Client Switcher';
  version = packageJSON.version;

  private _currentClient: Client | undefined;
  private _contextSwitchTool: Tool;
  private _roots: Root[] = [];
  private _clientVersion?: ClientVersion;
  private _backendContext: ServerBackendContext | undefined;

  constructor(private readonly _config: FullConfig, private readonly _defaultTransportFactory: () => Promise<Transport>) {
    this._contextSwitchTool = this._defineContextSwitchTool();
  }

  async initialize(context: ServerBackendContext, clientVersion: ClientVersion, roots: Root[]): Promise<void> {
    this._backendContext = context;
    this._clientVersion = clientVersion;
    this._roots = roots;
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
    }) as CallToolResult;
  }

  serverClosed?(): void {
    void this._currentClient?.close().catch(logUnhandledError);
  }

  private async _callContextSwitchTool(params: z.infer<typeof contextSwitchOptions>, _requestContext?: mcpServer.CallToolRequestContext): Promise<CallToolResult> {
    if (!params.connectionString || !params.lib) {
      const transport = await this._defaultTransportFactory();
      await this._setCurrentClient(transport, true);
      return {
        content: [{ type: 'text', text: '### Result\nSuccessfully disconnected.\n' }],
      };
    }

    await this._setCurrentClient(
        new StdioClientTransport({
          command: process.execPath,
          cwd: process.cwd(),
          args: [
            path.join(fileURLToPath(import.meta.url), '..', 'main.js'),
            JSON.stringify(this._config),
            params.connectionString,
            params.lib,
          ],
        }),
        true,
    );
    return {
      content: [{ type: 'text', text: '### Result\nSuccessfully connected.\n' }],
    };
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
    const previousToolNames = notifyOnChange ? await this._getExposedToolNames(this._currentClient).catch(() => undefined) : undefined;
    await this._currentClient?.close();
    this._currentClient = undefined;

    const client = new Client(this._clientVersion!);
    client.registerCapabilities({
      roots: {
        listChanged: true,
      },
    });
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: this._roots }));
    client.setRequestHandler(PingRequestSchema, () => ({}));

    await client.connect(transport);
    this._currentClient = client;
    await notifyToolListChanged(this._backendContext, previousToolNames, await this._getExposedToolNames(client));
  }

  private async _getExposedToolNames(client: Client | undefined): Promise<string[]> {
    if (!client)
      return [];

    const { tools } = await client.listTools();
    return [
      ...tools.map(tool => tool.name),
      this._contextSwitchTool.name,
    ];
  }
}

export async function runVSCodeTools(config: FullConfig) {
  const serverBackendFactory: mcpServer.ServerBackendFactory = {
    name: 'Playwright w/ vscode',
    nameInConfig: 'playwright-vscode',
    version: packageJSON.version,
    create: () => new VSCodeProxyBackend(config, () => mcpServer.wrapInProcess(new BrowserServerBackend(config, contextFactory(config))))
  };
  await mcpServer.start(serverBackendFactory, config.server);
  return;
}
