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
  // 'stateChanging' is an additive update: it creates state a retry would
  // duplicate (readOnlyHint false) without destroying anything
  // (destructiveHint false) — e.g. browser_session_open, which mints a new
  // live session and bearer handle on every call.
  type: 'readOnly' | 'stateChanging' | 'destructive';
};

export function toMcpTool(tool: ToolSchema<any>): mcpServer.Tool {
  return {
    name: tool.name,
    // Top-level title takes precedence over annotations.title on spec
    // 2025-06-18+ clients; annotations.title is kept for older clients.
    title: tool.title,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema) as mcpServer.Tool['inputSchema'],
    annotations: {
      title: tool.title,
      readOnlyHint: tool.type === 'readOnly',
      destructiveHint: tool.type === 'destructive',
      // stateChanging tools are non-idempotent by nature (each call creates
      // fresh state), so clients must not silently retry them.
      ...(tool.type === 'stateChanging' ? { idempotentHint: false } : {}),
      openWorldHint: true,
    },
  };
}

export function defineToolSchema<Input extends z.Schema>(tool: ToolSchema<Input>): ToolSchema<Input> {
  return tool;
}
