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

import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import path from 'node:path';
import { chromium, errors, type ConnectOverCDPOptions } from 'playwright';
import coreBundle from 'playwright-core/lib/coreBundle';
import { WebSocket, WebSocketServer } from 'ws';
import { createGuid } from './guid.js';
import { rejectOnAbort } from './timeout.js';

const maxPayload = 256 * 1024 * 1024;

type Upstream = Awaited<ReturnType<typeof coreBundle.server.WebSocketTransport.connect>>;

function isCdpMessage(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function filterAutoAttach(message: Record<string, unknown>): Record<string, unknown> {
  if (!('method' in message) || message.method !== 'Target.setAutoAttach' || 'sessionId' in message && message.sessionId)
    return message;
  if (!('params' in message) || !message.params || typeof message.params !== 'object' || !('autoAttach' in message.params) || message.params.autoAttach !== true)
    return message;
  const params = message.params;
  const filter = 'filter' in params && Array.isArray(params.filter) ? params.filter : [
    { type: 'browser', exclude: true }, { type: 'tab', exclude: true }, {},
  ];
  return { ...message, params: { ...params, filter: [{ type: 'shared_worker', exclude: true }, ...filter] } };
}

async function websocketEndpoint(endpoint: string, headers: Record<string, string>, signal: AbortSignal): Promise<string> {
  if (coreBundle.utils.isChromiumChannelName(endpoint)) {
    const directory = coreBundle.utils.defaultUserDataDirForChannel(endpoint);
    if (!directory)
      throw new Error(`Connecting to ${endpoint} by channel name is not supported on ${process.platform}.`);
    const file = path.join(directory, 'DevToolsActivePort');
    const contents = await rejectOnAbort(() => readFile(file, 'utf8'), signal);
    const [port, socketPath] = contents.trim().split('\n');
    if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535)
      throw new Error(`Invalid DevToolsActivePort file for ${endpoint}.`);
    return `ws://localhost:${port}${socketPath?.trim() || '/devtools/browser'}`;
  }
  if (endpoint.startsWith('ws:') || endpoint.startsWith('wss:'))
    return endpoint;
  const url = new URL(endpoint);
  if (!url.pathname.endsWith('/'))
    url.pathname += '/';
  url.pathname += 'json/version/';
  let cancel: ((error?: Error) => void) | undefined;
  const response = new Promise<string>((resolve, reject) => {
    ({ cancel } = coreBundle.utils.httpRequest({ url: url.toString(), headers }, incoming => {
      if (incoming.statusCode !== 200) {
        reject(new Error(`CDP endpoint returned HTTP ${incoming.statusCode}. This does not look like a DevTools server; try ws://.`));
        return;
      }
      let body = '';
      incoming.on('data', chunk => body += chunk);
      incoming.on('error', reject);
      incoming.on('end', () => resolve(body));
    }, reject));
  });
  let body: string;
  try {
    body = await rejectOnAbort(() => response, signal);
  } catch (error) {
    cancel?.(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  const result: unknown = JSON.parse(body);
  if (!result || typeof result !== 'object' || !('webSocketDebuggerUrl' in result) || typeof result.webSocketDebuggerUrl !== 'string')
    throw new Error('CDP endpoint did not provide a browser WebSocket URL.');
  return result.webSocketDebuggerUrl;
}

export async function connectOverCDP(endpoint: string, options: ConnectOverCDPOptions = {}) {
  const timeout = options.timeout ?? 30000;
  const deadline = timeout > 0 ? Date.now() + timeout : 0;
  const controller = new AbortController();
  let upstream: Upstream | undefined;
  let server: WebSocketServer | undefined;
  let listener: Server | undefined;
  let disposed = false;
  let disposal = Promise.resolve();
  const dispose = () => {
    if (disposed)
      return disposal;
    disposed = true;
    controller.abort(new Error('CDP connection closed.'));
    if (upstream) {
      upstream.onmessage = undefined;
      upstream.onclose = undefined;
      upstream.close();
    }
    if (server) {
      for (const peer of server.clients)
        peer.terminate();
      server.close();
    }
    if (listener) {
      const local = listener;
      local.closeAllConnections();
      disposal = new Promise<void>(resolve => local.close(() => resolve()));
    }
    return disposal;
  };
  const timer = timeout > 0 ? setTimeout(() => {
    const log = upstream ? '\nCall log:\n  - <ws connected> CDP upstream' : '';
    controller.abort(new errors.TimeoutError(`browserType.connectOverCDP: Timeout ${timeout}ms exceeded.${log}`));
  }, timeout) : undefined;
  const remaining = () => deadline ? Math.max(1, deadline - Date.now()) : 0;
  const progress = {
    ...coreBundle.server.nullProgress,
    signal: controller.signal,
    race<T>(pending: Promise<T> | Promise<T>[]) {
      return rejectOnAbort(() => Promise.race(Array.isArray(pending) ? pending : [pending]), controller.signal);
    },
  };
  try {
    const headers = { ...options.headers };
    if (!Object.keys(headers).some(name => name.toLowerCase() === 'user-agent'))
      headers['User-Agent'] = coreBundle.getUserAgent();
    const address = await websocketEndpoint(endpoint, headers, controller.signal);
    upstream = await coreBundle.server.WebSocketTransport.connect(progress, address, { headers, followRedirects: true });
    upstream.onclose = () => { void dispose(); };
    controller.signal.throwIfAborted();
    const route = `/${createGuid()}`;
    let accepted = false;
    listener = createServer((_request, response) => { response.writeHead(404).end(); });
    server = new WebSocketServer({
      server: listener, maxPayload,
      verifyClient: ({ req }: { req: IncomingMessage }) => {
        if (accepted || req.url !== route || req.headers.origin)
          return false;
        accepted = true;
        return true;
      },
    });
    const relay = server;
    const remote = upstream;
    relay.on('connection', peer => {
      remote.onmessage = message => {
        if (peer.readyState === WebSocket.OPEN)
          peer.send(JSON.stringify(message));
      };
      remote.onclose = () => { void dispose(); };
      peer.on('message', data => {
        try {
          const message: unknown = JSON.parse(data.toString());
          if (!isCdpMessage(message))
            throw new Error('Invalid CDP message.');
          remote.send(filterAutoAttach(message));
        } catch {
          void dispose();
        }
      });
      peer.on('close', () => { void dispose(); });
      peer.on('error', () => { void dispose(); });
    });
    relay.on('error', () => { void dispose(); });
    const listening = once(listener, 'listening');
    listener.listen({ host: '127.0.0.1', port: 0, signal: controller.signal });
    await rejectOnAbort(() => listening, controller.signal);
    const localAddress = listener.address();
    if (!localAddress || typeof localAddress === 'string')
      throw new Error('CDP relay did not bind a TCP port.');
    const browser = await rejectOnAbort(() => chromium.connectOverCDP(`ws://127.0.0.1:${localAddress.port}${route}`, {
      ...options, headers: undefined, timeout: remaining(),
    }), controller.signal);
    browser.once('disconnected', () => { void dispose(); });
    return browser;
  } catch (error) {
    await dispose();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
