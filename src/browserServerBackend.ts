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
  private _sessionLog: Promise<SessionLog | undefined> | undefined;
  private _config: FullConfig;
  private _browserContextFactory: BrowserContextFactory;
  private _sharedSessionRegistry: BrowserSessionRegistry | undefined;
  private _ephemeralDefaultContext: boolean;

  constructor(config: FullConfig, factory: BrowserContextFactory, sharedSessionRegistry?: BrowserSessionRegistry, options?: {
    /**
     * True for backends that serve exactly one stateless HTTP exchange and
     * are closed with the response. Their default context is flagged like an
     * explicit browser session, so the persistent factory runs it in a
     * disposable profile: parallel handshake-free requests would otherwise
     * contend for the stable `mcp-<browser>` profile ("Browser is already in
     * use"), and a context torn down at response end gains nothing from
     * profile persistence — cross-request browser state belongs to
     * browser_session_open handles. Stateful backends (stdio, HTTP sessions)
     * keep the stable profile.
     */
    ephemeralDefaultContext?: boolean;
  }) {
    this._config = config;
    this._browserContextFactory = factory;
    this._sharedSessionRegistry = sharedSessionRegistry;
    this._ephemeralDefaultContext = options?.ephemeralDefaultContext ?? false;
    this._tools = filteredTools(config);
    this._toolsByName = new Map(this._tools.map(tool => [tool.schema.name, tool]));
  }

  async initialize(_context: mcpServer.ServerBackendContext, clientVersion: mcpServer.ClientVersion): Promise<void> {
    // A registry shared across the backends of one server factory (stateless
    // HTTP creates a fresh backend per request, and a handle minted in one
    // request must resolve in the next) outlives this backend; an owned one
    // is disposed with it in serverClosed().
    const registry = this._sharedSessionRegistry ?? new BrowserSessionRegistry();
    this._sessionRegistry = registry;
    // Registry contexts are flagged as explicit sessions so the factory can
    // give each its own browser context (e.g. a disposable persistent
    // profile); the default context keeps today's behavior. Factories that
    // cannot separate contexts veto browser_session_open via their reason.
    // The context constructor is handed to the registry per open() call —
    // through this backend's own broker slice — never bound registry-wide: a
    // shared registry serves several live backends at once, and a global
    // rebind would mint sessions with whichever backend initialized last,
    // leaking that client's identity (clientInfo, SessionLog) into sessions
    // other clients open.
    const createContext = (browserSession?: boolean, browserSessionId?: string): Context => new Context({
      tools: this._tools,
      config: this._config,
      browserContextFactory: this._browserContextFactory,
      sessionLog: () => this._ensureSessionLog(),
      clientInfo: { ...clientVersion },
      browserSessions: {
        open: async () => {
          // The unsupported-mode veto comes before everything else: it is
          // registry.open()'s own first check, but by then the session-log
          // await below would already have run — in modes that reject
          // sessions outright (extension, VS Code, non-isolated CDP, pinned
          // cdp-launch port, --user-data-dir) every doomed attempt minted
          // and announced an empty session-* directory the rejection never
          // even landed in.
          BrowserSessionRegistry.checkSessionsSupported(this._browserContextFactory.sessionsUnsupportedReason);
          // Resolved BEFORE the handle is minted: the session log is this
          // backend's one fallible piece of open() setup (an uncreatable
          // --output-dir rejects SessionLog.create()), and it used to be
          // awaited only after the tool had already registered the Context —
          // the error result carried no handle to close, so every retry
          // accumulated another live session until TTL reaping. Failing
          // first leaves nothing half-registered, and callTool() would have
          // created this same backend-wide log right after the call anyway.
          await this._ensureSessionLog();
          return registry.open(id => createContext(true, id), this._browserContextFactory.sessionsUnsupportedReason);
        },
        close: id => registry.close(id),
      },
      browserSession,
      browserSessionId,
    });
    this._context = createContext(this._ephemeralDefaultContext || undefined);
  }

  /**
   * Creates the `--save-session` log on first demand, once per backend.
   * Eager creation at initialize() littered the output directory over
   * stateless HTTP, where every request builds a fresh backend: a tools/list
   * or a call routed to an existing browser session minted (and announced)
   * an empty session-* folder per request. The default context and every
   * session this backend opens share this one lazy log — via the supplier
   * handed to createContext above — so recorder entries and tool responses
   * land in the same folder regardless of which context launches first.
   */
  private _ensureSessionLog(): Promise<SessionLog | undefined> {
    if (!this._sessionLog) {
      const creation = this._config.saveSession ? SessionLog.create(this._config) : Promise.resolve(undefined);
      // Memoize success only: a rejected create (e.g. the output volume
      // briefly unavailable) must not be replayed to every later default-
      // context call and browser_session_open for the backend's lifetime —
      // clear the memo so the next call retries. Guarded by identity, like
      // ensureInitialized in mcp/server.ts: a retry may already have stored a
      // fresh in-flight promise by the time this failure handler runs, and
      // that one must not be clobbered. Everyone who awaited the failed
      // attempt still sees its rejection.
      creation.catch(() => {
        if (this._sessionLog === creation)
          this._sessionLog = undefined;
      });
      this._sessionLog = creation;
    }
    return this._sessionLog;
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
      // A routed call belongs to the session's own log — resolved through the
      // supplier captured from the backend that opened it, which over
      // stateless HTTP is not this one. Resolving (not just reading the
      // cached field) matters when the routed call is the session's first and
      // needs no browser: the field is only populated at browser launch, so a
      // browser_default_timeout opening move would otherwise never be logged.
      // A default-context call is a real use of THIS backend, so it may
      // create the backend's log on first demand.
      const sessionLog = routedSessionId !== undefined ? await context.resolveSessionLog() : await this._ensureSessionLog();
      sessionLog?.logResponse(response);
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
