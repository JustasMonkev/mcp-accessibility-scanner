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

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, EmptyResultSchema, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { httpAddressToString, installHttpTransport, startHttpServer } from './http.js';
import { InProcessTransport } from './inProcessTransport.js';

import type { Tool, CallToolResult, CallToolRequest, Root, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
export type { Server } from '@modelcontextprotocol/sdk/server/index.js';
export type { Tool, CallToolResult, CallToolRequest, Root } from '@modelcontextprotocol/sdk/types.js';

const serverDebug = debug('pw:mcp:server');
const errorsDebug = debug('pw:mcp:errors');

export type ClientVersion = { name: string, version: string };
export type CallToolRequestContext = Pick<RequestHandlerExtra<ServerRequest, ServerNotification>, 'signal' | 'requestId' | 'sendNotification' | '_meta'>;
export type ServerBackendContext = {
  notifyToolListChanged(): Promise<void>;
};

export interface ServerBackend {
  initialize?(context: ServerBackendContext, clientVersion: ClientVersion, roots: Root[]): Promise<void>;
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: CallToolRequest['params']['arguments'], requestContext?: CallToolRequestContext): Promise<CallToolResult>;
  serverClosed?(): void;
}

export type ServerMetadata = {
  title?: string;
  instructions?: string;
};

export type ServerBackendFactory = ServerMetadata & {
  name: string;
  nameInConfig: string;
  version: string;
  create: () => ServerBackend;
};

export async function connect(factory: ServerBackendFactory, transport: Transport, transportInitialized: Promise<void>, runHeartbeat: boolean) {
  const server = createServer(factory.name, factory.version, factory.create(), transportInitialized, runHeartbeat, factory);
  await server.connect(transport);
}

export async function wrapInProcess(backend: ServerBackend): Promise<Transport> {
  const server = createServer('Internal', '0.0.0', backend, Promise.resolve(), false);
  return new InProcessTransport(server);
}

export function createServer(name: string, version: string, backend: ServerBackend, transportInitialized: Promise<void>, runHeartbeat: boolean, metadata?: ServerMetadata): Server {
  let initializedPromiseResolve = () => {};
  const initializedPromise = new Promise<void>(resolve => initializedPromiseResolve = resolve);
  const server = new Server({ name, version, title: metadata?.title }, {
    capabilities: {
      tools: {
        listChanged: true,
      },
    },
    instructions: metadata?.instructions,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    serverDebug('listTools');
    await initializedPromise;
    const tools = await backend.listTools();
    return { tools };
  });

  let heartbeatRunning = false;
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    serverDebug('callTool', request);
    await initializedPromise;

    if (runHeartbeat && !heartbeatRunning) {
      heartbeatRunning = true;
      startHeartbeat(server);
    }

    try {
      return await backend.callTool(request.params.name, request.params.arguments || {}, extra);
    } catch (error) {
      // Protocol-level failures (e.g. unknown tool) surface as JSON-RPC
      // errors; only tool execution failures become isError results.
      if (error instanceof McpError)
        throw error;
      return {
        content: [{ type: 'text', text: '### Result\n' + String(error) }],
        isError: true,
      };
    }
  });
  addServerListener(server, 'initialized', async () => {
    try {
      const capabilities = server.getClientCapabilities();
      let clientRoots: Root[] = [];
      if (capabilities?.roots) {
        await transportInitialized;
        const { roots } = await server.listRoots(undefined, { timeout: 2_000 }).catch(e => {
          serverDebug(e);
          return { roots: [] };
        });
        clientRoots = roots;
      }
      const clientVersion = server.getClientVersion() ?? { name: 'unknown', version: 'unknown' };
      const context: ServerBackendContext = {
        notifyToolListChanged: () => server.sendToolListChanged(),
      };
      await backend.initialize?.(context, clientVersion, clientRoots);
      initializedPromiseResolve();
    } catch (e) {
      errorsDebug(e);
    }
  });
  addServerListener(server, 'close', () => backend.serverClosed?.());
  return server;
}

const startHeartbeat = (server: Server) => {
  const timeout = pingTimeout();
  if (timeout <= 0)
    return;

  const beat = () => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const ping = server.request({ method: 'ping' }, EmptyResultSchema, { timeout }).finally(() => {
      if (timeoutId)
        clearTimeout(timeoutId);
    });
    Promise.race([
      ping,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('ping timeout')), timeout);
      }),
    ]).then(() => {
      setTimeout(beat, 3000);
    }).catch(() => {
      void server.close();
    });
  };

  beat();
};

const defaultPingTimeout = 5000;

const pingTimeout = (): number => {
  const value = process.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS;
  if (value === undefined)
    return defaultPingTimeout;
  const trimmed = value.trim();
  if (!trimmed)
    return defaultPingTimeout;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed))
    return defaultPingTimeout;
  return parsed;
};

function addServerListener(server: Server, event: 'close' | 'initialized', listener: () => void) {
  const oldListener = server[`on${event}`];
  server[`on${event}`] = () => {
    oldListener?.();
    listener();
  };
}

export async function start(serverBackendFactory: ServerBackendFactory, options: { host?: string; port?: number }) {
  if (options.port === undefined) {
    await connect(serverBackendFactory, new StdioServerTransport(), Promise.resolve(), false);
    return;
  }

  const httpServer = await startHttpServer(options);
  await installHttpTransport(httpServer, serverBackendFactory);
  const url = httpAddressToString(httpServer.address());

  const mcpConfig: any = { mcpServers: { } };
  mcpConfig.mcpServers[serverBackendFactory.nameInConfig] = {
    url: `${url}/mcp`
  };
  const message = [
    `Listening on ${url}`,
    'Put this in your client config:',
    JSON.stringify(mcpConfig, undefined, 2),
  ].join('\n');
    // eslint-disable-next-line no-console
  console.error(message);
}
