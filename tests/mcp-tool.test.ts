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
import { toMcpTool, defineToolSchema } from '../src/mcp/tool.js';

describe('mcp/tool', () => {
  it('toMcpTool converts readOnly tools with annotations', () => {
    const schema = defineToolSchema({
      name: 'test_read',
      title: 'Test Read',
      description: 'Read-only tool',
      inputSchema: z.object({
        url: z.string(),
      }),
      type: 'readOnly',
    });

    const tool = toMcpTool(schema);
    expect(tool.name).toBe('test_read');
    expect(tool.description).toBe('Read-only tool');
    expect(tool.annotations?.title).toBe('Test Read');
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.annotations?.destructiveHint).toBe(false);
    expect(tool.annotations?.openWorldHint).toBe(true);

    const jsonSchema = tool.inputSchema as any;
    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.properties.url.type).toBe('string');
  });

  it('toMcpTool sets destructiveHint for destructive tools', () => {
    const schema = defineToolSchema({
      name: 'test_write',
      title: 'Test Write',
      description: 'Destructive tool',
      inputSchema: z.object({
        value: z.number(),
      }),
      type: 'destructive',
    });

    const tool = toMcpTool(schema);
    expect(tool.annotations?.readOnlyHint).toBe(false);
    expect(tool.annotations?.destructiveHint).toBe(true);
  });

  it('defineToolSchema is identity helper', () => {
    const schema = defineToolSchema({
      name: 'identity',
      title: 'Identity',
      description: 'Identity tool',
      inputSchema: z.object({}),
      type: 'readOnly',
    });

    expect(schema.name).toBe('identity');
    expect(schema.type).toBe('readOnly');
  });
});

