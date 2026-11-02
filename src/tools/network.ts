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
import { defineTabTool } from './tool.js';
import { truncateDataUrls } from '../utils/dataUrl.js';
import { errorMessage } from '../utils/errors.js';

import type { Request, Response } from 'playwright';
import type { Tab } from '../tab.js';

const requests = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_network_requests',
    title: 'List network requests',
    description: 'Returns network requests since the last explicit navigation, optionally including up to 200 requests from earlier navigations in this tab',
    inputSchema: z.object({
      all: z.boolean().optional().describe('Include up to 200 requests from earlier explicit navigations in this tab'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const entries = tab.requests(params.all);
    for (const [index, request] of entries)
      response.addResult(renderRequest(index, request, request.existingResponse()));
    if (entries.size)
      response.addResult('\nCall browser_network_request with one of the indexes above to see its headers and body metadata.');
  },
});

const requestDetails = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_network_request',
    title: 'Get network request details',
    description: 'Returns credential-redacted headers and body metadata for a single network request listed by browser_network_requests',
    inputSchema: z.object({
      index: z.number().int().min(1).describe('Stable request ID from browser_network_requests; IDs are not reused in this tab'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const request = tab.request(params.index);
    if (!request) {
      response.addError(tab.requests(true).size
        ? `Error: No retained network request with index ${params.index}. It may have been evicted; run browser_network_requests with all: true for the retained IDs.`
        : 'Error: No network requests have been recorded since the page was loaded.');
      return;
    }

    const requestResponse = request.existingResponse();
    const details: RequestDetails = {
      index: params.index,
      request,
      requestHeaders: await readOrDescribeFailure(tab, () => request.allHeaders(), 'reading the request headers'),
      response: requestResponse,
      responseHeaders: requestResponse ? await readOrDescribeFailure(tab, () => requestResponse.allHeaders(), 'reading the response headers') : undefined,
      responseBody: requestResponse ? await readOrDescribeFailure(tab, () => requestResponse.body(), 'reading the response body') : undefined,
    };
    for (const line of renderRequestDetails(details))
      response.addResult(line);
  },
});

function requestLine(index: number, request: Request): string {
  return `[${index}] [${request.method().toUpperCase()}] ${truncateDataUrls(request.url())}`;
}

function renderRequest(index: number, request: Request, response: Response | null) {
  const line = requestLine(index, request);
  return response ? `${line} => [${response.status()}] ${response.statusText()}` : line;
}

function section(title: string, lines: string[]): string[] {
  return ['', `#### ${title}`, ...lines];
}

type Read<T> = { value: T } | { error: string };

type RequestDetails = {
  index: number,
  request: Request,
  requestHeaders: Read<Record<string, string>>,
  response: Response | null,
  responseHeaders?: Read<Record<string, string>>,
  responseBody?: Read<Buffer>,
};

function renderRequestDetails(details: RequestDetails): string[] {
  const { index, request, response } = details;
  const result = [
    `### ${requestLine(index, request)}`,
    ...section('Request headers', renderHeaderSection(details.requestHeaders)),
  ];

  const postData = request.postDataBuffer();
  if (postData?.length)
    result.push(...section('Request body', summarizeBody(postData, contentTypeOf(headersOf(details.requestHeaders)))));

  const failure = request.failure();
  if (!response)
    return [...result, ...section('Response', [failure ? `The request failed: ${failure.errorText}` : 'The request has not completed yet.'])];

  result.push(
      ...section('Response', [
        `[${response.status()}] ${response.statusText()}`,
        ...(failure ? [`The transfer then failed: ${failure.errorText}`] : []),
      ]),
      ...section('Response headers', renderHeaderSection(details.responseHeaders)),
      ...section('Response body', renderResponseBody(details.responseBody, contentTypeOf(headersOf(details.responseHeaders)))),
  );
  return result;
}

async function readOrDescribeFailure<T>(tab: Tab, fetch: () => Promise<T>, description: string): Promise<Read<T>> {
  try {
    return { value: await tab.withPageStateTimeout(fetch(), description) };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

function headersOf(read: Read<Record<string, string>> | undefined): Record<string, string> {
  return read && 'value' in read ? read.value : {};
}

function renderHeaderSection(read: Read<Record<string, string>> | undefined): string[] {
  if (!read)
    return ['<none>'];
  return 'error' in read ? [`<headers unavailable: ${read.error}>`] : renderHeaders(read.value);
}

const newlines = /\r?\n/g;

const sensitiveHeaderNames = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
]);

function renderHeaders(headers: Record<string, string>): string[] {
  const names = Object.keys(headers).sort();
  if (!names.length)
    return ['<none>'];
  return names.map(name => {
    const value = headers[name];
    if (sensitiveHeaderNames.has(name.toLowerCase()))
      return `${name}: <redacted, ${value.length} characters>`;
    return `${name}: ${truncateDataUrls(value).replace(newlines, '\\n')}`;
  });
}

function contentTypeOf(headers: Record<string, string>): string {
  const firstOfRepeatedHeaders = (headers['content-type'] ?? '').split(',')[0];
  return firstOfRepeatedHeaders.split(';')[0].trim().toLowerCase();
}

function renderResponseBody(read: Read<Buffer> | undefined, mimeType: string): string[] {
  if (!read)
    return ['<empty>'];
  return 'error' in read ? [`<body unavailable: ${read.error}>`] : summarizeBody(read.value, mimeType);
}

function summarizeBody(body: Buffer, mimeType: string): string[] {
  if (!body.length)
    return ['<empty>'];
  return [`<redacted, ${body.length} bytes${mimeType ? `, ${mimeType}` : ''}>`];
}

export default [
  requests,
  requestDetails,
];
