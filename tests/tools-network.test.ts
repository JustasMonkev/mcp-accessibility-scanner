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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import networkTools from '../src/tools/network.js';
import { Response } from '../src/response.js';
import type { Context } from '../src/context.js';
import type { Tab } from '../src/tab.js';

describe('Network Tools', () => {
  let mockContext: Context;
  let mockTab: Tab;
  let response: Response;

  beforeEach(() => {
    const mockRequests = new Map();
    mockRequests.set(
      { url: () => 'https://api.example.com/data', method: () => 'GET' },
      { status: () => 200, statusText: () => 'OK' }
    );
    mockRequests.set(
      { url: () => 'https://api.example.com/user', method: () => 'POST' },
      { status: () => 201, statusText: () => 'Created' }
    );
    mockRequests.set(
      { url: () => 'https://api.example.com/missing', method: () => 'GET' },
      null
    );

    mockTab = {
      requests: vi.fn().mockReturnValue(mockRequests),
    } as any;

    mockContext = {
      currentTabOrDie: () => mockTab,
      config: {},
    } as any;

    response = new Response(mockContext, 'test_tool', {});
  });

  describe('browser_network_requests tool', () => {
    const networkTool = networkTools.find(t => t.schema.name === 'browser_network_requests')!;

    it('should exist', () => {
      expect(networkTool).toBeDefined();
      expect(networkTool.schema.name).toBe('browser_network_requests');
    });

    it('should have correct schema', () => {
      expect(networkTool.schema.title).toBe('Network requests');
      expect(networkTool.schema.type).toBe('readOnly');
    });

    it('should retrieve all network requests', async () => {
      await networkTool.handle(mockContext, {}, response);

      expect(mockTab.requests).toHaveBeenCalled();
      expect(response.result()).toContain('https://api.example.com/data');
      expect(response.result()).toContain('https://api.example.com/user');
    });

    it('should show request methods', async () => {
      await networkTool.handle(mockContext, {}, response);

      const result = response.result();
      expect(result).toContain('GET');
      expect(result).toContain('POST');
    });

    it('should show response status', async () => {
      await networkTool.handle(mockContext, {}, response);

      const result = response.result();
      expect(result).toContain('200');
      expect(result).toContain('201');
    });

    it('should handle requests without responses', async () => {
      await networkTool.handle(mockContext, {}, response);

      const result = response.result();
      expect(result).toContain('pending');
    });

    it('should handle empty requests', async () => {
      mockTab.requests = vi.fn().mockReturnValue(new Map());

      await networkTool.handle(mockContext, {}, response);

      expect(response.result()).toContain('No network requests');
    });

    it('should report request count', async () => {
      await networkTool.handle(mockContext, {}, response);

      expect(response.result()).toContain('3 network requests');
    });
  });

  describe('Tool capabilities', () => {
    it('should all have core capability', () => {
      networkTools.forEach(tool => {
        expect(tool.capability).toBe('core');
      });
    });
  });
});
