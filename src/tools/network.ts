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

import type * as playwright from 'playwright';

// Bodies land in the model's context verbatim, so cap what a single detail call
// can contribute. Anything longer is reported as truncated rather than dropped.
export const maxBodyLength = 20000;

const requests = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_network_requests',
    title: 'List network requests',
    description: 'Returns all network requests since loading the page',
    inputSchema: z.object({}),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const entries = [...tab.requests().entries()];
    entries.forEach(([req, res], index) => response.addResult(renderRequest(index + 1, req, res)));
    if (entries.length)
      response.addResult('\nCall browser_network_request with one of the indexes above to see the headers and response body of that request.');
  },
});

const requestDetails = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_network_request',
    title: 'Get network request details',
    description: 'Returns the request headers, response headers and response body of a single network request listed by browser_network_requests',
    inputSchema: z.object({
      index: z.number().int().min(1).describe('Index of the request in the browser_network_requests listing, starting at 1'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const entries = [...tab.requests().entries()];
    const entry = entries[params.index - 1];
    if (!entry) {
      response.addError(entries.length
        ? `Error: No network request with index ${params.index}. The current list is numbered 1 to ${entries.length}; run browser_network_requests for the up-to-date list.`
        : 'Error: No network requests have been recorded since the page was loaded.');
      return;
    }

    const [req, res] = entry;
    for (const line of await renderRequestDetails(params.index, req, res))
      response.addResult(line);
  },
});

function renderRequest(index: number, request: playwright.Request, response: playwright.Response | null) {
  const result: string[] = [];
  result.push(`[${index}] [${request.method().toUpperCase()}] ${truncateDataUrls(request.url())}`);
  if (response)
    result.push(`=> [${response.status()}] ${response.statusText()}`);
  return result.join(' ');
}

async function renderRequestDetails(index: number, request: playwright.Request, response: playwright.Response | null): Promise<string[]> {
  const result: string[] = [
    `### [${index}] [${request.method().toUpperCase()}] ${truncateDataUrls(request.url())}`,
    '',
    '#### Request headers',
    ...renderHeaders(await request.allHeaders()),
  ];

  const postData = request.postData();
  if (postData)
    result.push('', '#### Request body', ...renderText(postData));

  if (!response) {
    const failure = request.failure();
    result.push('', '#### Response', failure ? `The request failed: ${failure.errorText}` : 'The request has not completed yet.');
    return result;
  }

  result.push(
      '',
      '#### Response',
      `[${response.status()}] ${response.statusText()}`,
      '',
      '#### Response headers',
      ...renderHeaders(await response.allHeaders()),
      '',
      '#### Response body',
      ...await renderResponseBody(response),
  );
  return result;
}

function renderHeaders(headers: Record<string, string>): string[] {
  const names = Object.keys(headers).sort();
  if (!names.length)
    return ['<none>'];
  return names.map(name => `${name}: ${truncateDataUrls(headers[name])}`);
}

async function renderResponseBody(response: playwright.Response): Promise<string[]> {
  let body: Buffer;
  try {
    body = await response.body();
  } catch (error) {
    // Redirects and responses whose body the browser never retained reject
    // here; the rest of the report is still worth showing.
    return [`<body unavailable: ${error instanceof Error ? error.message : String(error)}>`];
  }

  if (!body.length)
    return ['<empty>'];

  const mimeType = ((await response.headerValue('content-type')) ?? '').split(';')[0].trim().toLowerCase();
  if (!isTextualMimeType(mimeType, body))
    return [`<binary data, ${body.length} bytes${mimeType ? `, ${mimeType}` : ''}>`];

  return renderText(body.toString('utf8'));
}

function renderText(text: string): string[] {
  if (text.length <= maxBodyLength)
    return [truncateDataUrls(text)];
  return [
    truncateDataUrls(text.slice(0, maxBodyLength)),
    `<truncated, showing the first ${maxBodyLength} of ${text.length} characters>`,
  ];
}

const textualMimeTypes = new Set([
  'application/ecmascript',
  'application/graphql',
  'application/javascript',
  'application/json',
  'application/x-ecmascript',
  'application/x-javascript',
  'application/x-www-form-urlencoded',
  'application/xml',
]);

function isTextualMimeType(mimeType: string, body: Buffer): boolean {
  if (!mimeType)
    return !looksBinary(body);
  if (mimeType.startsWith('text/'))
    return true;
  // Structured syntax suffixes: `image/svg+xml`, `application/ld+json`, ...
  if (mimeType.endsWith('+json') || mimeType.endsWith('+xml') || mimeType.endsWith('+text'))
    return true;
  return textualMimeTypes.has(mimeType);
}

function looksBinary(body: Buffer): boolean {
  // A NUL byte is the cheapest reliable signal that a payload is not text --
  // UTF-8 encoded text never contains one outside of a deliberate \0.
  return body.subarray(0, 1024).includes(0);
}

export default [
  requests,
  requestDetails,
];
