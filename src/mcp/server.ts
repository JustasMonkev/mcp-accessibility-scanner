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

import { McpServer, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { httpAddressToString, installHttpTransport, startHttpServer } from './http.js';
import { InProcessTransport } from './inProcessTransport.js';
import { createUrlRedactor, redactToolResult } from '../utils/urlRedaction.js';
import { logUnhandledError } from '../utils/log.js';

import type { CacheHint, Server, Tool, CallToolResult, CallToolRequest, RequestId, RequestMeta, ServerNotification, Transport } from '@modelcontextprotocol/server';
import type { SkillsExtension } from '@modelcontextprotocol/server/ext/skills';
import { printToStderr } from '../utils/terminal.js';
export type { Server } from '@modelcontextprotocol/server';
export type { Tool, CallToolResult, CallToolRequest } from '@modelcontextprotocol/server';

const serverDebug = debug('pw:mcp:server');

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

type ServerMetadata = {
  title?: string;
  instructions?: string;
  redactUrlParams?: readonly string[];
  toolListCacheHint?: CacheHint;
  // Agent Skills to serve over MCP (`io.modelcontextprotocol/skills`): adds
  // `skills/list`, `skills/get` and `skill://` resources next to the tools.
  skills?: SkillsExtension;
};

export type ServerBackendFactory = ServerMetadata & {
  name: string;
  nameInConfig: string;
  version: string;
  create: () => ServerBackend;
  createStateless?: () => ServerBackend;
};

export async function connect(factory: ServerBackendFactory, transport: Transport, runHeartbeat: boolean, heartbeatReady: Promise<void> = Promise.resolve()) {
  const server = createServer(factory.name, factory.version, factory.create(), runHeartbeat, { ...factory, heartbeatReady });
  await server.connect(transport);
}

export async function wrapInProcess(backend: ServerBackend): Promise<Transport> {
  const server = createServer('Internal', '0.0.0', backend, false);
  return new InProcessTransport(server);
}

type ServerOptions = ServerMetadata & { heartbeatReady?: Promise<void> };

export function createServer(name: string, version: string, backend: ServerBackend, runHeartbeat: boolean, options?: ServerOptions): Server {
  const redactSecrets = createUrlRedactor(options?.redactUrlParams);
  // McpServer only to host the skills extension's resource template; tools stay
  // on the low-level handlers below. Declaring `tools` in the constructor
  // options would install McpServer's own tools/* handlers, so register the
  // capability on the inner Server instead.
  const mcp = new McpServer({ name, version, title: options?.title }, {
    instructions: options?.instructions,
    cacheHints: !backend.dynamicToolList && options?.toolListCacheHint ? { 'tools/list': options.toolListCacheHint } : undefined,
  });
  const server = mcp.server;
  server.registerCapabilities({
    tools: {
      listChanged: true,
    },
  });
  options?.skills?.attach(mcp);
  const ensureInitialized = backendInitializer(server, backend);

  server.setRequestHandler('tools/list', async (_request, ctx) => {
    serverDebug('listTools');
    await ensureInitialized();
    const tools = await backend.listTools({ _meta: ctx.mcpReq._meta, signal: ctx.mcpReq.signal });
    return { tools: redactSecrets ? tools.map(tool => redactToolMetadata(tool, redactSecrets)) : tools };
  });

  let heartbeatRunning = false;
  server.setRequestHandler('tools/call', async (request, ctx) => {
    serverDebug('callTool', request);
    await ensureInitialized();

    if (runHeartbeat && !heartbeatRunning) {
      heartbeatRunning = true;
      void (options?.heartbeatReady ?? Promise.resolve()).then(() => startHeartbeat(server)).catch(logUnhandledError);
    }

    const requestContext: CallToolRequestContext = {
      signal: ctx.mcpReq.signal,
      requestId: ctx.mcpReq.id,
      sendNotification: notification => ctx.mcpReq.notify(redactProgressMessage(notification, redactSecrets)),
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
    ensureInitialized().catch(logUnhandledError);
  });
  addServerListener(server, 'close', () => backend.serverClosed?.());
  return server;
}

function backendInitializer(server: Server, backend: ServerBackend): () => Promise<void> {
  let initialized: Promise<void> | undefined;
  return () => {
    if (initialized)
      return initialized;
    const initialization = (async () => {
      const clientVersion = server.getClientVersion() ?? { name: 'unknown', version: 'unknown' };
      await backend.initialize?.({ notifyToolListChanged: () => server.sendToolListChanged() }, clientVersion);
    })();
    initialization.catch(() => {
      if (initialized === initialization)
        initialized = undefined;
    });
    initialized = initialization;
    return initialization;
  };
}

function redactToolMetadata(tool: Tool, redact: (text: string) => string): Tool {
  const rendered = { ...tool };
  if (typeof tool.title === 'string')
    rendered.title = redact(tool.title);
  if (typeof tool.description === 'string')
    rendered.description = redact(tool.description);
  if (typeof tool.annotations?.title === 'string')
    rendered.annotations = { ...tool.annotations, title: redact(tool.annotations.title) };
  return rendered;
}

function redactProgressMessage(notification: ServerNotification, redact: ((text: string) => string) | undefined): ServerNotification {
  if (!redact || notification.method !== 'notifications/progress' || typeof notification.params?.message !== 'string')
    return notification;
  return { ...notification, params: { ...notification.params, message: redact(notification.params.message) } };
}

const startHeartbeat = (server: Server) => {
  const timeout = pingTimeout();
  if (timeout <= 0)
    return;

  const beat = () => {
    server.request({ method: 'ping' }, { timeout }).then(() => {
      setTimeout(beat, heartbeatIntervalMs);
    }).catch(error => {
      if (ProtocolError.isInstance(error) && error.code === ProtocolErrorCode.MethodNotFound)
        return;
      void server.close();
    });
  };

  beat();
};

const defaultPingTimeout = 5000;
const heartbeatIntervalMs = 3000;

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
  printToStderr(message);
}
