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

import type { Client } from '@modelcontextprotocol/client';
import type { CallToolRequestContext, CallToolRequest, CallToolResult, Tool } from './server.js';

type Discovery = { pending: number; changed: boolean; notification?: ReturnType<typeof setImmediate> };

/** Downstream discovery and invocation, without provider or tool-selection policy. */
export class ToolRelay {
  private _discovery = new Map<Client, Discovery>();
  private _closed = false;

  constructor(
    private readonly _notifyToolListChanged: (client: Client) => Promise<void> | undefined,
    private readonly _onError: (error: unknown) => void,
  ) {}

  observe(client: Client): void {
    client.setNotificationHandler('notifications/tools/list_changed', async () => {
      if (this._closed)
        return;
      const discovery = this._discovery.get(client);
      if (discovery) {
        // Keep the dirty state on the client, not on an individual listing:
        // a new listing may start after the last one settles but before its
        // deferred notification runs.
        discovery.changed = true;
      } else {
        await this._notify(client);
      }
    });
  }

  async listTools(client: Client, requestContext?: Partial<Pick<CallToolRequestContext, 'signal' | '_meta'>>): Promise<Tool[]> {
    let discovery = this._discovery.get(client);
    if (!discovery) {
      discovery = { pending: 0, changed: false };
      this._discovery.set(client, discovery);
    }
    ++discovery.pending;
    try {
      const response = await client.listTools(requestContext?._meta ? { _meta: requestContext._meta } : undefined, { signal: requestContext?.signal });
      return response.tools;
    } finally {
      --discovery.pending;
      if (!discovery.pending) {
        if (!this._closed)
          this._deferDiscoveryCompletion(client, discovery);
        else
          this._discovery.delete(client);
      }
    }
  }

  async callTool(client: Client, name: string, args: CallToolRequest['params']['arguments'], requestContext?: CallToolRequestContext): Promise<CallToolResult> {
    const options: Parameters<Client['callTool']>[1] = requestContext ? { signal: requestContext.signal } : undefined;
    const progressToken = requestContext?._meta?.progressToken;
    if (options && requestContext && progressToken !== undefined) {
      options.onprogress = params => {
        void this._forwardProgress(requestContext, progressToken, params);
      };
    }
    return await client.callTool({ name, arguments: args, _meta: requestContext?._meta }, options);
  }

  close(): void {
    this._closed = true;
    for (const discovery of this._discovery.values())
      clearImmediate(discovery.notification);
    this._discovery.clear();
  }

  private _deferDiscoveryCompletion(client: Client, discovery: Discovery): void {
    if (discovery.notification)
      return;
    // Keep buffering through the caller's promise continuation, even if no
    // change has arrived yet. Every overlapping read must settle first.
    discovery.notification = setImmediate(() => {
      discovery.notification = undefined;
      if (this._closed || discovery.pending)
        return;
      this._discovery.delete(client);
      if (discovery.changed)
        void this._notify(client);
    });
  }

  private async _notify(client: Client): Promise<void> {
    try {
      await this._notifyToolListChanged(client);
    } catch (error) {
      this._onError(error);
    }
  }

  private async _forwardProgress(requestContext: CallToolRequestContext, progressToken: string | number, params: { progress: number; total?: number; message?: string }): Promise<void> {
    try {
      await requestContext.sendNotification({ method: 'notifications/progress', params: { progressToken, ...params } });
    } catch (error) {
      this._onError(error);
    }
  }
}
