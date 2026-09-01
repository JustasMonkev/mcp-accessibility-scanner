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

import type { CacheHint, Tool, CallToolResult, CallToolRequest, RequestId, RequestMeta, ServerNotification, Transport } from '@modelcontextprotocol/server';
export type { Server } from '@modelcontextprotocol/server';
export type { Tool, CallToolResult, CallToolRequest } from '@modelcontextprotocol/server';

const serverDebug = debug('pw:mcp:server');
const errorsDebug = debug('pw:mcp:errors');

export type ClientVersion = { name: string, version: string };
// The stable request context handed to backends. The v2 SDK reshaped the
// handler context (`RequestHandlerExtra` became `ServerContext`/`ctx.mcpReq`);
// this type keeps the backend contract unchanged and is populated from the
// SDK context at the tools/call handler boundary.
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
  initialize?(context: ServerBackendContext, clientVersion: ClientVersion): Promise<void>;
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: CallToolRequest['params']['arguments'], requestContext?: CallToolRequestContext): Promise<CallToolResult>;
  serverClosed?(): void;
}

export type ServerMetadata = {
  title?: string;
  instructions?: string;
  /**
   * Cache hint stamped on `tools/list` results served to MCP 2026-07-28
   * clients (SEP-2549 `ttlMs`/`cacheScope`). Set it only for backends whose
   * tool list is fixed for the process lifetime; leave it unset for backends
   * that can change their list at runtime (e.g. the proxy's context switch or
   * the VS Code host), which keeps the SDK's conservative `ttlMs: 0` default.
   * 2025-era responses never carry cache fields either way.
   */
  toolListCacheHint?: CacheHint;
};

export type ServerBackendFactory = ServerMetadata & {
  name: string;
  nameInConfig: string;
  version: string;
  create: () => ServerBackend;
  /**
   * Optional variant used for stateless per-request HTTP serving
   * (handshake-free 2025 requests and the modern 2026-07-28 endpoint): the
   * created backend serves exactly one exchange and is closed with the
   * response, so implementations can shape it for that lifecycle — e.g. run
   * its default browser context in a disposable profile instead of contending
   * for the stable persistent one. Falls back to create() when absent.
   * Stateful serving (stdio, Mcp-Session-Id HTTP sessions) always uses
   * create().
   */
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
  const server = new Server({ name, version, title: metadata?.title }, {
    capabilities: {
      tools: {
        listChanged: true,
      },
    },
    instructions: metadata?.instructions,
    ...(metadata?.toolListCacheHint ? { cacheHints: { 'tools/list': metadata.toolListCacheHint } } : {}),
  });

  // Idempotent backend initialization shared by the handshake path and the
  // lazy per-request path. The `initialized` notification remains the
  // preferred entry point (it carries the client's identity), but the MCP
  // 2026-07-28 revision removes the initialize/initialized handshake entirely,
  // so a request arriving without one must trigger initialization on demand
  // instead of hanging forever. Whichever path runs first wins; concurrent
  // callers await the same in-flight promise. Refs #165.
  // Roots are deprecated in MCP 2026-07-28 (SEP-2577) and are no longer
  // fetched here — output directories come from server configuration
  // (`--output-dir` / `outputDir`) instead of a client-supplied root, which
  // also drops a blocking listRoots round-trip from startup. Refs #169.
  let backendInitialized: Promise<void> | undefined;
  const ensureInitialized = (): Promise<void> => {
    if (!backendInitialized) {
      const initialization = (async () => {
        // Pre-handshake there is no client info yet.
        const clientVersion = server.getClientVersion() ?? { name: 'unknown', version: 'unknown' };
        const context: ServerBackendContext = {
          notifyToolListChanged: () => server.sendToolListChanged(),
        };
        await backend.initialize?.(context, clientVersion);
      })();
      // Memoize success only: a rejected attempt clears the memo so the next
      // request retries instead of replaying the same failure forever (e.g. a
      // long-lived stdio process whose backend hit a transient error). Callers
      // already awaiting this attempt still observe its rejection — they hold
      // the promise before this handler clears the memo.
      initialization.catch(() => {
        if (backendInitialized === initialization)
          backendInitialized = undefined;
      });
      backendInitialized = initialization;
    }
    return backendInitialized;
  };

  server.setRequestHandler('tools/list', async () => {
    serverDebug('listTools');
    await ensureInitialized();
    const tools = await backend.listTools();
    return { tools };
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
      sendNotification: notification => ctx.mcpReq.notify(notification),
      _meta: ctx.mcpReq._meta,
    };
    try {
      return await backend.callTool(request.params.name, request.params.arguments || {}, requestContext);
    } catch (error) {
      // Protocol-level failures (e.g. unknown tool) surface as JSON-RPC
      // errors; only tool execution failures become isError results.
      // `isInstance` brand-matches, so a `ProtocolError` constructed by
      // another bundled SDK copy (e.g. the client package in-process) is
      // recognized too.
      if (ProtocolError.isInstance(error))
        throw error;
      return {
        content: [{ type: 'text', text: '### Result\n' + String(error) }],
        isError: true,
      };
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
      // A "method not found" reply proves the peer is alive — it answered.
      // MCP 2026-07-28 clients reject `ping` as an unknown method, so stop
      // heartbeating this connection for good instead of killing it. Only a
      // timeout or transport-level failure still closes the server. Refs #168.
      // Brand-matched check: the error may be constructed by the client
      // package's bundled SDK copy when both run in-process.
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
