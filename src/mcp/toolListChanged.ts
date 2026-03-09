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

import type { ServerBackendContext, Tool } from './server.js';

const errorsDebug = debug('pw:mcp:errors');

export type ToolDescriptor = Tool;

export function haveToolNamesChanged(previousTools: ToolDescriptor[] | undefined, nextTools: ToolDescriptor[]): boolean {
  if (!previousTools)
    return true;

  if (previousTools.length !== nextTools.length)
    return true;

  for (let index = 0; index < nextTools.length; index++) {
    if (stableSerializeTool(previousTools[index]) !== stableSerializeTool(nextTools[index]))
      return true;
  }
  return false;
}

function stableSerializeTool(tool: ToolDescriptor): string {
  return JSON.stringify(canonicalize(tool));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(item => canonicalize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
        Object.entries(value)
            .filter(([, entryValue]) => entryValue !== undefined)
            .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
            .map(([key, entryValue]) => [key, canonicalize(entryValue)]),
    );
  }
  return value;
}

export async function notifyToolListChanged(context: ServerBackendContext | undefined, previousTools: ToolDescriptor[] | undefined, nextTools: ToolDescriptor[]) {
  if (!context || !haveToolNamesChanged(previousTools, nextTools))
    return;

  try {
    await context.notifyToolListChanged();
  } catch (error) {
    errorsDebug('Failed to send tool list changed notification: %o', error);
  }
}
