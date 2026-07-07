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

import type { Response as ToolResponse } from '../response.js';
import type * as playwright from 'playwright';

const requests = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_network_requests',
    title: 'List network requests',
    description: 'Returns a numbered list of network requests since loading the page. Use browser_network_request with the number to get full headers and body.',
    inputSchema: z.object({}),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const entries = [...tab.requests().entries()];
    const lines = entries.map(([request, res], index) => `${index + 1}. ${renderRequestLine(request, res)}`);
    response.addResult(lines.join('\n'));
  },
});

const REQUEST_PARTS = ['request-headers', 'request-body', 'response-headers', 'response-body'] as const;
type RequestPart = typeof REQUEST_PARTS[number];

const request = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_network_request',
    title: 'Show network request details',
    description: 'Returns full details (headers and body) of a single network request, or a single part if `part` is set. Use the number printed by browser_network_requests.',
    inputSchema: z.object({
      index: z.number().int().min(1).describe('1-based index of the request, as printed by browser_network_requests.'),
      part: z.enum(REQUEST_PARTS).optional().describe('Return only this part of the request. Omit to return full details.'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const entries = [...tab.requests().entries()];
    const entry = entries[params.index - 1];
    if (!entry) {
      response.addError(`Request #${params.index} not found. Use browser_network_requests to see available indexes.`);
      return;
    }
    const [request, res] = entry;
    if (params.part) {
      await renderRequestPart(request, res, params.part, response);
      return;
    }
    response.addResult(renderRequestDetails(params.index, request, res));
  },
});

function renderRequestLine(request: playwright.Request, response: playwright.Response | null): string {
  let line = `[${request.method().toUpperCase()}] ${truncateDataUrls(request.url())}`;
  if (response)
    line += ` => [${response.status()}] ${response.statusText()}`;
  return line;
}

function renderRequestDetails(index: number, request: playwright.Request, response: playwright.Response | null): string {
  const responseHeaders = response?.headers();
  const lines: string[] = [];
  lines.push(`#${index} [${request.method().toUpperCase()}] ${truncateDataUrls(request.url())}`);

  lines.push('');
  lines.push('  General');
  if (response)
    lines.push(`    status:    [${response.status()}] ${response.statusText()}`);
  const contentType = responseHeaders?.['content-type'];
  if (contentType)
    lines.push(`    mimeType:  ${contentType.split(';')[0].trim()}`);

  appendHeaderSection(lines, 'Request headers', request.headers());
  if (responseHeaders)
    appendHeaderSection(lines, 'Response headers', responseHeaders);

  const hints: string[] = [];
  if (request.postData())
    hints.push(partHint('request-body', index));
  if (canHaveResponseBody(response))
    hints.push(partHint('response-body', index));
  if (hints.length)
    lines.push('', ...hints);

  return lines.join('\n');
}

function partHint(part: 'request-body' | 'response-body', index: number): string {
  const subject = part === 'request-body' ? 'request body' : 'response body';
  return `Call browser_network_request with index=${index} and part="${part}" to read the ${subject}.`;
}

function canHaveResponseBody(response: playwright.Response | null): response is playwright.Response {
  if (!response)
    return false;
  const status = response.status();
  // Status codes that cannot carry a response body per RFC 7230.
  return status !== 204 && status !== 304 && !(status >= 100 && status < 200);
}

function appendHeaderSection(lines: string[], title: string, headers: Record<string, string>): void {
  const entries = Object.entries(headers);
  if (!entries.length)
    return;
  lines.push('');
  lines.push(`  ${title}`);
  for (const [key, value] of entries)
    lines.push(`    ${key}: ${value}`);
}

async function renderRequestPart(request: playwright.Request, response: playwright.Response | null, part: RequestPart, toolResponse: ToolResponse): Promise<void> {
  if (part === 'request-headers') {
    toolResponse.addResult(renderHeaders(request.headers()));
    return;
  }
  if (part === 'request-body') {
    const data = request.postData();
    toolResponse.addResult(data !== null ? truncateDataUrls(data) : 'No request body.');
    return;
  }
  if (!response) {
    toolResponse.addResult('No response was received for this request.');
    return;
  }
  if (part === 'response-headers') {
    toolResponse.addResult(renderHeaders(response.headers()));
    return;
  }
  // response-body
  if (!canHaveResponseBody(response)) {
    toolResponse.addResult('This response cannot have a body.');
    return;
  }
  const contentType = response.headers()['content-type'] ?? '';
  if (isTextualMimeType(contentType)) {
    let text: string;
    try {
      text = await response.text();
    } catch {
      toolResponse.addError('Failed to read the response body.');
      return;
    }
    toolResponse.addResult(truncateDataUrls(text));
    return;
  }
  // Binary body: this server returns text only, so render a placeholder
  // describing the payload instead of streaming raw bytes.
  let body: Buffer;
  try {
    body = await response.body();
  } catch {
    toolResponse.addError('Failed to read the response body.');
    return;
  }
  const mimeType = contentType.split(';')[0].trim() || 'application/octet-stream';
  toolResponse.addResult(`<binary data: ${mimeType}, ${body.length} bytes>`);
}

function renderHeaders(headers: Record<string, string>): string {
  const entries = Object.entries(headers);
  if (!entries.length)
    return 'No headers.';
  return entries.map(([key, value]) => `${key}: ${value}`).join('\n');
}

function isTextualMimeType(mimeType: string): boolean {
  const type = mimeType.split(';')[0].trim().toLowerCase();
  if (!type)
    return false;
  if (type.startsWith('text/'))
    return true;
  if (type.endsWith('+json') || type.endsWith('+xml'))
    return true;
  return [
    'application/json',
    'application/xml',
    'application/xhtml+xml',
    'application/javascript',
    'application/ecmascript',
    'application/x-www-form-urlencoded',
    'image/svg+xml',
  ].includes(type);
}

export default [
  requests,
  request,
];
