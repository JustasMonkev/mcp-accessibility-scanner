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
    this._mcpTools ??= this._tools.map(tool => {
      const mcpTool = toMcpTool(tool.schema);
      if (tool.schema.name !== 'browser_session_open' && tool.schema.name !== 'browser_session_close') {
        const inputSchema = mcpTool.inputSchema;
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
    const id = webMCPSessionId(requestContext?._meta);
    if (!this._context && id === undefined)
      return this._mcpTools;
    if (id !== undefined && !this._sessionRegistry)
      throw new Error('Initialize the browser backend before listing session tools.');
    const context = id === undefined ? this._context! : this._sessionRegistry!.resolve(id);
    const endSessionHold = context.beginSessionHold();
    try {
      requestContext?.signal?.throwIfAborted();
      let dynamic: WebMCPToolDefinition[] = [];
      try {
        if (context === this._context && this._browserContextFactory.sharedContext && !this._browserContextFactory.attachNeedsUser && !context.currentTab())
          await rejectOnAbort(() => context.ensureTab(requestContext?.signal), requestContext?.signal);
        dynamic = await this._currentWebMCPTools(context, requestContext?.signal, true);
      } catch (error) {
        requestContext?.signal?.throwIfAborted();
        logUnhandledError(error);
      }
      requestContext?.signal?.throwIfAborted();
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
    const context = id === undefined ? this._context! : this._sessionRegistry!.resolve(id);
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
      const sessionLog = id === undefined ? await this._ensureSessionLog() : await context.resolveSessionLog();
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
    const context = routedSessionId !== undefined ? this._sessionRegistry!.resolve(routedSessionId) : this._context!;
    let parsedArguments: Record<string, any>;
    try {
      parsedArguments = tool.schema.inputSchema.parse(rawArguments || {}) as Record<string, any>;
    } catch (error) {
      if (error instanceof z.ZodError)
        throw new Error(`Invalid input for tool "${name}":\n${z.prettifyError(error)}`);
      throw error;
    }
    const responseArguments = routedSessionId !== undefined ? { browserSessionId: routedSessionId, ...parsedArguments } : parsedArguments;
    let closingSessionContext: Context | undefined;
    if (name === 'browser_session_close' && typeof parsedArguments.browserSessionId === 'string') {
      try {
        closingSessionContext = this._sessionRegistry!.resolve(parsedArguments.browserSessionId);
      } catch {}
    }
    const response = new Response(context, name, responseArguments, requestContext, context.currentTab()?.modalStates());
    const endToolCall = context.beginToolCall(name);
    try {
      if (name !== 'browser_close' && name !== 'browser_session_open' && name !== 'browser_session_close') {
        const idleNotice = await context.resumeAfterIdle();
        if (idleNotice)
          response.addNotice(idleNotice);
      }
      await tool.handle(context, parsedArguments, response, requestContext?.signal);
      await response.finish();
      if (name === 'browser_session_close') {
        for (const error of closingSessionContext?.takeDownloadErrors() ?? [])
          response.addError(truncateDataUrls(error));
        try {
          const sessionLog = await closingSessionContext?.resolveSessionLog();
          sessionLog?.logResponse(response);
        } catch (error) {
          logUnhandledError(error);
        }
      } else {
        const sessionLog = routedSessionId !== undefined ? await context.resolveSessionLog() : await this._ensureSessionLog();
        sessionLog?.logResponse(response);
      }
    } catch (error) {
      try {
        await response.cleanupFilesOnError();
      } catch (cleanupError) {
        logUnhandledError(cleanupError);
      }
      response.addError(String(error));
    } finally {
      endToolCall();
      if (routedSessionId !== undefined)
        this._sessionRegistry?.touch(routedSessionId);
    }
    void this._webmcpObserver?.refresh();
    return response.serialize();
  }

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
    this._closed = true;
    this._webmcpObserver?.dispose();
    this._webmcpObserver = undefined;
    if (this._sessionRegistry && this._sessionRegistry !== this._sharedSessionRegistry)
      void this._sessionRegistry.disposeAll().catch(logUnhandledError);
    void this._context?.dispose().catch(logUnhandledError);
  }
}
