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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import networkTools from '../src/tools/network.js';
import { Response } from '../src/response.js';

import type { Context } from '../src/context.js';
import type { Tab } from '../src/tab.js';

type RequestOptions = {
  url: string;
  method?: string;
  resourceType?: string;
  headers?: Record<string, string>;
  postData?: string | null;
  postDataBuffer?: Buffer | null;
  failure?: { errorText: string } | null;
  responseEnd?: number;
  responseBodySize?: number;
  sizesError?: boolean;
};

type ResponseOptions = {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  text?: string;
  body?: Buffer;
};

function createRequest(options: RequestOptions) {
  return {
    url: () => options.url,
    method: () => options.method ?? 'GET',
    resourceType: () => options.resourceType ?? 'fetch',
    headers: () => options.headers ?? {},
    postData: () => options.postData ?? options.postDataBuffer?.toString('utf8') ?? null,
    postDataBuffer: () => options.postDataBuffer ?? (options.postData !== undefined && options.postData !== null ? Buffer.from(options.postData) : null),
    failure: () => options.failure ?? null,
    timing: () => ({ responseEnd: options.responseEnd ?? 12 }),
    sizes: options.sizesError
      ? vi.fn().mockRejectedValue(new Error('sizes unavailable'))
      : vi.fn().mockResolvedValue({
        requestBodySize: 0,
        requestHeadersSize: 0,
        responseBodySize: options.responseBodySize ?? 0,
        responseHeadersSize: 0,
      }),
  };
}

function createResponse(options: ResponseOptions = {}) {
  return {
    status: () => options.status ?? 200,
    statusText: () => options.statusText ?? 'OK',
    headers: () => options.headers ?? {},
    text: vi.fn().mockResolvedValue(options.text ?? ''),
    body: vi.fn().mockResolvedValue(options.body ?? Buffer.alloc(0)),
  };
}

describe('Network Tools', () => {
  let mockContext: Context;
  let mockTab: Tab;
  let response: Response;

  beforeEach(() => {
    const mockRequests = new Map();
    mockRequests.set(
        createRequest({ url: 'https://api.example.com/data', resourceType: 'fetch' }),
        createResponse({ status: 200, statusText: 'OK' })
    );
    mockRequests.set(
        createRequest({ url: 'https://api.example.com/user', method: 'POST', resourceType: 'xhr' }),
        createResponse({ status: 201, statusText: 'Created' })
    );
    mockRequests.set(
        createRequest({
          url: 'https://api.example.com/missing',
          resourceType: 'image',
          failure: { errorText: 'net::ERR_FAILED' },
        }),
        null
    );

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

    it('should expose the current list schema', () => {
      expect(networkTool).toBeDefined();
      expect(networkTool.schema.title).toBe('List network requests');
      expect(networkTool.schema.type).toBe('readOnly');
      expect(networkTool.schema.inputSchema.parse({})).toEqual({ static: false });
      expect(networkTool.schema.inputSchema.parse({ static: true, filter: '/api/', filename: 'network.log' })).toEqual({
        static: true,
        filter: '/api/',
        filename: 'network.log',
      });
      expect(() => networkTool.schema.inputSchema.parse({ filter: '[invalid(' })).toThrow();
    });

    it('should return numbered request summaries including failures', async () => {
      await networkTool.handle(mockContext, {}, response);

      expect(mockTab.requests).toHaveBeenCalled();
      expect(response.result()).toContain('1. [GET] https://api.example.com/data => [200] OK');
      expect(response.result()).toContain('2. [POST] https://api.example.com/user => [201] Created');
      expect(response.result()).toContain('3. [GET] https://api.example.com/missing => [FAILED] net::ERR_FAILED');
    });

    it('should hide successful static requests by default while preserving raw indexes', async () => {
      const requests = new Map();
      requests.set(
          createRequest({ url: 'https://example.com/', resourceType: 'document' }),
          createResponse()
      );
      requests.set(
          createRequest({ url: 'https://example.com/api/users', resourceType: 'fetch' }),
          createResponse()
      );
      mockTab.requests = vi.fn().mockReturnValue(requests);

      await networkTool.handle(mockContext, {}, response);

      expect(response.result()).not.toContain('1. [GET] https://example.com/');
      expect(response.result()).toContain('2. [GET] https://example.com/api/users');
      expect(response.result()).toContain('Note: 1 static request not shown');
    });

    it('should include successful static requests when requested', async () => {
      const requests = new Map();
      requests.set(
          createRequest({ url: 'https://example.com/app.js', resourceType: 'script' }),
          createResponse()
      );
      mockTab.requests = vi.fn().mockReturnValue(requests);

      await networkTool.handle(mockContext, { static: true }, response);

      expect(response.result()).toContain('1. [GET] https://example.com/app.js => [200] OK');
      expect(response.result()).not.toContain('not shown');
    });

    it('should filter URLs without renumbering requests', async () => {
      await networkTool.handle(mockContext, { filter: '/user' }, response);

      expect(response.result()).toContain('2. [POST] https://api.example.com/user');
      expect(response.result()).not.toContain('1. [GET] https://api.example.com/data');
      expect(response.result()).not.toContain('3. [GET] https://api.example.com/missing');
    });

    it('should return a useful message when no requests were recorded', async () => {
      mockTab.requests = vi.fn().mockReturnValue(new Map());

      await networkTool.handle(mockContext, {}, response);

      expect(response.result()).toBe('No network requests recorded yet.');
    });

    it('should save the list when filename is provided', async () => {
      const outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-network-list-'));
      const outputPath = path.join(outputDir, 'requests.log');
      (mockTab as any).context = { outputFile: vi.fn().mockResolvedValue(outputPath) };

      try {
        await networkTool.handle(mockContext, { filename: 'requests.log' }, response);

        expect(await fs.promises.readFile(outputPath, 'utf8')).toContain('https://api.example.com/data');
        expect(response.result()).toContain(outputPath);
        expect(response.resourceLinks()).toEqual([
          expect.objectContaining({ uri: pathToFileURL(outputPath).toString(), mimeType: 'text/plain' }),
        ]);
      } finally {
        await fs.promises.rm(outputDir, { recursive: true, force: true });
      }
    });

    it('should truncate data URL payloads', async () => {
      const payload = Buffer.from('<p>hello</p>').toString('base64');
      const mockRequests = new Map();
      mockRequests.set(createRequest({ url: `data:text/html;base64,${payload}` }), null);
      mockTab.requests = vi.fn().mockReturnValue(mockRequests);

      await networkTool.handle(mockContext, {}, response);

      expect(response.result()).toContain('data:text/html;base64,...');
      expect(response.result()).not.toContain(payload);
    });

    it('should truncate embedded data URL payloads and preserve following query params', async () => {
      const payload = '<svg><text>Hello</text></svg>';
      const mockRequests = new Map();
      mockRequests.set(createRequest({
        url: `https://api.example/upload?src=data:image/svg+xml,${payload}&id=123`,
        method: 'POST',
      }), null);
      mockTab.requests = vi.fn().mockReturnValue(mockRequests);

      await networkTool.handle(mockContext, {}, response);

      expect(response.result()).toContain('https://api.example/upload?src=data:image/svg+xml,...&id=123');
      expect(response.result()).not.toContain(payload);
    });

    it('should truncate percent-encoded data URL payloads', async () => {
      const payload = encodeURIComponent(Buffer.from('<p>hello</p>').toString('base64'));
      const mockRequests = new Map();
      mockRequests.set(createRequest({
        url: `https://api.example/upload?src=data%3Atext%2Fhtml%3Bbase64%2C${payload}&id=123`,
        method: 'POST',
      }), null);
      mockTab.requests = vi.fn().mockReturnValue(mockRequests);

      await networkTool.handle(mockContext, {}, response);

      expect(response.result()).toContain('data%3Atext%2Fhtml%3Bbase64%2C...&id=123');
      expect(response.result()).not.toContain(payload);
    });
  });

  describe('browser_network_request tool', () => {
    const detailTool = networkTools.find(t => t.schema.name === 'browser_network_request')!;

    function setup(entries: [ReturnType<typeof createRequest>, ReturnType<typeof createResponse> | null][]) {
      const map = new Map(entries);
      const tab = {
        requests: vi.fn().mockReturnValue(map),
        modalStates: vi.fn().mockReturnValue([]),
      } as any;
      const context = { currentTabOrDie: () => tab, config: {} } as any;
      return { tab, context, response: new Response(context, 'browser_network_request', {}) };
    }

    it('should expose the current detail schema', () => {
      expect(detailTool).toBeDefined();
      expect(detailTool.schema.type).toBe('readOnly');
      expect(detailTool.capability).toBe('core');
      expect(detailTool.schema.inputSchema.parse({ index: 1 })).toEqual({
        index: 1,
        includeSensitiveHeaders: false,
        allowCompressedBody: false,
      });
      expect(detailTool.schema.inputSchema.parse({ index: 2, part: 'response-body', filename: 'body.json' })).toEqual({
        index: 2,
        part: 'response-body',
        filename: 'body.json',
        includeSensitiveHeaders: false,
        allowCompressedBody: false,
      });
      expect(() => detailTool.schema.inputSchema.parse({ index: 0 })).toThrow();
    });

    it('should report an error for an out-of-range index', async () => {
      const { context, response: detailResponse } = setup([]);

      await detailTool.handle(context, { index: 1 }, detailResponse);

      expect(detailResponse.isError()).toBe(true);
      expect(detailResponse.result()).toContain('Request #1 not found');
    });

    it('should render metadata and headers without eagerly reading bodies', async () => {
      const request = createRequest({
        url: 'https://api.example.com/data',
        method: 'POST',
        resourceType: 'fetch',
        headers: { accept: 'application/json', authorization: 'Bearer request-secret' },
        postData: '{"query":"hello"}',
        responseEnd: 18.6,
      });
      const httpResponse = createResponse({
        status: 201,
        statusText: 'Created',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-request-id': 'abc123',
          'set-cookie': 'session=response-secret',
        },
        text: '{"ok":true}',
      });
      const { context, response: detailResponse } = setup([[request, httpResponse]]);

      await detailTool.handle(context, { index: 1 }, detailResponse);

      const result = detailResponse.result();
      expect(result).toContain('#1 [POST] https://api.example.com/data');
      expect(result).toContain('status:    [201] Created');
      expect(result).toContain('duration:  19ms');
      expect(result).toContain('type:      fetch');
      expect(result).toContain('mimeType:  application/json');
      expect(result).toContain('Request headers');
      expect(result).toContain('accept: application/json');
      expect(result).toContain('authorization: <redacted>');
      expect(result).toContain('Response headers');
      expect(result).toContain('x-request-id: abc123');
      expect(result).toContain('set-cookie: <redacted>');
      expect(result).not.toContain('request-secret');
      expect(result).not.toContain('response-secret');
      expect(result).toContain('part="request-body"');
      expect(result).toContain('part="response-body"');
      expect(result).not.toContain('{"query":"hello"}');
      expect(result).not.toContain('{"ok":true}');
      expect(httpResponse.text).not.toHaveBeenCalled();
      expect(httpResponse.body).not.toHaveBeenCalled();
    });

    it('should return each request and response part independently', async () => {
      const request = createRequest({
        url: 'https://api.example.com/data',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-header': 'request-value' },
        postData: '{"a":1}',
      });
      const httpResponse = createResponse({
        headers: { 'content-type': 'application/json', 'x-response': 'ok' },
        text: '{"name":"Ada"}',
      });

      for (const [part, expected] of [
        ['request-headers', 'x-request-header: request-value'],
        ['request-body', '{"a":1}'],
        ['response-headers', 'x-response: ok'],
        ['response-body', '{"name":"Ada"}'],
      ] as const) {
        const { context, response: detailResponse } = setup([[request, httpResponse]]);
        await detailTool.handle(context, { index: 1, part }, detailResponse);
        expect(detailResponse.result()).toContain(expected);
      }
    });

    it('should include sensitive headers only when explicitly requested', async () => {
      const request = createRequest({
        url: 'https://api.example.com/data',
        headers: { authorization: 'Bearer request-secret' },
      });
      const httpResponse = createResponse({ headers: { 'content-type': 'application/json' } });
      const { context, response: detailResponse } = setup([[request, httpResponse]]);

      await detailTool.handle(context, {
        index: 1,
        part: 'request-headers',
        includeSensitiveHeaders: true,
      }, detailResponse);

      expect(detailResponse.result()).toContain('authorization: Bearer request-secret');
    });

    it('should save binary request bodies byte-for-byte', async () => {
      const outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-network-request-binary-'));
      const binary = Buffer.from([0x00, 0xff, 0x01, 0xfe]);
      const request = createRequest({
        url: 'https://api.example.com/upload',
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        postDataBuffer: binary,
      });
      const httpResponse = createResponse();
      const { tab, context, response: detailResponse } = setup([[request, httpResponse]]);
      tab.context = {
        outputFile: vi.fn(async (name: string) => path.join(outputDir, name)),
      };

      try {
        await detailTool.handle(context, { index: 1, part: 'request-body' }, detailResponse);

        const outputName = (tab.context.outputFile as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(outputName).toMatch(/\.bin$/);
        expect(await fs.promises.readFile(path.join(outputDir, outputName))).toEqual(binary);
        expect(detailResponse.resourceLinks()).toEqual([
          expect.objectContaining({ mimeType: 'application/octet-stream' }),
        ]);
      } finally {
        await fs.promises.rm(outputDir, { recursive: true, force: true });
      }
    });

    it('should preserve request bodies without Content-Type as binary', async () => {
      const outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-network-request-unknown-'));
      const binary = Buffer.from([0xff, 0xfe, 0xfd]);
      const request = createRequest({
        url: 'https://api.example.com/upload',
        method: 'POST',
        postDataBuffer: binary,
      });
      const { tab, context, response: detailResponse } = setup([[request, createResponse()]]);
      tab.context = {
        outputFile: vi.fn(async (name: string) => path.join(outputDir, name)),
      };

      try {
        await detailTool.handle(context, { index: 1, part: 'request-body' }, detailResponse);

        const outputName = (tab.context.outputFile as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(await fs.promises.readFile(path.join(outputDir, outputName))).toEqual(binary);
        expect(detailResponse.resourceLinks()).toEqual([
          expect.objectContaining({ mimeType: 'application/octet-stream' }),
        ]);
      } finally {
        await fs.promises.rm(outputDir, { recursive: true, force: true });
      }
    });

    it('should require filename for request bodies larger than the inline limit', async () => {
      const request = createRequest({
        url: 'https://api.example.com/large-upload',
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        postDataBuffer: Buffer.alloc(1024 * 1024 + 1, 0x61),
      });
      const { context, response: detailResponse } = setup([[request, createResponse()]]);

      await detailTool.handle(context, { index: 1, part: 'request-body' }, detailResponse);

      expect(detailResponse.isError()).toBe(true);
      expect(detailResponse.result()).toContain('Request body is too large to return inline');
      expect(detailResponse.result()).toContain('Provide filename');
    });

    it('should truncate data URLs in textual bodies', async () => {
      const payload = Buffer.from('<p>hello</p>').toString('base64');
      const request = createRequest({ url: 'https://api.example.com/data' });
      const httpResponse = createResponse({
        headers: { 'content-type': 'application/json' },
        text: `{"image":"data:text/html;base64,${payload}"}`,
      });
      const { context, response: detailResponse } = setup([[request, httpResponse]]);

      await detailTool.handle(context, { index: 1, part: 'response-body' }, detailResponse);

      expect(detailResponse.result()).toContain('data:text/html;base64,...');
      expect(detailResponse.result()).not.toContain(payload);
    });

    it('should require filename for text bodies larger than the inline limit', async () => {
      const request = createRequest({
        url: 'https://api.example.com/large',
        responseBodySize: 1024 * 1024 + 1,
      });
      const httpResponse = createResponse({
        headers: { 'content-type': 'text/plain' },
        text: 'should not be read',
      });
      const { context, response: detailResponse } = setup([[request, httpResponse]]);

      await detailTool.handle(context, { index: 1, part: 'response-body' }, detailResponse);

      expect(detailResponse.isError()).toBe(true);
      expect(detailResponse.result()).toContain('too large to return inline');
      expect(detailResponse.result()).toContain('Provide filename');
      expect(httpResponse.text).not.toHaveBeenCalled();
    });

    it('should reject response bodies larger than the read limit', async () => {
      const request = createRequest({
        url: 'https://api.example.com/huge',
        responseBodySize: 25 * 1024 * 1024 + 1,
      });
      const httpResponse = createResponse({
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('should not be read'),
      });
      const { context, response: detailResponse } = setup([[request, httpResponse]]);

      await detailTool.handle(context, { index: 1, part: 'response-body' }, detailResponse);

      expect(detailResponse.isError()).toBe(true);
      expect(detailResponse.result()).toContain('too large to read');
      expect(httpResponse.body).not.toHaveBeenCalled();
    });

    it('should fail closed when response size is unavailable', async () => {
      const request = createRequest({
        url: 'https://api.example.com/unknown-size',
        sizesError: true,
      });
      const httpResponse = createResponse({
        headers: { 'content-type': 'text/plain' },
        text: 'should not be read',
      });
      const { context, response: detailResponse } = setup([[request, httpResponse]]);

      await detailTool.handle(context, { index: 1, part: 'response-body' }, detailResponse);

      expect(detailResponse.isError()).toBe(true);
      expect(detailResponse.result()).toContain('Unable to determine the response body size safely');
      expect(httpResponse.text).not.toHaveBeenCalled();
    });

    it('should require explicit opt-in for compressed response bodies', async () => {
      const request = createRequest({ url: 'https://api.example.com/compressed', responseBodySize: 20 });
      const httpResponse = createResponse({
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        text: '{"ok":true}',
      });
      const { context, response: detailResponse } = setup([[request, httpResponse]]);

      await detailTool.handle(context, { index: 1, part: 'response-body' }, detailResponse);

      expect(detailResponse.isError()).toBe(true);
      expect(detailResponse.result()).toContain('decoded size cannot be bounded safely');
      expect(detailResponse.result()).toContain('allowCompressedBody');
      expect(httpResponse.text).not.toHaveBeenCalled();
    });

    it('should read compressed response bodies after explicit opt-in', async () => {
      const request = createRequest({ url: 'https://api.example.com/compressed', responseBodySize: 20 });
      const httpResponse = createResponse({
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        text: '{"ok":true}',
      });
      const { context, response: detailResponse } = setup([[request, httpResponse]]);

      await detailTool.handle(context, {
        index: 1,
        part: 'response-body',
        allowCompressedBody: true,
      }, detailResponse);

      expect(detailResponse.isError()).toBeFalsy();
      expect(detailResponse.result()).toBe('{"ok":true}');
      expect(httpResponse.text).toHaveBeenCalledTimes(1);
    });

    it.each([101, 204, 304])('should not read a body for status %s', async status => {
      const request = createRequest({ url: 'https://api.example.com/no-body' });
      const httpResponse = createResponse({ status, headers: { 'content-type': 'text/plain' }, text: 'unexpected' });
      const { context, response: detailResponse } = setup([[request, httpResponse]]);

      await detailTool.handle(context, { index: 1, part: 'response-body' }, detailResponse);

      expect(detailResponse.result()).toContain('cannot have a body');
      expect(httpResponse.text).not.toHaveBeenCalled();
      expect(httpResponse.body).not.toHaveBeenCalled();
    });

    it('should not read a body for HEAD requests', async () => {
      const request = createRequest({ url: 'https://api.example.com/headers', method: 'HEAD' });
      const httpResponse = createResponse({ status: 200, headers: { 'content-type': 'text/plain' }, text: 'unexpected' });
      const { context, response: detailResponse } = setup([[request, httpResponse]]);

      await detailTool.handle(context, { index: 1, part: 'response-body' }, detailResponse);

      expect(detailResponse.result()).toContain('cannot have a body');
      expect(httpResponse.text).not.toHaveBeenCalled();
      expect(httpResponse.body).not.toHaveBeenCalled();
    });

    it('should explain when a request has no response', async () => {
      const request = createRequest({ url: 'https://api.example.com/pending' });
      const { context, response: detailResponse } = setup([[request, null]]);

      await detailTool.handle(context, { index: 1, part: 'response-body' }, detailResponse);

      expect(detailResponse.result()).toBe('No response was received for this request.');
    });

    it('should save text bodies when filename is provided', async () => {
      const outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-network-text-'));
      const outputPath = path.join(outputDir, 'body.json');
      const request = createRequest({ url: 'https://api.example.com/data' });
      const httpResponse = createResponse({ headers: { 'content-type': 'application/json' }, text: '{"ok":true}' });
      const { tab, context, response: detailResponse } = setup([[request, httpResponse]]);
      tab.context = { outputFile: vi.fn().mockResolvedValue(outputPath) };

      try {
        await detailTool.handle(context, { index: 1, part: 'response-body', filename: 'body.json' }, detailResponse);

        expect(await fs.promises.readFile(outputPath, 'utf8')).toBe('{"ok":true}');
        expect(detailResponse.result()).toContain(outputPath);
        expect(detailResponse.resourceLinks()).toEqual([
          expect.objectContaining({ uri: pathToFileURL(outputPath).toString(), mimeType: 'application/json' }),
        ]);
      } finally {
        await fs.promises.rm(outputDir, { recursive: true, force: true });
      }
    });

    it('should save binary bodies byte-for-byte with a MIME-derived extension', async () => {
      const outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-network-binary-'));
      const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const request = createRequest({ url: 'https://api.example.com/image' });
      const httpResponse = createResponse({
        headers: { 'content-type': 'image/png' },
        body: binary,
      });
      const { tab, context, response: detailResponse } = setup([[request, httpResponse]]);
      tab.context = {
        outputFile: vi.fn(async (name: string) => path.join(outputDir, name)),
      };

      try {
        await detailTool.handle(context, { index: 1, part: 'response-body' }, detailResponse);

        const outputPath = (tab.context.outputFile as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(outputPath).toMatch(/\.png$/);
        expect(await fs.promises.readFile(path.join(outputDir, outputPath))).toEqual(binary);
        expect(httpResponse.body).toHaveBeenCalledTimes(1);
        expect(httpResponse.text).not.toHaveBeenCalled();
        expect(detailResponse.resourceLinks()).toEqual([
          expect.objectContaining({ mimeType: 'image/png' }),
        ]);
      } finally {
        await fs.promises.rm(outputDir, { recursive: true, force: true });
      }
    });

    it('should surface response body read failures', async () => {
      const request = createRequest({ url: 'https://api.example.com/data' });
      const httpResponse = createResponse({ headers: { 'content-type': 'text/plain' } });
      httpResponse.text.mockRejectedValueOnce(new Error('body unavailable'));
      const { context, response: detailResponse } = setup([[request, httpResponse]]);

      await detailTool.handle(context, { index: 1, part: 'response-body' }, detailResponse);

      expect(detailResponse.isError()).toBe(true);
      expect(detailResponse.result()).toContain('Failed to read the response body');
    });
  });

  describe('Tool capabilities', () => {
    it('should all have core capability', () => {
      networkTools.forEach(tool => expect(tool.capability).toBe('core'));
    });
  });
});
