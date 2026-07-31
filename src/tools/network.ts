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
import type { Tab } from '../tab.js';

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

    // Every read that can block lives here, bounded by the tab's page-state
    // timeout; the rendering below is pure so it can be tested with plain data.
    const [request, res] = entry;
    const details: RequestDetails = {
      index: params.index,
      request,
      requestHeaders: await read(tab, () => request.allHeaders(), 'reading the request headers'),
      response: res,
      responseHeaders: res ? await read(tab, () => res.allHeaders(), 'reading the response headers') : undefined,
      responseBody: res ? await read(tab, () => res.body(), 'reading the response body') : undefined,
    };
    for (const line of renderRequestDetails(details))
      response.addResult(line);
  },
});

function requestLine(index: number, request: playwright.Request): string {
  return `[${index}] [${request.method().toUpperCase()}] ${truncateDataUrls(request.url())}`;
}

function renderRequest(index: number, request: playwright.Request, response: playwright.Response | null) {
  const line = requestLine(index, request);
  return response ? `${line} => [${response.status()}] ${response.statusText()}` : line;
}

function section(title: string, lines: string[]): string[] {
  return ['', `#### ${title}`, ...lines];
}

type Read<T> = { value: T } | { error: string };

type RequestDetails = {
  index: number,
  request: playwright.Request,
  requestHeaders: Read<Record<string, string>>,
  response: playwright.Response | null,
  responseHeaders?: Read<Record<string, string>>,
  responseBody?: Read<Buffer>,
};

function renderRequestDetails(details: RequestDetails): string[] {
  const { index, request, response } = details;
  const requestHeaders = headersOf(details.requestHeaders);
  const result = [
    `### ${requestLine(index, request)}`,
    ...section('Request headers', renderHeaderSection(details.requestHeaders)),
  ];

  // `postData()` decodes as UTF-8, which mangles file uploads and protobuf
  // payloads, so go through the buffer and let the same binary check decide.
  const postData = request.postDataBuffer();
  if (postData?.length)
    result.push(...section('Request body', renderBody(postData, contentTypeOf(requestHeaders))));

  // Playwright records a failure on the request even when a response already
  // arrived — a connection reset mid-body is a 200 that never completed.
  const failure = request.failure();
  if (!response)
    return [...result, ...section('Response', [failure ? `The request failed: ${failure.errorText}` : 'The request has not completed yet.'])];

  const responseHeaders = headersOf(details.responseHeaders);
  result.push(
      ...section('Response', [
        `[${response.status()}] ${response.statusText()}`,
        ...(failure ? [`The transfer then failed: ${failure.errorText}`] : []),
      ]),
      ...section('Response headers', renderHeaderSection(details.responseHeaders)),
      ...section('Response body', renderResponseBody(details.responseBody, contentTypeOf(responseHeaders))),
  );
  return result;
}

// A failed read must not discard what the rest of the report already has.
async function read<T>(tab: Tab, fetch: () => Promise<T>, description: string): Promise<Read<T>> {
  try {
    return { value: await tab.withPageStateTimeout(fetch(), description) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
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

// Credentials must never reach the model's context: this tool is the first one
// here to surface raw headers, and a session cookie copied into a transcript is
// as good as leaked. The length keeps the header's presence debuggable.
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
    // `allHeaders()` joins repeated headers (`set-cookie` especially) with a
    // newline; keep one line per header so `name: value` stays parseable.
    return `${name}: ${truncateDataUrls(value).replace(newlines, '\\n')}`;
  });
}

type ContentType = { mimeType: string, charset: string };

function contentTypeOf(headers: Record<string, string>): ContentType {
  // `allHeaders()` joins a repeated header with a comma, so only the first
  // media type and its parameters describe the payload.
  const first = (headers['content-type'] ?? '').split(',')[0];
  return {
    mimeType: first.split(';')[0].trim().toLowerCase(),
    charset: /;\s*charset\s*=\s*"?([^";]*)/i.exec(first)?.[1].trim() ?? '',
  };
}

function renderResponseBody(read: Read<Buffer> | undefined, contentType: ContentType): string[] {
  if (!read)
    return ['<empty>'];
  // Redirects, responses whose body the browser never retained, and bodies
  // still streaming all fail the read; the rest of the report is worth showing.
  return 'error' in read ? [`<body unavailable: ${read.error}>`] : renderBody(read.value, contentType);
}

// A body large enough to matter is decoded only up to the cap: a 100MB response
// must not become a 200MB string, and `toString` throws outright past ~512MB.
const maxBodyBytes = maxBodyLength * 4;

function renderBody(body: Buffer, contentType: ContentType): string[] {
  if (!body.length)
    return ['<empty>'];
  if (!isTextualMimeType(contentType.mimeType, body))
    return [`<binary data, ${body.length} bytes${contentType.mimeType ? `, ${contentType.mimeType}` : ''}>`];

  // Collapse data: URLs before measuring — doing it after would let the
  // replacement text push the rendered body back over the cap.
  const text = truncateDataUrls(decodeText(body.subarray(0, maxBodyBytes), contentType.charset));
  if (body.length <= maxBodyBytes && text.length <= maxBodyLength)
    return fence(text);

  const shown = sliceWholeCharacters(text, maxBodyLength);
  return [...fence(shown), `<truncated, showing the first ${shown.length} characters of a ${body.length}-byte body>`];
}

function decodeText(body: Buffer, charset: string): string {
  if (!charset || /^utf-?8$/i.test(charset))
    return body.toString('utf8');
  try {
    // Legacy pages really do serve windows-1252 and shift_jis; decoding those
    // as UTF-8 turns the body into replacement characters.
    return new TextDecoder(charset).decode(body);
  } catch {
    return body.toString('utf8');
  }
}

// The body is page-controlled. Fencing it stops a response from forging the
// `####` sections around it, and the fence is grown past any run of backticks
// inside so the block still terminates where it should.
function fence(text: string): string[] {
  const delimiter = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
  return [delimiter, text, delimiter];
}

// Never cut between the halves of a surrogate pair -- a lone half renders as a
// replacement character and can corrupt the JSON the response is packed into.
function sliceWholeCharacters(text: string, length: number): string {
  const last = text.charCodeAt(length - 1);
  const isHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, isHighSurrogate ? length - 1 : length);
}

const textualMimeTypes = new Set([
  'application/csv',
  'application/ecmascript',
  'application/graphql',
  'application/javascript',
  'application/json',
  'application/ndjson',
  'application/sql',
  'application/x-ecmascript',
  'application/x-javascript',
  'application/x-ndjson',
  'application/x-sh',
  'application/x-www-form-urlencoded',
  'application/x-yaml',
  'application/xml',
  'application/yaml',
]);

const binaryMimePrefixes = ['audio/', 'font/', 'image/', 'model/', 'video/'];

const binaryMimeTypes = new Set([
  'application/grpc',
  'application/gzip',
  'application/octet-stream',
  'application/pdf',
  'application/protobuf',
  'application/wasm',
  'application/x-gzip',
  'application/x-protobuf',
  'application/x-tar',
  'application/zip',
]);

function isTextualMimeType(mimeType: string, body: Buffer): boolean {
  if (mimeType.startsWith('text/'))
    return true;
  // Structured syntax suffixes: `image/svg+xml`, `application/ld+json`, ...
  if (mimeType.endsWith('+json') || mimeType.endsWith('+xml') || mimeType.endsWith('+text'))
    return true;
  if (textualMimeTypes.has(mimeType))
    return true;
  if (binaryMimeTypes.has(mimeType) || binaryMimePrefixes.some(prefix => mimeType.startsWith(prefix)))
    return false;
  // Absent or unrecognised type -- `multipart/form-data` posts are the common
  // case, and those are text until a file part makes them otherwise.
  return !looksBinary(body);
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
