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

import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { Config } from '../../config.js';

export type ToolPolicy = Pick<Config, 'allowedTools' | 'blockedTools'>;

export function isToolBlocked(config: ToolPolicy, name: string): boolean {
  return config.blockedTools?.includes(name) ?? false;
}

export function assertToolNotBlocked(config: ToolPolicy, name: string): void {
  if (isToolBlocked(config, name))
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool "${name}" not found`);
}

/** Empty input explicitly clears a lower-precedence list; empty entries are errors. */
export function toolNameList(value: string | undefined): string[] | undefined {
  if (value === undefined)
    return undefined;
  return value.trim() ? value.split(',').map(name => name.trim()) : [];
}
