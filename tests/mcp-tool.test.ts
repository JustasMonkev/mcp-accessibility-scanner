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

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { toMcpTool } from '../src/mcp/tool.js';

describe('mcp/tool', () => {
  it('toMcpTool converts readOnly tools with annotations', () => {
    const tool = toMcpTool({
      name: 'test_read',
      title: 'Test Read',
      description: 'Read-only tool',
      inputSchema: z.object({
        url: z.string(),
      }),
      type: 'readOnly',
    });

    expect(tool.name).toBe('test_read');
    expect(tool.title).toBe('Test Read');
    expect(tool.description).toBe('Read-only tool');
    expect(tool.annotations?.title).toBe('Test Read');
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.annotations?.destructiveHint).toBe(false);
    expect(tool.annotations?.openWorldHint).toBe(true);

    const jsonSchema = tool.inputSchema as JSONSchema7;
    expect(jsonSchema.type).toBe('object');
    expect((jsonSchema.properties?.url as JSONSchema7)?.type).toBe('string');
  });

  it('toMcpTool sets destructiveHint for destructive tools', () => {
    const tool = toMcpTool({
      name: 'test_write',
      title: 'Test Write',
      description: 'Destructive tool',
      inputSchema: z.object({
        value: z.number(),
      }),
      type: 'destructive',
    });

    expect(tool.annotations?.readOnlyHint).toBe(false);
    expect(tool.annotations?.destructiveHint).toBe(true);
  });

  it('maps stateChanging to non-readonly, non-destructive, non-idempotent annotations', () => {
    // A retried stateChanging call duplicates state (e.g. browser_session_open
    // mints another live session), so clients must see it as neither safe to
    // parallelize (readOnly) nor destructive — and never silently retryable.
    const tool = toMcpTool({
      name: 'state_changing',
      title: 'State changing',
      description: 'State-changing tool',
      inputSchema: z.object({}),
      type: 'stateChanging',
    });

    expect(tool.annotations?.readOnlyHint).toBe(false);
    expect(tool.annotations?.destructiveHint).toBe(false);
    expect(tool.annotations?.idempotentHint).toBe(false);
  });

  it('allows a state-changing tool to declare idempotent retries', () => {
    const tool = toMcpTool({
      name: 'idempotent_state_change',
      title: 'Idempotent state change',
      description: 'Converges to the requested state',
      inputSchema: z.object({}),
      type: 'stateChanging',
      idempotent: true,
    });

    expect(tool.annotations?.readOnlyHint).toBe(false);
    expect(tool.annotations?.idempotentHint).toBe(true);
  });
});
