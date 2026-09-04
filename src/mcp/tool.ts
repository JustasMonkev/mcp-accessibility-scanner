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
import type * as mcpServer from './server.js';

export type ToolSchema<Input extends z.Schema> = {
  name: string;
  title: string;
  description: string;
  inputSchema: Input;
  // State-changing tools default to non-idempotent; convergent setters can
  // explicitly opt into safe retries.
  type: 'readOnly' | 'stateChanging' | 'destructive';
  idempotent?: boolean;
};

export function toMcpTool(tool: ToolSchema<any>): mcpServer.Tool {
  const annotations: NonNullable<mcpServer.Tool['annotations']> = {
    title: tool.title,
    readOnlyHint: tool.type === 'readOnly',
    destructiveHint: tool.type === 'destructive',
    openWorldHint: true,
  };
  if (tool.idempotent !== undefined)
    annotations.idempotentHint = tool.idempotent;
  else if (tool.type === 'stateChanging')
    annotations.idempotentHint = false;
  return {
    name: tool.name,
    // Top-level title takes precedence over annotations.title on spec
    // 2025-06-18+ clients; annotations.title is kept for older clients.
    title: tool.title,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema) as mcpServer.Tool['inputSchema'],
    annotations,
  };
}

/** @public */
export function defineToolSchema<Input extends z.Schema>(tool: ToolSchema<Input>): ToolSchema<Input> {
  return tool;
}
