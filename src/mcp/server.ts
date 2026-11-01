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

import { ProtocolError, ProtocolErrorCode, Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { httpAddressToString, installHttpTransport, startHttpServer } from './http.js';
import { InProcessTransport } from './inProcessTransport.js';
import { createUrlRedactor, redactToolResult } from '../utils/urlRedaction.js';

import type { CacheHint, Tool, CallToolResult, CallToolRequest, RequestId, RequestMeta, ServerNotification, Transport } from '@modelcontextprotocol/server';
export type { Server } from '@modelcontextprotocol/server';
export type { Tool, CallToolResult, CallToolRequest } from '@modelcontextprotocol/server';

const serverDebug = debug('pw:mcp:server');
const errorsDebug = debug('pw:mcp:errors');

export type ClientVersion = { name: string, version: string };
export type CallToolRequestContext = {
  signal: AbortSignal;
  requestId: RequestId;
  sendNotification: (notification: ServerNotification) => Promise<void>;
  _meta?: RequestMeta;
};
export type ServerBackendContext = {
  notifyToolListChanged(): Promise<void>;
};

export interface ServerBackend {
  readonly dynamicToolList?: boolean;
  initialize?(context: ServerBackendContext, clientVersion: ClientVersion): Promise<void>;
  listTools(requestContext?: Partial<Pick<CallToolRequestContext, 'signal' | '_meta'>>): Promise<Tool[]>;
  callTool(name: string, args: CallToolRequest['params']['arguments'], requestContext?: CallToolRequestContext): Promise<CallToolResult>;
  serverClosed?(): void;
}

export type ServerMetadata = {
  title?: string;
  instructions?: string;
  redactUrlParams?: readonly string[];
  toolListCacheHint?: CacheHint;
};

export type ServerBackendFactory = ServerMetadata & {
  name: string;
  nameInConfig: string;
  version: string;
  create: () => ServerBackend;
  createStateless?: () => ServerBackend;
};

export async function connect(factory: ServerBackendFactory, transport: Transport, runHeartbeat: boolean, heartbeatReady: Promise<void> = Promise.resolve()) {
  const server = createServer(factory.name, factory.version, factory.create(), runHeartbeat, factory, heartbeatReady);
  await server.connect(transport);
}

export async function wrapInProcess(backend: ServerBackend): Promise<Transport> {
  const server = createServer('Internal', '0.0.0', backend, false);
  return new InProcessTransport(server);
}

export function createServer(name: string, version: string, backend: ServerBackend, runHeartbeat: boolean, metadata?: ServerMetadata, heartbeatReady: Promise<void> = Promise.resolve()): Server {
  const redactSecrets = createUrlRedactor(metadata?.redactUrlParams);
  const server = new Server({ name, version, title: metadata?.title }, {
    capabilities: {
      tools: {
        listChanged: true,
      },
    },
    instructions: metadata?.instructions,
    ...(!backend.dynamicToolList && metadata?.toolListCacheHint ? { cacheHints: { 'tools/list': metadata.toolListCacheHint } } : {}),
  });

  let backendInitialized: Promise<void> | undefined;
  const ensureInitialized = (): Promise<void> => {
    if (!backendInitialized) {
      const initialization = (async () => {
        const clientVersion = server.getClientVersion() ?? { name: 'unknown', version: 'unknown' };
        const context: ServerBackendContext = {
          notifyToolListChanged: () => server.sendToolListChanged(),
        };
        await backend.initialize?.(context, clientVersion);
      })();
      initialization.catch(() => {
        if (backendInitialized === initialization)
          backendInitialized = undefined;
      });
      backendInitialized = initialization;
    }
    return backendInitialized;
  };

  server.setRequestHandler('tools/list', async (_request, ctx) => {
    serverDebug('listTools');
    await ensureInitialized();
    const tools = await backend.listTools({ _meta: ctx.mcpReq._meta, signal: ctx.mcpReq.signal });
    if (!redactSecrets)
      return { tools };
    return { tools: tools.map(tool => {
      const rendered = { ...tool };
      if (typeof tool.title === 'string')
        rendered.title = redactSecrets(tool.title);
      if (typeof tool.description === 'string')
        rendered.description = redactSecrets(tool.description);
      if (typeof tool.annotations?.title === 'string')
        rendered.annotations = { ...tool.annotations, title: redactSecrets(tool.annotations.title) };
      return rendered;
    }) };
  });

  let heartbeatRunning = false;
  server.setRequestHandler('tools/call', async (request, ctx) => {
    serverDebug('callTool', request);
    await ensureInitialized();

    if (runHeartbeat && !heartbeatRunning) {
      heartbeatRunning = true;
      void heartbeatReady.then(() => startHeartbeat(server)).catch(errorsDebug);
    }

    const requestContext: CallToolRequestContext = {
      signal: ctx.mcpReq.signal,
      requestId: ctx.mcpReq.id,
      sendNotification: notification => {
        if (redactSecrets && notification.method === 'notifications/progress' && typeof notification.params?.message === 'string')
          return ctx.mcpReq.notify({ ...notification, params: { ...notification.params, message: redactSecrets(notification.params.message) } });
        return ctx.mcpReq.notify(notification);
      },
      _meta: ctx.mcpReq._meta,
    };
    try {
      return redactToolResult(await backend.callTool(request.params.name, request.params.arguments || {}, requestContext), redactSecrets);
    } catch (error) {
      if (ProtocolError.isInstance(error))
        throw error;
      return redactToolResult({
        content: [{ type: 'text', text: '### Result\n' + String(error) }],
        isError: true,
      }, redactSecrets);
    }
  });
  addServerListener(server, 'initialized', () => {
    ensureInitialized().catch(e => errorsDebug(e));
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
    const ping = server.request({ method: 'ping' }, { timeout }).finally(() => {
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
    }).catch(error => {
      if (ProtocolError.isInstance(error) && error.code === ProtocolErrorCode.MethodNotFound)
        return;
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

export async function start(serverBackendFactory: ServerBackendFactory, options: { host?: string; port?: number; authToken?: string }) {
  if (options.port === undefined) {
    await connect(serverBackendFactory, new StdioServerTransport(), false);
    return;
  }

  const httpServer = await startHttpServer(options);
  try {
    await installHttpTransport(httpServer, serverBackendFactory, { authToken: options.authToken });
  } catch (error) {
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
    throw error;
  }
  const url = httpAddressToString(httpServer.address());

  const clientConfig: { url: string; headers?: { Authorization: string } } = {
    url: `${url}/mcp`
  };
  if (options.authToken !== undefined)
    clientConfig.headers = { Authorization: 'Bearer <YOUR_AUTH_TOKEN>' };
  const mcpConfig = { mcpServers: { [serverBackendFactory.nameInConfig]: clientConfig } };
  const message = [
    `Listening on ${url}`,
    options.authToken !== undefined ? 'Put this in your client config and replace <YOUR_AUTH_TOKEN> locally with your configured token:' : 'Put this in your client config:',
    JSON.stringify(mcpConfig, undefined, 2),
  ].join('\n');
    // eslint-disable-next-line no-console
  console.error(message);
}
