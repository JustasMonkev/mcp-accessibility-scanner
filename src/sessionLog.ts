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

import fs from 'node:fs';
import path from 'node:path';

import { Response } from './response.js';
import { createShortGuid } from './utils/guid.js';
import { logUnhandledError } from './utils/log.js';
import { outputFile } from './config.js';

import type { FullConfig } from './config.js';
import type * as actions from './actions.js';
import type { Context } from './context.js';
import type { Tab, TabSnapshot } from './tab.js';

export interface IFileStorage {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  appendFile(filePath: string, content: string): Promise<void>;
}

class NodeFileStorage implements IFileStorage {
  async readFile(filePath: string): Promise<string> {
    return await fs.promises.readFile(filePath, 'utf-8');
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await fs.promises.writeFile(filePath, content);
  }

  async appendFile(filePath: string, content: string): Promise<void> {
    await fs.promises.appendFile(filePath, content);
  }
}

type LogEntry = {
  timestamp: number;
  toolCall?: {
    toolName: string;
    toolArgs: Record<string, any>;
    result: string;
    isError?: boolean;
  };
  userAction?: actions.Action;
  /**
   * The Context this entry originated from. One log is shared by a backend's
   * default context and every explicit session it opens, so the pending-entry
   * bookkeeping (action-update merging, navigate dedup) must be scoped by
   * originating context — "the last entry" globally is whichever context
   * wrote last, and merging into it would fold one session's action into
   * another's whenever the action names match.
   */
  source?: Context;
  /** The tab this user action came from; used only while pending. */
  tab?: Tab;
  /** Tags a session context's user actions in session.md; see logUserAction. */
  browserSessionId?: string;
  code: string;
  tabSnapshot?: TabSnapshot;
};

function renderUserAction(action: actions.Action, browserSessionId: string | undefined, code: string): string[] {
  const actionData: Record<string, unknown> = { ...action };
  delete actionData.ariaSnapshot;
  delete actionData.selector;
  delete actionData.signals;
  const loggedAction = browserSessionId !== undefined
    ? { browserSessionId, ...actionData }
    : actionData;
  const lines = [
    `### User action: ${action.name}`,
    `- Args`,
    '```json',
    JSON.stringify(loggedAction, null, 2),
    '```',
  ];
  if (code)
    lines.push(`- Code`, '```js', code, '```');
  return lines;
}

export class SessionLog {
  private _folder: string;
  private _file: string;
  private _ordinal = 0;
  private _pendingEntries: LogEntry[] = [];
  private _sessionFileQueue = Promise.resolve();
  private _flushEntriesTimeout: NodeJS.Timeout | undefined;
  private _storage: IFileStorage;
  private _lastFlushedAction = new WeakMap<Tab, { action: actions.Action; browserSessionId?: string; code: string; marker: string }>();

  constructor(sessionFolder: string, storage: IFileStorage = new NodeFileStorage()) {
    this._folder = sessionFolder;
    this._file = path.join(this._folder, 'session.md');
    this._storage = storage;
  }

  static async create(config: FullConfig): Promise<SessionLog> {
    // The random suffix keeps two sessions created in the same millisecond
    // (e.g. concurrent HTTP connections) from sharing a folder — a collision
    // would interleave their session.md entries and overwrite each other's
    // snapshot ordinals. Nothing parses the folder name back.
    const sessionFolder = await outputFile(config, `session-${Date.now()}-${createShortGuid()}`);
    await fs.promises.mkdir(sessionFolder, { recursive: true });
    // eslint-disable-next-line no-console
    console.error(`Session: ${sessionFolder}`);
    return new SessionLog(sessionFolder);
  }

  logResponse(response: Response) {
    const entry: LogEntry = {
      timestamp: performance.now(),
      toolCall: {
        toolName: response.toolName,
        toolArgs: response.toolArgs,
        result: response.result(),
        isError: response.isError(),
      },
      source: response.context,
      code: response.code(),
      tabSnapshot: response.tabSnapshot(),
    };
    this._appendEntry(entry);
  }

  logUserAction(action: actions.Action, tab: Tab, code: string, isUpdate: boolean) {
    code = code.trim();
    // All bookkeeping is scoped to the context and tab the recorder event came from:
    // with the log shared across a backend's contexts, an update matched
    // against the globally-last entry could merge into ANOTHER session's
    // same-named pending action, and a navigate could be deduplicated
    // against another session's location.
    const source = tab.context;
    const lastEntry = this._lastPendingEntryFor(source, tab);
    if (isUpdate) {
      if (lastEntry?.userAction?.name === action.name) {
        lastEntry.userAction = action;
        lastEntry.code = code;
        return;
      }
      const flushed = this._lastFlushedAction.get(tab);
      if (flushed?.action.name !== action.name)
        return;
      const previousAction = flushed.action;
      const previousCode = flushed.code;
      flushed.action = action;
      flushed.code = code;
      this._sessionFileQueue = this._sessionFileQueue
          .catch(logUnhandledError)
          .then(async () => {
            const content = await this._storage.readFile(this._file);
            const oldBlock = renderUserAction(previousAction, flushed.browserSessionId, previousCode).join('\n');
            const newBlock = renderUserAction(flushed.action, flushed.browserSessionId, flushed.code).join('\n');
            const markerIndex = content.indexOf(flushed.marker);
            if (markerIndex === -1)
              return;
            const blockIndex = content.lastIndexOf(oldBlock, markerIndex);
            if (blockIndex !== -1)
              await this._storage.writeFile(this._file, content.slice(0, blockIndex) + newBlock + content.slice(blockIndex + oldBlock.length));
          })
          .catch(logUnhandledError);
      return;
    }
    if (action.name === 'navigate') {
      // Already logged at this location.
      const lastContextEntry = this._lastPendingEntryFor(source);
      if (lastContextEntry?.userAction?.name === 'navigate' && lastContextEntry.tab === tab && lastContextEntry.tabSnapshot?.url === action.url)
        return;
    }
    const entry: LogEntry = {
      timestamp: performance.now(),
      userAction: action,
      source,
      tab,
      // Session contexts' recorded actions carry the handle in session.md,
      // mirroring how routed tool calls log a browserSessionId in their
      // args — otherwise concurrent sessions' user actions would be
      // indistinguishable in the shared log. Default-context actions stay
      // untagged, exactly as before.
      browserSessionId: source.options.browserSessionId,
      code,
      tabSnapshot: {
        url: tab.page.url(),
        title: '',
        ariaSnapshot: action.ariaSnapshot || '',
        modalStates: [],
        consoleMessages: [],
        downloads: [],
      },
    };
    this._appendEntry(entry);
  }

  /** The last not-yet-flushed entry this tab wrote. */
  private _lastPendingEntryFor(source: Context, tab?: Tab): LogEntry | undefined {
    for (let i = this._pendingEntries.length - 1; i >= 0; i--) {
      if (this._pendingEntries[i].source === source && (!tab || this._pendingEntries[i].tab === tab))
        return this._pendingEntries[i];
    }
    return undefined;
  }

  private _appendEntry(entry: LogEntry) {
    this._pendingEntries.push(entry);
    if (this._flushEntriesTimeout)
      clearTimeout(this._flushEntriesTimeout);
    this._flushEntriesTimeout = setTimeout(() => this._flushEntries(), 1000);
  }

  private async _flushEntries() {
    clearTimeout(this._flushEntriesTimeout);
    const entries = this._pendingEntries;
    this._pendingEntries = [];
    const lines: string[] = [''];

    for (const entry of entries) {
      const ordinal = (++this._ordinal).toString().padStart(3, '0');
      if (entry.toolCall) {
        lines.push(
            `### Tool call: ${entry.toolCall.toolName}`,
            `- Args`,
            '```json',
            JSON.stringify(entry.toolCall.toolArgs, null, 2),
            '```',
        );
        if (entry.toolCall.result) {
          lines.push(
              entry.toolCall.isError ? `- Error` : `- Result`,
              '```',
              entry.toolCall.result,
              '```',
          );
        }
      }

      if (entry.userAction)
        lines.push(...renderUserAction(entry.userAction, entry.browserSessionId, entry.code));
      else if (entry.code)
        lines.push(`- Code`, '```js', entry.code, '```');

      if (entry.tabSnapshot) {
        const fileName = `${ordinal}.snapshot.yml`;
        this._storage.writeFile(path.join(this._folder, fileName), entry.tabSnapshot.ariaSnapshot).catch(logUnhandledError);
        const marker = `- Snapshot: ${fileName}`;
        lines.push(marker);
        if (entry.userAction && entry.tab) {
          this._lastFlushedAction.set(entry.tab, {
            action: entry.userAction,
            browserSessionId: entry.browserSessionId,
            code: entry.code,
            marker,
          });
        }
      }

      lines.push('', '');
    }

    this._sessionFileQueue = this._sessionFileQueue
        .catch(logUnhandledError)
        .then(() => this._storage.appendFile(this._file, lines.join('\n')))
        .catch(logUnhandledError);
  }
}
