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

import { createShortGuid } from './guid.js';

const unsafeFilePathCharacters = /[\x00-\x2C\x2E-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/g;

function sanitize(s: string): string {
  return s.replace(unsafeFilePathCharacters, '-');
}

export function sanitizeForFilePath(s: string) {
  const separator = s.lastIndexOf('.');
  if (separator === -1)
    return sanitize(s);
  return sanitize(s.substring(0, separator)) + '.' + sanitize(s.substring(separator + 1));
}

export function safeIsoTimestampForFileName(): string {
  const timestamp = new Date().toISOString();
  // YYYY-MM-DDTHH:mm:ss.sssZ only needs its colons replaced; expanded years
  // (+YYYYYY) take the general path.
  const safe = timestamp.length === 24 ? timestamp.replaceAll(':', '-') : sanitizeForFilePath(timestamp);
  return `${safe}-${createShortGuid()}`;
}

const utf8Encoder = new TextEncoder();
const utf8Scratch = new Uint8Array(64 * 1024);

export function truncateToUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0)
    return '';
  // Each UTF-16 code unit needs at least one UTF-8 byte.
  const prefix = value.length > maxBytes ? value.slice(0, maxBytes) : value;
  if (prefix.length === value.length && value.length * 3 <= maxBytes)
    return value;
  // encodeInto() stops before the first code point that does not fit and
  // counts a lone surrogate as its 3-byte U+FFFD replacement.
  const target = maxBytes <= utf8Scratch.length ? utf8Scratch.subarray(0, maxBytes) : new Uint8Array(maxBytes);
  const { read, written } = utf8Encoder.encodeInto(prefix, target);
  if (read === value.length)
    return value;
  // One byte per consumed unit means the prefix is ASCII.
  return copyPrefix(prefix.slice(0, read), written === read ? 'ascii' : 'utf16le');
}

// A download error can outlive its source. Detach the small prefix without
// normalizing lone surrogates, which a UTF-8 encode/decode would replace.
function copyPrefix(prefix: string, encoding: 'ascii' | 'utf16le' = 'utf16le'): string {
  return Buffer.from(prefix, encoding).toString(encoding);
}

export function truncateWithMarker(message: string, maxBytes: number): string {
  const bounded = truncateToUtf8Bytes(message, maxBytes);
  return bounded === message ? message : `${bounded}… [truncated]`;
}
