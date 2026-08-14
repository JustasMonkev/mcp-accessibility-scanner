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
    const requestMap = tab.requests();
    let index = 0;
    for (const [req, res] of requestMap)
      response.addResult(renderRequest(++index, req, res));
    if (index)
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
      index: z.number().int().min(1).describe('Index of the request in the browser_network_requests listing, starting at 1'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    // Walked to the requested position rather than copied out: a long-lived
    // page accumulates thousands of requests, and only one entry is wanted.
    const requestMap = tab.requests();
    let entry: [playwright.Request, playwright.Response | null] | undefined;
    let position = 0;
    for (const candidate of requestMap) {
      if (++position === params.index) {
        entry = candidate;
        break;
      }
    }
    if (!entry) {
      response.addError(requestMap.size
        ? `Error: No network request with index ${params.index}. The current list is numbered 1 to ${requestMap.size}; run browser_network_requests for the up-to-date list.`
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

// Query parameters that carry a credential rather than a locator. An OAuth
// redirect (`?code=`), an implicit-flow fragment (`#access_token=`) and a
// presigned S3 link (`X-Amz-Signature`) all put live secrets in the URL, and
// browser_network_requests prints every URL it recorded.
const sensitiveParamWords = ['token', 'key', 'secret', 'password', 'passwd', 'signature', 'credential', 'auth', 'code', 'session', 'sig'];

function isSensitiveParamName(name: string): boolean {
  const lowered = name.toLowerCase();
  return sensitiveParamWords.some(word => lowered.includes(word));
}

function redactUrlSecrets(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Not parseable as a URL, so there are no components to redact and the
    // string is reported as recorded.
    return rawUrl;
  }
  // `https://user:pass@host/` — the password never has a reason to be shown,
  // and the username identifies the request well enough on its own.
  if (url.password)
    url.password = 'redacted';
  let redacted = false;
  for (const name of [...url.searchParams.keys()]) {
    if (!isSensitiveParamName(name))
      continue;
    url.searchParams.set(name, 'redacted');
    redacted = true;
  }
  // A fragment never reaches the server but is where implicit-flow tokens
  // land, and Playwright records it.
  if (url.hash && /(?:token|secret|password|signature|credential)/i.test(url.hash))
    url.hash = '#redacted';
  return redacted || url.password || url.hash === '#redacted' ? url.toString() : rawUrl;
}

function requestLine(index: number, request: playwright.Request): string {
  return `[${index}] [${request.method().toUpperCase()}] ${truncateDataUrls(redactUrlSecrets(request.url()))}`;
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

  // Use the buffer so the reported size is accurate for file uploads and other
  // non-UTF-8 payloads.
  const postData = request.postDataBuffer();
  if (postData?.length)
    result.push(...section('Request body', summarizeBody(postData, contentTypeOf(requestHeaders))));

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

// An enumeration alone cannot keep up with the header names real services
// invent, and every miss puts a live credential in the transcript verbatim. A
// name carrying any of these words is redacted whatever else it is called,
// which covers x-csrf-token, x-amz-security-token, x-goog-api-key,
// x-functions-key, api-key, x-refresh-token, www-authenticate and their
// vendor-specific relatives. False positives cost only a hidden value whose
// length is still reported.
const sensitiveHeaderWords = ['auth', 'token', 'key', 'secret', 'credential', 'session', 'cookie', 'password'];

export function isSensitiveHeaderName(name: string): boolean {
  const lowered = name.toLowerCase();
  if (sensitiveHeaderNames.has(lowered))
    return true;
  return sensitiveHeaderWords.some(word => lowered.includes(word));
}

function renderHeaders(headers: Record<string, string>): string[] {
  const names = Object.keys(headers).sort();
  if (!names.length)
    return ['<none>'];
  return names.map(name => {
    const value = headers[name];
    if (isSensitiveHeaderName(name))
      return `${name}: <redacted, ${value.length} characters>`;
    // `allHeaders()` joins repeated headers (`set-cookie` especially) with a
    // newline; keep one line per header so `name: value` stays parseable.
    return `${name}: ${truncateDataUrls(value).replace(newlines, '\\n')}`;
  });
}

function contentTypeOf(headers: Record<string, string>): string {
  // `allHeaders()` joins a repeated header with a comma, so only the first
  // media type and its parameters describe the payload.
  const first = (headers['content-type'] ?? '').split(',')[0];
  return first.split(';')[0].trim().toLowerCase();
}

function renderResponseBody(read: Read<Buffer> | undefined, mimeType: string): string[] {
  if (!read)
    return ['<empty>'];
  // Redirects, responses whose body the browser never retained, and bodies
  // still streaming all fail the read; the rest of the report is worth showing.
  return 'error' in read ? [`<body unavailable: ${read.error}>`] : summarizeBody(read.value, mimeType);
}

// Bodies can contain submitted credentials and private API data even when their
// content type looks harmless. Report useful diagnostics without placing any
// page-controlled body content in the MCP transcript.
function summarizeBody(body: Buffer, mimeType: string): string[] {
  if (!body.length)
    return ['<empty>'];
  return [`<redacted, ${body.length} bytes${mimeType ? `, ${mimeType}` : ''}>`];
}

export default [
  requests,
  requestDetails,
];
