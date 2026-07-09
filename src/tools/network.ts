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
import path from 'node:path';
import mime from 'mime';
import RE2 from 're2';
import { z } from 'zod';
import { defineTabTool } from './tool.js';
import { truncateDataUrls } from '../utils/dataUrl.js';

import type { Response as ToolResponse } from '../response.js';
import type { Tab } from '../tab.js';
import type * as playwright from 'playwright';

const requests = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_network_requests',
    title: 'List network requests',
    description: 'Returns a numbered list of network requests since loading the page. Use browser_network_request with the number to get full details.',
    inputSchema: z.object({
      static: z.boolean().default(false).describe('Whether to include successful static resources like images, fonts, scripts, etc. Defaults to false.'),
      filter: z.string().optional().refine(value => !value || isValidRegex(value), { message: 'Invalid regular expression' }).describe('Only return requests whose URL matches this regular expression (e.g. "/api/.*user").'),
      filename: z.string().optional().describe('Filename to save the network requests to. If not provided, requests are returned as text.'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const entries = [...tab.requests().entries()];
    if (!entries.length) {
      response.addResult('No network requests recorded yet.');
      return;
    }

    const filter = params.filter ? new RE2(params.filter) : undefined;
    const lines: string[] = [];
    let hiddenStaticCount = 0;
    for (let i = 0; i < entries.length; i++) {
      const [request, httpResponse] = entries[i];
      if (!params.static && !isFetch(request) && isSuccessfulResponse(request, httpResponse)) {
        hiddenStaticCount++;
        continue;
      }
      if (filter && !filter.test(request.url()))
        continue;
      lines.push(`${i + 1}. ${renderRequestLine(request, httpResponse)}`);
    }

    if (hiddenStaticCount > 0)
      lines.push(`\nNote: ${hiddenStaticCount} static request${hiddenStaticCount === 1 ? '' : 's'} not shown, run with "static" option to see ${hiddenStaticCount === 1 ? 'it' : 'them'}.`);

    const result = lines.join('\n') || 'No network requests matched the filter.';
    await addTextResult(tab, response, 'Network requests', result, params.filename, 'text/plain');
  },
});

const REQUEST_PARTS = ['request-headers', 'request-body', 'response-headers', 'response-body'] as const;
type RequestPart = typeof REQUEST_PARTS[number];
const SENSITIVE_HEADER_PATTERN = /(?:^|[-_])(authorization|cookie|api[-_]?key|auth[-_]?token|access[-_]?token|token|secret)(?:$|[-_])/i;
const MAX_INLINE_RESPONSE_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 25 * 1024 * 1024;

const request = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_network_request',
    title: 'Show network request details',
    description: 'Returns metadata and headers for one network request, or a single part if `part` is set. Use the number from browser_network_requests.',
    inputSchema: z.object({
      index: z.number().int().min(1).describe('1-based index of the request, as printed by browser_network_requests.'),
      part: z.enum(REQUEST_PARTS).optional().describe('Return only this part of the request. Omit to return metadata and headers.'),
      filename: z.string().optional().describe('Filename to save the result to. If not provided, text output is returned inline.'),
      includeSensitiveHeaders: z.boolean().default(false).describe('Whether to include sensitive header values such as authorization, cookies, API keys, and tokens. Defaults to false.'),
      allowCompressedBody: z.boolean().default(false).describe('Whether to read compressed response bodies despite their decoded size being unbounded. Defaults to false.'),
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

    const [networkRequest, httpResponse] = entry;
    if (params.part) {
      await renderRequestPart(
          tab,
          networkRequest,
          httpResponse,
          params.index,
          params.part,
          !!params.includeSensitiveHeaders,
          !!params.allowCompressedBody,
          response,
          params.filename
      );
      return;
    }

    await addTextResult(
        tab,
        response,
        'Network request',
        renderRequestDetails(params.index, networkRequest, httpResponse, !!params.includeSensitiveHeaders),
        params.filename,
        'text/plain'
    );
  },
});

function isValidRegex(source: string): boolean {
  try {
    new RE2(source);
    return true;
  } catch {
    return false;
  }
}

function isFetch(request: playwright.Request): boolean {
  return ['fetch', 'xhr'].includes(request.resourceType());
}

function isSuccessfulResponse(request: playwright.Request, response: playwright.Response | null): boolean {
  return !request.failure() && !!response && response.status() < 400;
}

function renderRequestLine(request: playwright.Request, response: playwright.Response | null): string {
  let line = `[${request.method().toUpperCase()}] ${truncateDataUrls(request.url())}`;
  if (response)
    line += ` => [${response.status()}] ${response.statusText()}`;
  else if (request.failure())
    line += ` => [FAILED] ${request.failure()?.errorText ?? 'Unknown error'}`;
  return line;
}

function renderRequestDetails(index: number, request: playwright.Request, response: playwright.Response | null, includeSensitiveHeaders: boolean): string {
  const responseHeaders = response?.headers();
  const lines: string[] = [];
  lines.push(`#${index} [${request.method().toUpperCase()}] ${truncateDataUrls(request.url())}`);

  lines.push('');
  lines.push('  General');
  if (response)
    lines.push(`    status:    [${response.status()}] ${response.statusText()}`);
  else if (request.failure())
    lines.push(`    status:    [FAILED] ${request.failure()?.errorText ?? 'Unknown error'}`);
  const duration = computeDurationMs(request);
  if (duration !== undefined)
    lines.push(`    duration:  ${duration}ms`);
  lines.push(`    type:      ${request.resourceType()}`);
  const contentType = responseHeaders?.['content-type'];
  if (contentType)
    lines.push(`    mimeType:  ${baseMimeType(contentType)}`);

  appendHeaderSection(lines, 'Request headers', request.headers(), includeSensitiveHeaders);
  if (responseHeaders)
    appendHeaderSection(lines, 'Response headers', responseHeaders, includeSensitiveHeaders);

  const hints: string[] = [];
  if (request.postDataBuffer() !== null)
    hints.push(partHint('request-body', index));
  if (canHaveResponseBody(request, response))
    hints.push(partHint('response-body', index));
  if (hints.length)
    lines.push('', ...hints);

  return lines.join('\n');
}

function computeDurationMs(request: playwright.Request): number | undefined {
  const timing = request.timing();
  if (!timing || timing.responseEnd < 0)
    return undefined;
  return Math.round(timing.responseEnd);
}

function partHint(part: 'request-body' | 'response-body', index: number): string {
  const subject = part === 'request-body' ? 'request body' : 'response body';
  return `Call browser_network_request with index=${index} and part="${part}" to read the ${subject}.`;
}

function canHaveResponseBody(request: playwright.Request, response: playwright.Response | null): response is playwright.Response {
  if (request.method().toUpperCase() === 'HEAD' || !response)
    return false;
  const status = response.status();
  return status !== 204 && status !== 304 && !(status >= 100 && status < 200);
}

function appendHeaderSection(lines: string[], title: string, headers: Record<string, string>, includeSensitiveHeaders: boolean): void {
  const entries = Object.entries(headers);
  if (!entries.length)
    return;
  lines.push('');
  lines.push(`  ${title}`);
  for (const [key, value] of entries)
    lines.push(`    ${key}: ${renderHeaderValue(key, value, includeSensitiveHeaders)}`);
}

async function renderRequestPart(
  tab: Tab,
  request: playwright.Request,
  response: playwright.Response | null,
  index: number,
  part: RequestPart,
  includeSensitiveHeaders: boolean,
  allowCompressedBody: boolean,
  toolResponse: ToolResponse,
  filename?: string
): Promise<void> {
  if (part === 'request-headers') {
    await addTextResult(tab, toolResponse, 'Request headers', renderHeaders(request.headers(), includeSensitiveHeaders), filename, 'text/plain');
    return;
  }
  if (part === 'request-body') {
    const body = request.postDataBuffer();
    if (body === null) {
      toolResponse.addResult('No request body.');
      return;
    }
    if (body.length > MAX_RESPONSE_BODY_BYTES) {
      toolResponse.addError(`Request body is too large to read (${body.length} bytes; maximum ${MAX_RESPONSE_BODY_BYTES} bytes).`);
      return;
    }
    const contentType = baseMimeType(request.headers()['content-type']) || 'application/octet-stream';
    if (isTextualMimeType(contentType)) {
      if (!filename && body.length > MAX_INLINE_RESPONSE_BODY_BYTES) {
        toolResponse.addError(`Request body is too large to return inline (${body.length} bytes; maximum ${MAX_INLINE_RESPONSE_BODY_BYTES} bytes). Provide filename to save it instead.`);
        return;
      }
      await addTextResult(tab, toolResponse, 'Request body', truncateDataUrls(body.toString('utf8')), filename, contentType);
      return;
    }
    await saveBinaryBody(tab, toolResponse, body, contentType, filename, `request-${index}`, 'Request body');
    return;
  }
  if (!response) {
    toolResponse.addResult('No response was received for this request.');
    return;
  }
  if (part === 'response-headers') {
    await addTextResult(tab, toolResponse, 'Response headers', renderHeaders(response.headers(), includeSensitiveHeaders), filename, 'text/plain');
    return;
  }
  if (!canHaveResponseBody(request, response)) {
    toolResponse.addResult('This response cannot have a body.');
    return;
  }

  const responseHeaders = response.headers();
  const contentType = baseMimeType(responseHeaders['content-type']);
  const contentEncoding = responseHeaders['content-encoding']?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity' && !allowCompressedBody) {
    toolResponse.addError(`Response body uses ${contentEncoding} encoding, whose decoded size cannot be bounded safely. Set allowCompressedBody to true to read it explicitly.`);
    return;
  }
  const responseBodySize = await safeResponseBodySize(request);
  if (responseBodySize === undefined) {
    toolResponse.addError('Unable to determine the response body size safely.');
    return;
  }
  if (responseBodySize > MAX_RESPONSE_BODY_BYTES) {
    toolResponse.addError(`Response body is too large to read (${responseBodySize} bytes; maximum ${MAX_RESPONSE_BODY_BYTES} bytes).`);
    return;
  }
  if (!filename && isTextualMimeType(contentType) && responseBodySize > MAX_INLINE_RESPONSE_BODY_BYTES) {
    toolResponse.addError(`Response body is too large to return inline (${responseBodySize} bytes; maximum ${MAX_INLINE_RESPONSE_BODY_BYTES} bytes). Provide filename to save it instead.`);
    return;
  }
  if (isTextualMimeType(contentType)) {
    let text: string;
    try {
      text = await response.text();
    } catch {
      toolResponse.addError('Failed to read the response body.');
      return;
    }
    const textSize = Buffer.byteLength(text);
    if (textSize > MAX_RESPONSE_BODY_BYTES) {
      toolResponse.addError(`Response body is too large to read (${textSize} bytes; maximum ${MAX_RESPONSE_BODY_BYTES} bytes).`);
      return;
    }
    if (!filename && textSize > MAX_INLINE_RESPONSE_BODY_BYTES) {
      toolResponse.addError(`Response body is too large to return inline (${textSize} bytes; maximum ${MAX_INLINE_RESPONSE_BODY_BYTES} bytes). Provide filename to save it instead.`);
      return;
    }
    await addTextResult(tab, toolResponse, 'Response body', truncateDataUrls(text), filename, contentType || 'text/plain');
    return;
  }

  let body: Buffer;
  try {
    body = await response.body();
  } catch {
    toolResponse.addError('Failed to read the response body.');
    return;
  }
  if (!body.length) {
    toolResponse.addResult('Response body is empty.');
    return;
  }
  if (body.length > MAX_RESPONSE_BODY_BYTES) {
    toolResponse.addError(`Response body is too large to save (${body.length} bytes; maximum ${MAX_RESPONSE_BODY_BYTES} bytes).`);
    return;
  }

  await saveBinaryBody(tab, toolResponse, body, contentType, filename, `response-${index}`, 'Response body');
}

function renderHeaders(headers: Record<string, string>, includeSensitiveHeaders: boolean): string {
  const entries = Object.entries(headers);
  if (!entries.length)
    return 'No headers.';
  return entries.map(([key, value]) => `${key}: ${renderHeaderValue(key, value, includeSensitiveHeaders)}`).join('\n');
}

function renderHeaderValue(name: string, value: string, includeSensitiveHeaders: boolean): string {
  return !includeSensitiveHeaders && SENSITIVE_HEADER_PATTERN.test(name) ? '<redacted>' : value;
}

async function safeResponseBodySize(request: playwright.Request): Promise<number | undefined> {
  try {
    const size = (await request.sizes()).responseBodySize;
    return Number.isFinite(size) && size >= 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

async function saveBinaryBody(
  tab: Tab,
  response: ToolResponse,
  body: Buffer,
  contentType: string,
  filename: string | undefined,
  defaultPrefix: string,
  title: string
): Promise<void> {
  const extension = mime.getExtension(contentType) ?? 'bin';
  const defaultFilename = `${defaultPrefix}-${new Date().toISOString()}.${extension}`;
  const outputPath = await tab.context.outputFile(filename ?? defaultFilename);
  await fs.promises.writeFile(outputPath, body);
  response.addResult(`Saved ${title.toLowerCase()} to ${outputPath}`);
  response.addFileResourceLink(outputPath, {
    name: path.basename(outputPath),
    title,
    mimeType: contentType || 'application/octet-stream',
  });
}

function baseMimeType(contentType: string | undefined): string {
  return contentType?.split(';')[0].trim().toLowerCase() ?? '';
}

function isTextualMimeType(contentType: string): boolean {
  if (!contentType)
    return false;
  if (contentType.startsWith('text/'))
    return true;
  if (contentType.endsWith('+json') || contentType.endsWith('+xml'))
    return true;
  return [
    'application/json',
    'application/xml',
    'application/xhtml+xml',
    'application/javascript',
    'application/ecmascript',
    'application/x-www-form-urlencoded',
    'image/svg+xml',
  ].includes(contentType);
}

async function addTextResult(
  tab: Tab,
  response: ToolResponse,
  title: string,
  content: string,
  filename: string | undefined,
  mimeType: string
): Promise<void> {
  if (!filename) {
    response.addResult(content);
    return;
  }

  const outputPath = await tab.context.outputFile(filename);
  await fs.promises.writeFile(outputPath, content, 'utf8');
  response.addResult(`Saved ${title.toLowerCase()} to ${outputPath}`);
  response.addFileResourceLink(outputPath, {
    name: path.basename(outputPath),
    title,
    mimeType,
  });
}

export default [
  requests,
  request,
];
