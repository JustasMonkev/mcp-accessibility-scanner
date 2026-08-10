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

import { z } from 'zod';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { FullConfig } from './config.js';
import { BrowserSessionRegistry } from './browserSessions.js';
import { Context } from './context.js';
import { logUnhandledError } from './utils/log.js';
import { Response } from './response.js';
import { SessionLog } from './sessionLog.js';
import { filteredTools } from './tools.js';
import { toMcpTool } from './mcp/tool.js';

import type { Tool } from './tools/tool.js';
import type { BrowserContextFactory } from './browserContextFactory.js';
import type * as mcpServer from './mcp/server.js';
import type { ServerBackend } from './mcp/server.js';

export class BrowserServerBackend implements ServerBackend {
  private _tools: Tool[];
  private _toolsByName: Map<string, Tool>;
  // Converting the zod schemas to JSON schema costs a few milliseconds for the
  // whole set and never changes, so it is done once per server.
  private _mcpTools: mcpServer.Tool[] | undefined;
  private _context: Context | undefined;
  private _sessionRegistry: BrowserSessionRegistry | undefined;
  private _sessionLog: SessionLog | undefined;
  private _config: FullConfig;
  private _browserContextFactory: BrowserContextFactory;
  private _sharedSessionRegistry: BrowserSessionRegistry | undefined;

  constructor(config: FullConfig, factory: BrowserContextFactory, sharedSessionRegistry?: BrowserSessionRegistry) {
    this._config = config;
    this._browserContextFactory = factory;
    this._sharedSessionRegistry = sharedSessionRegistry;
    this._tools = filteredTools(config);
    this._toolsByName = new Map(this._tools.map(tool => [tool.schema.name, tool]));
  }

  async initialize(_context: mcpServer.ServerBackendContext, clientVersion: mcpServer.ClientVersion): Promise<void> {
    this._sessionLog = this._config.saveSession ? await SessionLog.create(this._config) : undefined;
    const createContext = (browserSession?: boolean) => new Context({
      tools: this._tools,
      config: this._config,
      browserContextFactory: this._browserContextFactory,
      sessionLog: this._sessionLog,
      clientInfo: { ...clientVersion },
      browserSessions: this._sessionRegistry,
      browserSession,
    });
    // Registry contexts are flagged as explicit sessions so the factory can
    // give each its own browser context (e.g. a disposable persistent
    // profile); the default context keeps today's behavior. Factories that
    // cannot separate contexts veto browser_session_open via their reason.
    // A registry shared across the backends of one server factory (stateless
    // HTTP creates a fresh backend per request, and a handle minted in one
    // request must resolve in the next) is rebound instead of replaced.
    if (this._sharedSessionRegistry) {
      this._sharedSessionRegistry.bind(() => createContext(true), this._browserContextFactory.sessionsUnsupportedReason);
      this._sessionRegistry = this._sharedSessionRegistry;
    } else {
      this._sessionRegistry = new BrowserSessionRegistry(() => createContext(true), undefined, this._browserContextFactory.sessionsUnsupportedReason);
    }
    this._context = createContext();
  }

  async listTools(): Promise<mcpServer.Tool[]> {
    this._mcpTools ??= this._tools.map(tool => {
      const mcpTool = toMcpTool(tool.schema);
      // Advertise the session-routing parameter resolved in callTool(). It is
      // added to the wire schema only: the tools' own zod schemas (all
      // non-strict objects) simply strip it during parsing, so tool
      // implementations never see it. The session tools themselves are
      // excluded — they operate *on* sessions, not *in* them.
      if (tool.schema.name !== 'browser_session_open' && tool.schema.name !== 'browser_session_close') {
        const inputSchema = mcpTool.inputSchema as { properties?: Record<string, unknown> };
        inputSchema.properties = {
          ...inputSchema.properties,
          browserSessionId: {
            type: 'string',
            description: 'Browser session to run this tool in, as returned by browser_session_open. Omit to use the default session.',
          },
        };
      }
      return mcpTool;
    });
    return this._mcpTools;
  }

  async callTool(name: string, rawArguments: mcpServer.CallToolRequest['params']['arguments'], requestContext?: mcpServer.CallToolRequestContext) {
    const tool = this._toolsByName.get(name);
    if (!tool)
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool "${name}" not found`);
    // Resolved before the schema parse so an unknown handle surfaces as a
    // clear execution error, like other input validation failures below.
    const routedSessionId = this._routedSessionId(name, rawArguments);
    const context = routedSessionId !== undefined ? this._sessionRegistry!.resolve(routedSessionId) : this._context!;
    let parsedArguments: Record<string, any>;
    try {
      parsedArguments = tool.schema.inputSchema.parse(rawArguments || {}) as Record<string, any>;
    } catch (error) {
      // Per the MCP spec, input validation failures are tool execution
      // errors (isError results), not protocol errors.
      if (error instanceof z.ZodError)
        throw new Error(`Invalid input for tool "${name}":\n${z.prettifyError(error)}`);
      throw error;
    }
    // The wire-only browserSessionId never survives the parse above (the
    // tools' non-strict zod schemas strip it), which is right for the tool
    // handler — but Response.toolArgs feeds the --save-session log, and
    // without the handle, calls into different sessions would log identical
    // sessionless args with interleaved snapshots. Re-attach it to the logged
    // view; handlers keep receiving parsedArguments untouched.
    const responseArguments = routedSessionId !== undefined ? { browserSessionId: routedSessionId, ...parsedArguments } : parsedArguments;
    const response = new Response(context, name, responseArguments, requestContext);
    // Per-call token, not a single slot: two overlapping calls on one session
    // must keep isRunningTool() true until BOTH finish, or the TTL reaper (and
    // browser_session_close) could dispose the browser under the slower call.
    const endToolCall = context.beginToolCall(name);
    try {
      await tool.handle(context, parsedArguments, response);
      await response.finish();
      this._sessionLog?.logResponse(response);
    } catch (error: any) {
      response.addError(String(error));
    } finally {
      endToolCall();
      // Refresh after completion too: a long run must not leave the session
      // one reaper tick from expiry.
      if (routedSessionId !== undefined)
        this._sessionRegistry?.touch(routedSessionId);
    }
    return response.serialize();
  }

  /**
   * The optional `browserSessionId` argument selects which registry Context a
   * tool runs in; without it (or before any session exists) the default
   * Context preserves the pre-#167 behavior exactly. The session tools are
   * exempt: `browser_session_close` takes `browserSessionId` as its own
   * argument naming the session to close — running it *inside* that session
   * would dispose the context out from under the running tool — and both
   * always execute on the default Context.
   */
  private _routedSessionId(name: string, rawArguments: mcpServer.CallToolRequest['params']['arguments']): string | undefined {
    if (name === 'browser_session_open' || name === 'browser_session_close')
      return undefined;
    const id = rawArguments?.browserSessionId;
    if (id === undefined)
      return undefined;
    if (typeof id !== 'string')
      throw new Error('Invalid browserSessionId: expected a string handle returned by browser_session_open.');
    return id;
  }

  serverClosed() {
    // A shared registry outlives any one backend — over stateless HTTP the
    // per-request server closes after every response, and disposing the
    // registry with it would kill the very sessions the handles exist for.
    // Its sessions are reaped by their idle TTL, closed explicitly, or
    // disposed at process exit; only an owned registry is disposed here.
    if (this._sessionRegistry && this._sessionRegistry !== this._sharedSessionRegistry)
      void this._sessionRegistry.disposeAll().catch(logUnhandledError);
    void this._context?.dispose().catch(logUnhandledError);
  }
}
