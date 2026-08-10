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
import { notifyToolListChanged } from '../mcp/toolListChanged.js';
import { logUnhandledError } from '../utils/log.js';
import { packageJSON } from '../utils/package.js';

import type { FullConfig } from '../config.js';
import { BrowserServerBackend } from '../browserServerBackend.js';
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
  private _contextSwitchTool: Tool;
  private _clientVersion?: ClientVersion;
  private _backendContext: ServerBackendContext | undefined;

  constructor(private readonly _config: FullConfig, private readonly _defaultTransportFactory: () => Promise<Transport>) {
    this._contextSwitchTool = this._defineContextSwitchTool();
  }

  async initialize(context: ServerBackendContext, clientVersion: ClientVersion): Promise<void> {
    this._backendContext = context;
    this._clientVersion = clientVersion;
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
    const previousTools = notifyOnChange ? await this._getExposedTools(this._currentClient).catch(() => undefined) : undefined;
    await this._currentClient?.close();
    this._currentClient = undefined;

    const client = new Client(this._clientVersion!);
    client.setRequestHandler('ping', () => ({}));

    await client.connect(transport);
    this._currentClient = client;
    await notifyToolListChanged(this._backendContext, previousTools, await this._getExposedTools(client));
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
