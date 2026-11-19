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

export function sanitizeForFilePath(s: string) {
  const sanitize = (s: string) => s.replace(/[\x00-\x2C\x2E-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/g, '-');
  const separator = s.lastIndexOf('.');
  if (separator === -1)
    return sanitize(s);
  return sanitize(s.substring(0, separator)) + '.' + sanitize(s.substring(separator + 1));
}

export function safeIsoTimestampForFileName(): string {
  return `${sanitizeForFilePath(new Date().toISOString())}-${createShortGuid()}`;
}

export function truncateToUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0)
    return '';
  // Each UTF-16 code unit needs at least one UTF-8 byte.
  const prefix = value.length > maxBytes ? value.slice(0, maxBytes) : value;
  if (Buffer.byteLength(prefix, 'utf8') <= maxBytes) {
    if (value.length === prefix.length)
      return value;
    // A slice of maxBytes code units fits only when every unit is ASCII.
    return copyPrefix(prefix, 'ascii');
  }
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const width = utf8Width(character);
    if (bytes + width > maxBytes)
      break;
    bytes += width;
    end += character.length;
  }
  return copyPrefix(value.slice(0, end));
}

function utf8Width(character: string): number {
  if (character.length === 2)
    return 4;
  const unit = character.charCodeAt(0);
  if (unit < 0x80)
    return 1;
  return unit < 0x800 ? 2 : 3;
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
