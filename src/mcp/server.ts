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
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toolCallsTotal, toolCallDurationSeconds, userActivityTotal, getPodName } from '../metrics/index.js';
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

export type ServerBackendFactory = {
  name: string;
  nameInConfig: string;
  version: string;
  create: () => ServerBackend;
};

export type SessionMeta = {
  userAgent: string;
  username: string;
};

export async function connect(factory: ServerBackendFactory, transport: Transport, runHeartbeat: boolean, sessionMeta?: SessionMeta) {
  const server = createServer(factory.name, factory.version, factory.create(), runHeartbeat, sessionMeta);
  await server.connect(transport);
}

export async function wrapInProcess(backend: ServerBackend): Promise<Transport> {
  const server = createServer('Internal', '0.0.0', backend, false);
  return new InProcessTransport(server);
}

export function createServer(name: string, version: string, backend: ServerBackend, runHeartbeat: boolean, sessionMeta?: SessionMeta): Server {
  let initializedPromiseResolve = () => {};
  const initializedPromise = new Promise<void>(resolve => initializedPromiseResolve = resolve);
  const server = new Server({ name, version }, {
    capabilities: {
      tools: {
        listChanged: true,
      },
    }
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

    const toolName = request.params.name;
    const pod = getPodName();
    const startMs = Date.now();

    try {
      const result = await backend.callTool(toolName, request.params.arguments || {}, extra);
      const durationSecs = (Date.now() - startMs) / 1000;
      const status = result.isError ? 'error' : 'success';
      toolCallsTotal.inc({ tool_name: toolName, status, pod });
      userActivityTotal.inc({
        activity_type: toolName,
        pod,
        user_agent: sessionMeta?.userAgent ?? 'unknown',
        username: sessionMeta?.username ?? 'unknown',
      });
      toolCallDurationSeconds.observe({ tool_name: toolName, pod }, durationSecs);
      return result;
    } catch (error) {
      const durationSecs = (Date.now() - startMs) / 1000;
      toolCallsTotal.inc({ tool_name: toolName, status: 'error', pod });
      userActivityTotal.inc({
        activity_type: toolName,
        pod,
        user_agent: sessionMeta?.userAgent ?? 'unknown',
        username: sessionMeta?.username ?? 'unknown',
      });
      toolCallDurationSeconds.observe({ tool_name: toolName, pod }, durationSecs);
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
        const { roots } = await server.listRoots(undefined, { timeout: 2_000 }).catch(() => ({ roots: [] }));
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
  const beat = () => {
    Promise.race([
      server.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), 5000)),
    ]).then(() => {
      setTimeout(beat, 3000);
    }).catch(() => {
      void server.close();
    });
  };

  beat();
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
    await connect(serverBackendFactory, new StdioServerTransport(), false);
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
