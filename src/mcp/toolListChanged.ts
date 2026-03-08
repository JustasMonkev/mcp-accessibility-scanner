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

import type { ServerBackendContext } from './server.js';

const errorsDebug = debug('pw:mcp:errors');

export function haveToolNamesChanged(previousToolNames: string[] | undefined, nextToolNames: string[]): boolean {
  if (!previousToolNames)
    return true;

  if (previousToolNames.length !== nextToolNames.length)
    return true;

  const previousSet = new Set(previousToolNames);
  for (const toolName of nextToolNames) {
    if (!previousSet.has(toolName))
      return true;
  }
  return false;
}

export async function notifyToolListChanged(context: ServerBackendContext | undefined, previousToolNames: string[] | undefined, nextToolNames: string[]) {
  if (!context || !haveToolNamesChanged(previousToolNames, nextToolNames))
    return;

  try {
    await context.notifyToolListChanged();
  } catch (error) {
    errorsDebug('Failed to send tool list changed notification: %o', error);
  }
}
