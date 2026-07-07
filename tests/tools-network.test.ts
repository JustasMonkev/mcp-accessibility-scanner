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
    const req1 = { url: () => 'https://api.example.com/data', method: () => 'GET' };
    const res1 = { status: () => 200, statusText: () => 'OK' };
    mockRequests.set(req1, res1);

    const req2 = { url: () => 'https://api.example.com/user', method: () => 'POST' };
    const res2 = { status: () => 201, statusText: () => 'Created' };
    mockRequests.set(req2, res2);

    const req3 = { url: () => 'https://api.example.com/missing', method: () => 'GET' };
    mockRequests.set(req3, null);

    mockTab = {
      requests: vi.fn().mockReturnValue(mockRequests),
      modalStates: vi.fn().mockReturnValue([]),
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
      expect(networkTool.schema.title).toBe('List network requests');
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
      // Request without response just shows the request line
      expect(result).toContain('https://api.example.com/missing');
    });

    it('should handle empty requests', async () => {
      mockTab.requests = vi.fn().mockReturnValue(new Map());

      await networkTool.handle(mockContext, {}, response);

      expect(response.result()).toBe('');
    });

    it('should truncate data URL payloads', async () => {
      const payload = Buffer.from('<p>hello</p>').toString('base64');
      const mockRequests = new Map();
      mockRequests.set({ url: () => `data:text/html;base64,${payload}`, method: () => 'GET' }, null);
      mockTab.requests = vi.fn().mockReturnValue(mockRequests);

      await networkTool.handle(mockContext, {}, response);

      expect(response.result()).toContain('data:text/html;base64,...');
      expect(response.result()).not.toContain(payload);
    });

    it('should truncate embedded data URL payloads in request URLs', async () => {
      const payload = Buffer.from('<p>hello</p>').toString('base64');
      const mockRequests = new Map();
      mockRequests.set({ url: () => `https://api.example/upload?src=data:text/html;base64,${payload}&id=123`, method: () => 'POST' }, null);
      mockTab.requests = vi.fn().mockReturnValue(mockRequests);

      await networkTool.handle(mockContext, {}, response);

      expect(response.result()).toContain('https://api.example/upload?src=data:text/html;base64,...&id=123');
      expect(response.result()).not.toContain(payload);
    });

    it('should truncate data URLs with literal prefixes and encoded commas in request URLs', async () => {
      const payload = encodeURIComponent(Buffer.from('<p>hello</p>').toString('base64'));
      const mockRequests = new Map();
      mockRequests.set({ url: () => `https://api.example/upload?src=data:text/html;base64%2C${payload}&id=123`, method: () => 'POST' }, null);
      mockTab.requests = vi.fn().mockReturnValue(mockRequests);

      await networkTool.handle(mockContext, {}, response);

      expect(response.result()).toContain('https://api.example/upload?src=data:text/html;base64%2C...&id=123');
      expect(response.result()).not.toContain(payload);
    });

    it('should preserve query params after raw embedded data URL payloads', async () => {
      const payload = '<svg><text>Hello</text></svg>';
      const mockRequests = new Map();
      mockRequests.set({ url: () => `https://api.example/upload?src=data:image/svg+xml,${payload}&id=123`, method: () => 'POST' }, null);
      mockTab.requests = vi.fn().mockReturnValue(mockRequests);

      await networkTool.handle(mockContext, {}, response);

      expect(response.result()).toContain('https://api.example/upload?src=data:image/svg+xml,...&id=123');
      expect(response.result()).not.toContain(payload);
    });

    it('should truncate percent-encoded data URL payloads in request URLs', async () => {
      const payload = encodeURIComponent(Buffer.from('<p>hello</p>').toString('base64'));
      const mockRequests = new Map();
      mockRequests.set({ url: () => `https://api.example/upload?src=data%3Atext%2Fhtml%3Bbase64%2C${payload}&id=123`, method: () => 'POST' }, null);
      mockTab.requests = vi.fn().mockReturnValue(mockRequests);

      await networkTool.handle(mockContext, {}, response);

      expect(response.result()).toContain('https://api.example/upload?src=data%3Atext%2Fhtml%3Bbase64%2C...&id=123');
      expect(response.result()).not.toContain(payload);
    });
  });

  describe('browser_network_request tool', () => {
    const detailTool = networkTools.find(t => t.schema.name === 'browser_network_request')!;

    function setup(entries: [any, any][]) {
      const map = new Map<any, any>(entries);
      const tab = {
        requests: vi.fn().mockReturnValue(map),
        modalStates: vi.fn().mockReturnValue([]),
      } as any;
      const context = { currentTabOrDie: () => tab, config: {} } as any;
      const detailResponse = new Response(context, 'browser_network_request', {});
      return { context, response: detailResponse };
    }

    it('should exist as a readOnly core tool', () => {
      expect(detailTool).toBeDefined();
      expect(detailTool.schema.type).toBe('readOnly');
      expect(detailTool.capability).toBe('core');
    });

    it('should report an error for an out-of-range index', async () => {
      const { context, response: r } = setup([]);

      await detailTool.handle(context, { index: 1 }, r);

      expect(r.isError()).toBe(true);
      expect(r.result()).toContain('not found');
    });

    it('should render general info and headers by default', async () => {
      const req = {
        method: () => 'get',
        url: () => 'https://api.example.com/data',
        headers: () => ({ accept: 'application/json' }),
        postData: () => null,
      };
      const res = {
        status: () => 200,
        statusText: () => 'OK',
        headers: () => ({ 'content-type': 'application/json; charset=utf-8' }),
      };
      const { context, response: r } = setup([[req, res]]);

      await detailTool.handle(context, { index: 1 }, r);

      const out = r.result();
      expect(out).toContain('#1 [GET] https://api.example.com/data');
      expect(out).toContain('status:    [200] OK');
      expect(out).toContain('mimeType:  application/json');
      expect(out).toContain('Request headers');
      expect(out).toContain('accept: application/json');
      expect(out).toContain('Response headers');
      expect(out).toContain('content-type: application/json; charset=utf-8');
      expect(out).toContain('part="response-body"');
    });

    it('should return response headers only when part=response-headers', async () => {
      const req = { method: () => 'get', url: () => 'https://x/y', headers: () => ({}), postData: () => null };
      const res = { status: () => 200, statusText: () => 'OK', headers: () => ({ 'content-type': 'text/html' }) };
      const { context, response: r } = setup([[req, res]]);

      await detailTool.handle(context, { index: 1, part: 'response-headers' }, r);

      expect(r.result()).toBe('content-type: text/html');
    });

    it('should return a textual response body when part=response-body', async () => {
      const req = { method: () => 'get', url: () => 'https://x/y', headers: () => ({}), postData: () => null };
      const res = {
        status: () => 200,
        statusText: () => 'OK',
        headers: () => ({ 'content-type': 'text/plain' }),
        text: vi.fn().mockResolvedValue('hello world'),
        body: vi.fn(),
      };
      const { context, response: r } = setup([[req, res]]);

      await detailTool.handle(context, { index: 1, part: 'response-body' }, r);

      expect(r.result()).toBe('hello world');
      expect(res.text).toHaveBeenCalled();
      expect(res.body).not.toHaveBeenCalled();
    });

    it('should render a placeholder for a binary response body', async () => {
      const req = { method: () => 'get', url: () => 'https://x/img.png', headers: () => ({}), postData: () => null };
      const res = {
        status: () => 200,
        statusText: () => 'OK',
        headers: () => ({ 'content-type': 'image/png' }),
        text: vi.fn(),
        body: vi.fn().mockResolvedValue(Buffer.from([0, 1, 2, 3])),
      };
      const { context, response: r } = setup([[req, res]]);

      await detailTool.handle(context, { index: 1, part: 'response-body' }, r);

      expect(r.result()).toBe('<binary data: image/png, 4 bytes>');
      expect(res.body).toHaveBeenCalled();
      expect(res.text).not.toHaveBeenCalled();
    });

    it('should return the request body when part=request-body', async () => {
      const req = {
        method: () => 'post',
        url: () => 'https://api.example.com/data',
        headers: () => ({}),
        postData: () => '{"a":1}',
      };
      const res = { status: () => 201, statusText: () => 'Created', headers: () => ({}) };
      const { context, response: r } = setup([[req, res]]);

      await detailTool.handle(context, { index: 1, part: 'request-body' }, r);

      expect(r.result()).toBe('{"a":1}');
    });

    it('should handle requests without a response', async () => {
      const req = { method: () => 'get', url: () => 'https://x/y', headers: () => ({}), postData: () => null };
      const { context, response: r } = setup([[req, null]]);

      await detailTool.handle(context, { index: 1, part: 'response-body' }, r);

      expect(r.result()).toContain('No response');
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
