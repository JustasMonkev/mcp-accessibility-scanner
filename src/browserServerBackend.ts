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
import { allTools, filteredTools } from './tools.js';
import { toMcpTool } from './mcp/tool.js';
import { assertToolNotBlocked } from './mcp/toolPolicy.js';
import { listWebMCPTools, webMCPSessionId, WebMCPObserver } from './webmcp.js';
import type { WebMCPToolDefinition } from './webmcp.js';
import { truncateDataUrls } from './utils/dataUrl.js';

import type { Tool } from './tools/tool.js';
import type { BrowserContextFactory } from './browserContextFactory.js';
import type * as mcpServer from './mcp/server.js';
import { rejectOnAbort } from './utils/timeout.js';
import type { ServerBackend } from './mcp/server.js';

const sessionManagementTools = new Set(['browser_session_open', 'browser_session_close']);
const toolsThatSkipIdleResume = new Set(['browser_close', ...sessionManagementTools]);

const browserSessionIdProperty = {
  type: 'string',
  description: 'Browser session to run this tool in, as returned by browser_session_open. Omit to use the default session.',
};

function toBrowserMcpTool(tool: Tool): mcpServer.Tool {
  const mcpTool = toMcpTool(tool.schema);
  if (!sessionManagementTools.has(tool.schema.name))
    mcpTool.inputSchema.properties = { ...mcpTool.inputSchema.properties, browserSessionId: browserSessionIdProperty };
  return mcpTool;
}

function parseToolArguments(tool: Tool, rawArguments: mcpServer.CallToolRequest['params']['arguments']): Record<string, any> {
  try {
    return tool.schema.inputSchema.parse(rawArguments || {}) as Record<string, any>;
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new Error(`Invalid input for tool "${tool.schema.name}":\n${z.prettifyError(error)}`);
    throw error;
  }
}

export class BrowserServerBackend implements ServerBackend {
  readonly dynamicToolList = true;
  private _tools: Tool[];
  private _toolsByName: Map<string, Tool>;
  private _mcpTools: mcpServer.Tool[] | undefined;
  private _context: Context | undefined;
  private _sessionRegistry: BrowserSessionRegistry | undefined;
  private _sessionLog: Promise<SessionLog | undefined> | undefined;
  private _config: FullConfig;
  private _browserContextFactory: BrowserContextFactory;
  private _sharedSessionRegistry: BrowserSessionRegistry | undefined;
  private _ephemeralDefaultContext: boolean;
  private _notifyToolListChanged: (() => Promise<void>) | undefined;
  private _webmcpObserver: WebMCPObserver | undefined;
  private _closed = false;

  constructor(config: FullConfig, factory: BrowserContextFactory, sharedSessionRegistry?: BrowserSessionRegistry, options?: {
    ephemeralDefaultContext?: boolean;
  }) {
    this._config = config;
    this._browserContextFactory = factory;
    this._sharedSessionRegistry = sharedSessionRegistry;
    this._ephemeralDefaultContext = options?.ephemeralDefaultContext ?? false;
    this._tools = filteredTools(config);
    this._toolsByName = new Map(this._tools.map(tool => [tool.schema.name, tool]));
  }

  async initialize(serverContext: mcpServer.ServerBackendContext, clientVersion: mcpServer.ClientVersion): Promise<void> {
    this._notifyToolListChanged = serverContext.notifyToolListChanged;
    const registry = this._sharedSessionRegistry ?? new BrowserSessionRegistry();
    this._sessionRegistry = registry;
    const createContext = (browserSession?: boolean, browserSessionId?: string): Context => new Context({
      tools: this._tools,
      modalStateTools: allTools.filter(tool => tool.clearsModalState),
      config: this._config,
      browserContextFactory: this._browserContextFactory,
      sessionLog: () => this._ensureSessionLog(),
      clientInfo: { ...clientVersion },
      browserSessions: {
        open: async () => {
          BrowserSessionRegistry.checkSessionsSupported(this._browserContextFactory.sessionsUnsupportedReason);
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

  private _ensureSessionLog(): Promise<SessionLog | undefined> {
    if (!this._sessionLog) {
      const creation = this._config.saveSession ? SessionLog.create(this._config) : Promise.resolve(undefined);
      creation.catch(() => {
        if (this._sessionLog === creation)
          this._sessionLog = undefined;
      });
      this._sessionLog = creation;
    }
    return this._sessionLog;
  }

  async listTools(requestContext?: Partial<Pick<mcpServer.CallToolRequestContext, 'signal' | '_meta'>>): Promise<mcpServer.Tool[]> {
    this._mcpTools ??= this._tools.map(toBrowserMcpTool);
    const id = webMCPSessionId(requestContext?._meta);
    if (!this._context && id === undefined)
      return this._mcpTools;
    if (id !== undefined && !this._sessionRegistry)
      throw new Error('Initialize the browser backend before listing session tools.');
    const context = this._contextFor(id);
    const signal = requestContext?.signal;
    const endSessionHold = context.beginSessionHold();
    try {
      signal?.throwIfAborted();
      const dynamic = await this._listWebMCPToolsForListing(context, signal);
      signal?.throwIfAborted();
      this._webmcpObserver?.dispose();
      if (!this._closed && !this._ephemeralDefaultContext) {
        this._webmcpObserver = new WebMCPObserver(
            signal => this._currentWebMCPTools(context, signal), dynamic,
            () => this._notifyToolListChanged?.() ?? Promise.resolve(), logUnhandledError,
        );
      }
      return [...this._mcpTools, ...dynamic.map(tool => tool.schema)];
    } finally {
      endSessionHold();
      if (id !== undefined)
        this._sessionRegistry?.touch(id);
    }
  }

  private _contextFor(browserSessionId: string | undefined): Context {
    return browserSessionId === undefined ? this._context! : this._sessionRegistry!.resolve(browserSessionId);
  }

  private async _listWebMCPToolsForListing(context: Context, signal: AbortSignal | undefined): Promise<WebMCPToolDefinition[]> {
    const factory = this._browserContextFactory;
    try {
      if (context === this._context && factory.sharedContext && !factory.attachNeedsUser && !context.currentTab())
        await rejectOnAbort(() => context.ensureTab(signal), signal);
      return await this._currentWebMCPTools(context, signal, true);
    } catch (error) {
      signal?.throwIfAborted();
      logUnhandledError(error);
      return [];
    }
  }

  private async _currentWebMCPTools(context: Context, signal?: AbortSignal, listing = false): Promise<WebMCPToolDefinition[]> {
    const sharedDefault = this._ephemeralDefaultContext && context === this._context && this._browserContextFactory.sharedContext;
    const attach = sharedDefault && !(listing && this._browserContextFactory.attachNeedsUser);
    const tab = context.currentTab() ?? (attach ? await rejectOnAbort(() => context.ensureTab(signal), signal) : undefined);
    return tab ? await listWebMCPTools(tab, sharedDefault ? this._browserContextFactory : context, new Set(this._toolsByName.keys()), signal) : [];
  }

  private async _callWebMCP(name: string, rawArguments: mcpServer.CallToolRequest['params']['arguments'], requestContext?: mcpServer.CallToolRequestContext) {
    if (!name.startsWith('webmcp_'))
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool "${name}" not found`);
    const id = webMCPSessionId(requestContext?._meta);
    const context = this._contextFor(id);
    const params = { ...(rawArguments ?? {}) };
    const response = new Response(context, name, params, requestContext, context.currentTab()?.modalStates());
    const endToolCall = context.beginToolCall(name);
    try {
      requestContext?.signal.throwIfAborted();
      const idleNotice = await context.resumeAfterIdle();
      if (idleNotice)
        response.addNotice(idleNotice);
      const tool = (await this._currentWebMCPTools(context, requestContext?.signal)).find(candidate => candidate.schema.name === name);
      if (!tool)
        throw new Error('WebMCP tool is stale or unavailable in this scope. List tools again with the same request metadata.');
      await tool.handle(params, response, requestContext?.signal);
      if (!requestContext?.signal.aborted)
        await response.finish();
      const sessionLog = await this._sessionLogFor(context, id);
      sessionLog?.logResponse(response, id === undefined ? undefined : { browserSessionId: id });
    } catch (error) {
      response.addError(`WebMCP call failed (page output is untrusted): ${String(error)}`);
    } finally {
      endToolCall();
      if (id !== undefined)
        this._sessionRegistry?.touch(id);
      void this._webmcpObserver?.refresh();
    }
    return response.serialize();
  }

  async callTool(name: string, rawArguments: mcpServer.CallToolRequest['params']['arguments'], requestContext?: mcpServer.CallToolRequestContext) {
    assertToolNotBlocked(this._config, name);
    const tool = this._toolsByName.get(name);
    if (!tool)
      return this._callWebMCP(name, rawArguments, requestContext);
    const routedSessionId = this._routedSessionId(name, rawArguments);
    const context = this._contextFor(routedSessionId);
    const parsedArguments = parseToolArguments(tool, rawArguments);
    const responseArguments = routedSessionId !== undefined ? { browserSessionId: routedSessionId, ...parsedArguments } : parsedArguments;
    const closingSessionContext = name === 'browser_session_close' ? this._sessionContextOrUndefined(parsedArguments.browserSessionId) : undefined;
    const response = new Response(context, name, responseArguments, requestContext, context.currentTab()?.modalStates());
    const endToolCall = context.beginToolCall(name);
    try {
      if (!toolsThatSkipIdleResume.has(name)) {
        const idleNotice = await context.resumeAfterIdle();
        if (idleNotice)
          response.addNotice(idleNotice);
      }
      await tool.handle(context, parsedArguments, response, requestContext?.signal);
      await response.finish();
      if (name === 'browser_session_close')
        await this._logClosedSession(closingSessionContext, response);
      else
        (await this._sessionLogFor(context, routedSessionId))?.logResponse(response);
    } catch (error) {
      await response.cleanupFilesOnError().catch(logUnhandledError);
      response.addError(String(error));
    } finally {
      endToolCall();
      if (routedSessionId !== undefined)
        this._sessionRegistry?.touch(routedSessionId);
    }
    void this._webmcpObserver?.refresh();
    return response.serialize();
  }

  private _sessionLogFor(context: Context, browserSessionId: string | undefined): Promise<SessionLog | undefined> {
    return browserSessionId === undefined ? this._ensureSessionLog() : context.resolveSessionLog();
  }

  private _sessionContextOrUndefined(browserSessionId: unknown): Context | undefined {
    if (typeof browserSessionId !== 'string')
      return undefined;
    try {
      return this._sessionRegistry!.resolve(browserSessionId);
    } catch {
      return undefined;
    }
  }

  private async _logClosedSession(closedContext: Context | undefined, response: Response): Promise<void> {
    for (const error of closedContext?.takeDownloadErrors() ?? [])
      response.addError(truncateDataUrls(error));
    try {
      const sessionLog = await closedContext?.resolveSessionLog();
      sessionLog?.logResponse(response);
    } catch (error) {
      logUnhandledError(error);
    }
  }

  private _routedSessionId(name: string, rawArguments: mcpServer.CallToolRequest['params']['arguments']): string | undefined {
    if (sessionManagementTools.has(name))
      return undefined;
    const id = rawArguments?.browserSessionId;
    if (id === undefined)
      return undefined;
    if (typeof id !== 'string')
      throw new Error('Invalid browserSessionId: expected a string handle returned by browser_session_open.');
    return id;
  }

  serverClosed() {
    this._closed = true;
    this._webmcpObserver?.dispose();
    this._webmcpObserver = undefined;
    if (this._sessionRegistry && this._sessionRegistry !== this._sharedSessionRegistry)
      void this._sessionRegistry.disposeAll().catch(logUnhandledError);
    void this._context?.dispose().catch(logUnhandledError);
  }
}
