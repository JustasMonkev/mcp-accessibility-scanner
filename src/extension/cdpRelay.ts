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

/**
 * WebSocket server that bridges Playwright MCP and Chrome Extension
 *
 * Endpoints:
 * - /cdp/guid - Full CDP interface for Playwright MCP
 * - /extension/guid - Extension connection for chrome.debugger forwarding
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import debug from 'debug';
import { WebSocket, WebSocketServer } from 'ws';
import { httpAddressToString } from '../mcp/http.js';
import { logUnhandledError } from '../utils/log.js';
import { ManualPromise } from '../mcp/manualPromise.js';
import { ExtensionProtocolV2 } from './cdpRelayV2.js';
import * as protocol from './protocol.js';

import type websocket from 'ws';
import type { ClientInfo } from '../browserContextFactory.js';
import type { CDPMessage } from './browserModel.js';
import type { ExtensionCommandV2, ExtensionEventsV2 } from './protocol.js';

// @ts-ignore -- internal bundle entry point exposed via package exports
const coreBundle = (await import('playwright-core/lib/coreBundle')).default;
const { registry } = coreBundle.registry;

const debugLogger = debug('pw:mcp:relay');

type CDPCommand = {
  id: number;
  sessionId?: string;
  method: string;
  params?: any;
};

type CDPResponse = CDPMessage;

export class CDPRelayServer {
  private _wsHost: string;
  private _browserChannel: string;
  private _userDataDir?: string;
  private _executablePath?: string;
  private _cdpPath: string;
  private _extensionPath: string;
  private _connectPagePrefix: string;
  private _wss: WebSocketServer;
  private _playwrightConnection: WebSocket | null = null;
  private _extensionConnection: ExtensionConnection | null = null;
  private _handler!: ExtensionProtocolV2;
  private _extensionConnectionPromise!: ManualPromise<void>;

  constructor(server: http.Server, browserChannel: string, userDataDir?: string, executablePath?: string) {
    this._wsHost = httpAddressToString(server.address()).replace(/^http/, 'ws');
    this._browserChannel = browserChannel;
    this._userDataDir = userDataDir;
    this._executablePath = executablePath;

    const uuid = crypto.randomUUID();
    this._cdpPath = `/cdp/${uuid}`;
    this._extensionPath = `/extension/${uuid}`;
    const connectPageUrl = new URL(`chrome-extension://${protocol.EXTENSION_ID}/connect.html`);
    connectPageUrl.searchParams.set('mcpRelayUrl', this.extensionEndpoint());
    this._connectPagePrefix = connectPageUrl.toString();

    this._resetExtensionConnection();
    this._wss = new WebSocketServer({ server });
    this._wss.on('connection', this._onConnection.bind(this));
  }

  cdpEndpoint() {
    return `${this._wsHost}${this._cdpPath}`;
  }

  extensionEndpoint() {
    return `${this._wsHost}${this._extensionPath}`;
  }

  async ensureExtensionConnectionForMCPContext(clientInfo: ClientInfo, abortSignal: AbortSignal, _toolName: string | undefined) {
    debugLogger('Ensuring extension connection for MCP context');
    if (abortSignal.aborted)
      throw abortSignal.reason;
    // Protocol v2 requires explicit tab selection; the legacy newTab hint hides its only approval controls.
    if (!this._extensionConnection)
      await this._connectBrowser(clientInfo);
    debugLogger('Waiting for incoming extension connection');
    // Manual approval is intentionally unbounded; callers cancel it through the abort signal.
    await Promise.race([
      Promise.all([this._extensionConnectionPromise, this._handler.ready()]),
      new Promise((_, reject) => abortSignal.addEventListener('abort', reject))
    ]);
    debugLogger('Extension connection established');
  }

  private async _connectBrowser(clientInfo: ClientInfo) {
    // Need to specify "key" in the manifest.json to make the id stable when loading from file.
    const url = new URL(this._connectPagePrefix);
    const client = {
      name: clientInfo.name,
      version: clientInfo.version,
    };
    url.searchParams.set('client', JSON.stringify(client));
    url.searchParams.set('protocolVersion', process.env.PWMCP_TEST_PROTOCOL_VERSION ?? protocol.VERSION.toString());
    const token = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    if (token)
      url.searchParams.set('token', token);
    const href = url.toString();

    let executablePath = this._executablePath;
    if (!executablePath) {
      const executableInfo = registry.findExecutable(this._browserChannel);
      if (!executableInfo)
        throw new Error(`Unsupported channel: "${this._browserChannel}"`);
      executablePath = executableInfo.executablePath();
      if (!executablePath)
        throw new Error(`"${this._browserChannel}" executable not found. Make sure it is installed at a standard location.`);
    }

    const args: string[] = [];
    if (this._userDataDir) {
      args.push(`--user-data-dir=${this._userDataDir}`);
      const profileDirectory = await findPlaywrightExtensionProfile(this._userDataDir);
      if (profileDirectory)
        args.push(`--profile-directory=${profileDirectory}`);
    }
    args.push(href);

    spawn(executablePath, args, {
      windowsHide: true,
      detached: true,
      shell: false,
      stdio: 'ignore',
    });
  }

  stop(): void {
    this.closeConnections('Server stopped');
    this._wss.close();
  }

  closeConnections(reason: string) {
    this._closePlaywrightConnection(reason);
    this._closeExtensionConnection(reason);
  }

  private _onConnection(ws: WebSocket, request: http.IncomingMessage): void {
    const url = new URL(`http://localhost${request.url}`);
    debugLogger(`New connection to ${url.pathname}`);
    if (url.pathname === this._cdpPath) {
      this._handlePlaywrightConnection(ws);
    } else if (url.pathname === this._extensionPath) {
      this._handleExtensionConnection(ws);
    } else {
      debugLogger(`Invalid path: ${url.pathname}`);
      ws.close(4004, 'Invalid path');
    }
  }

  private _handlePlaywrightConnection(ws: WebSocket): void {
    if (!this._extensionConnection) {
      debugLogger('Rejecting Playwright connection: extension not connected');
      ws.close(1000, 'Extension not connected');
      return;
    }
    if (this._playwrightConnection) {
      debugLogger('Rejecting second Playwright connection');
      ws.close(1000, 'Another CDP client already connected');
      return;
    }
    this._playwrightConnection = ws;
    this._handler.connectOverCDP(message => this._sendToPlaywright(message));
    ws.on('message', async data => {
      try {
        const message = JSON.parse(data.toString());
        await this._handlePlaywrightMessage(message);
      } catch (error: any) {
        debugLogger(`Error while handling Playwright message\n${data.toString()}\n`, error);
      }
    });
    ws.on('close', () => {
      if (this._playwrightConnection !== ws)
        return;
      this._playwrightConnection = null;
      this._closeExtensionConnection('Playwright client disconnected');
      debugLogger('Playwright WebSocket closed');
    });
    ws.on('error', error => {
      debugLogger('Playwright WebSocket error:', error);
    });
    debugLogger('Playwright MCP connected');
  }

  private _closeExtensionConnection(reason: string) {
    this._extensionConnection?.close(reason);
    if (!this._extensionConnectionPromise.isDone())
      this._extensionConnectionPromise.reject(new Error(reason));
    this._handler.onExtensionDisconnect(reason);
    this._resetExtensionConnection();
  }

  private _resetExtensionConnection() {
    this._extensionConnection = null;
    this._extensionConnectionPromise = new ManualPromise<void>();
    void this._extensionConnectionPromise.catch(logUnhandledError);
    this._handler = new ExtensionProtocolV2((method, params) => {
      if (!this._extensionConnection)
        throw new Error('Extension not connected');
      return this._extensionConnection.send(method as keyof ExtensionCommandV2, params);
    }, this._connectPagePrefix);
  }

  private _closePlaywrightConnection(reason: string) {
    if (this._playwrightConnection?.readyState === WebSocket.OPEN)
      this._playwrightConnection.close(1000, reason);
    this._playwrightConnection = null;
  }

  private _handleExtensionConnection(ws: WebSocket): void {
    if (this._extensionConnection) {
      ws.close(1000, 'Another extension connection already established');
      return;
    }
    const connection = new ExtensionConnection(ws);
    const handler = this._handler;
    this._extensionConnection = connection;
    connection.onclose = reason => {
      if (this._extensionConnection !== connection)
        return;
      debugLogger('Extension WebSocket closed:', reason);
      handler.onExtensionDisconnect(reason);
      this._closePlaywrightConnection(`Extension disconnected: ${reason}`);
      this._resetExtensionConnection();
    };
    connection.onmessage = (method, params) => handler.handleExtensionEvent(method, params);
    this._extensionConnectionPromise.resolve();
  }

  private async _handlePlaywrightMessage(message: CDPCommand): Promise<void> {
    debugLogger('← Playwright:', `${message.method} (id=${message.id})`);
    const { id, sessionId, method, params } = message;
    try {
      const result = await this._handleCDPCommand(method, params, sessionId);
      this._sendToPlaywright({ id, sessionId, result });
    } catch (e) {
      debugLogger('Error in the extension:', e);
      this._sendToPlaywright({
        id,
        sessionId,
        error: { message: (e as Error).message }
      });
    }
  }

  private async _handleCDPCommand(method: string, params: any, sessionId: string | undefined): Promise<any> {
    switch (method) {
      case 'Browser.getVersion': {
        return {
          protocolVersion: '1.3',
          product: 'Chrome/Extension-Bridge',
          userAgent: 'CDP-Bridge-Server/1.0.0',
        };
      }
      case 'Browser.setDownloadBehavior': {
        return { };
      }
    }
    const handled = await this._handler.handleCDPCommand(method, params, sessionId);
    if (handled)
      return handled.result;
    return await this._handler.forwardToExtension(method, params, sessionId);
  }

  private _sendToPlaywright(message: CDPResponse): void {
    debugLogger('→ Playwright:', `${message.method ?? `response(id=${message.id})`}`);
    this._playwrightConnection?.send(JSON.stringify(message));
  }
}

async function findPlaywrightExtensionProfile(userDataDir: string): Promise<string | undefined> {
  let profiles: string[];
  try {
    profiles = (await fs.readdir(userDataDir, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)))
        .map(entry => entry.name)
        .sort((a, b) => a === 'Default' ? -1 : b === 'Default' ? 1 : parseInt(a.slice(8), 10) - parseInt(b.slice(8), 10));
  } catch {
    return;
  }

  try {
    const localState = JSON.parse(await fs.readFile(path.join(userDataDir, 'Local State'), 'utf8'));
    const lastUsed = localState?.profile?.last_used;
    if (typeof lastUsed === 'string' && profiles.includes(lastUsed))
      profiles = [lastUsed, ...profiles.filter(profile => profile !== lastUsed)];
  } catch {
    // Fall back to the deterministic profile order when Local State is unavailable.
  }

  for (const profile of profiles) {
    try {
      await fs.access(path.join(userDataDir, profile, 'Extensions', protocol.EXTENSION_ID));
      return profile;
    } catch {
      continue;
    }
  }
}

type ExtensionResponse = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: string;
};

class ExtensionConnection {
  private readonly _ws: WebSocket;
  private readonly _callbacks = new Map<number, { resolve: (o: any) => void, reject: (e: Error) => void, error: Error }>();
  private _lastId = 0;

  onmessage?: <M extends keyof ExtensionEventsV2>(method: M, params: ExtensionEventsV2[M]['params']) => void;
  onclose?: (reason: string) => void;

  constructor(ws: WebSocket) {
    this._ws = ws;
    this._ws.on('message', this._onMessage.bind(this));
    this._ws.on('close', this._onClose.bind(this));
    this._ws.on('error', this._onError.bind(this));
  }

  async send<M extends keyof ExtensionCommandV2>(method: M, params: ExtensionCommandV2[M]['params']): Promise<any> {
    if (this._ws.readyState !== WebSocket.OPEN)
      throw new Error(`Unexpected WebSocket state: ${this._ws.readyState}`);
    const id = ++this._lastId;
    this._ws.send(JSON.stringify({ id, method, params }));
    const error = new Error(`Protocol error: ${method}`);
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, { resolve, reject, error });
    });
  }

  close(message: string) {
    debugLogger('closing extension connection:', message);
    if (this._ws.readyState === WebSocket.OPEN)
      this._ws.close(1000, message);
  }

  private _onMessage(event: websocket.RawData) {
    const eventData = event.toString();
    let parsedJson;
    try {
      parsedJson = JSON.parse(eventData);
    } catch (e: any) {
      debugLogger(`<closing ws> Closing websocket due to malformed JSON. eventData=${eventData} e=${e?.message}`);
      this._ws.close();
      return;
    }
    try {
      this._handleParsedMessage(parsedJson);
    } catch (e: any) {
      debugLogger(`<closing ws> Closing websocket due to failed onmessage callback. eventData=${eventData} e=${e?.message}`);
      this._ws.close();
    }
  }

  private _handleParsedMessage(object: ExtensionResponse) {
    if (object.id && this._callbacks.has(object.id)) {
      const callback = this._callbacks.get(object.id)!;
      this._callbacks.delete(object.id);
      if (object.error) {
        const error = callback.error;
        error.message = object.error;
        callback.reject(error);
      } else {
        callback.resolve(object.result);
      }
    } else if (object.id) {
      debugLogger('← Extension: unexpected response', object);
    } else {
      this.onmessage?.(object.method! as keyof ExtensionEventsV2, object.params);
    }
  }

  private _onClose(event: websocket.CloseEvent) {
    debugLogger(`<ws closed> code=${event.code} reason=${event.reason}`);
    this._dispose();
    this.onclose?.(event.reason);
  }

  private _onError(event: websocket.ErrorEvent) {
    debugLogger(`<ws error> message=${event.message} type=${event.type} target=${event.target}`);
    this._dispose();
  }

  private _dispose() {
    for (const callback of this._callbacks.values())
      callback.reject(new Error('WebSocket closed'));
    this._callbacks.clear();
  }
}
