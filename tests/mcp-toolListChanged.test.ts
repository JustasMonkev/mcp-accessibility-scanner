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

import { describe, expect, it } from 'vitest';
import { haveToolNamesChanged } from '../src/mcp/toolListChanged.js';

describe('haveToolNamesChanged', () => {
  it('does not report changes for equivalent tool descriptors with different key ordering', () => {
    const previousTools = [{
      name: 'scan_page',
      description: 'Scan a page',
      inputSchema: {
        type: 'object',
        required: ['url'],
        properties: {
          url: {
            type: 'string',
          },
        },
      },
      annotations: {
        title: 'Scan Page',
        readOnlyHint: true,
      },
    }] as any;

    const nextTools = [{
      annotations: {
        readOnlyHint: true,
        title: 'Scan Page',
      },
      inputSchema: {
        properties: {
          url: {
            type: 'string',
          },
        },
        required: ['url'],
        type: 'object',
      },
      description: 'Scan a page',
      name: 'scan_page',
    }] as any;

    expect(haveToolNamesChanged(previousTools, nextTools)).toBe(false);
  });

  it('reports changes when tool metadata changes without a name change', () => {
    const previousTools = [{
      name: 'scan_page',
      description: 'Scan a page',
      inputSchema: {
        type: 'object',
      },
    }] as any;

    const nextTools = [{
      name: 'scan_page',
      description: 'Scan a page and attach screenshots',
      inputSchema: {
        type: 'object',
      },
    }] as any;

    expect(haveToolNamesChanged(previousTools, nextTools)).toBe(true);
  });
});
