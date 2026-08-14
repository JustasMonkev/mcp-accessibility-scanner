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

/**
 * Timestamp fragment for DEFAULT artifact file names (screenshots, PDFs,
 * reports, downloaded files). Carries a short random token besides the
 * sanitized ISO timestamp:
 * concurrent sessions (or overlapping calls) share one output directory, and
 * a timestamp alone let two artifacts produced in the same millisecond
 * overwrite each other. User-specified file names are never routed through
 * this helper.
 */
export function safeIsoTimestampForFileName(): string {
  return `${sanitizeForFilePath(new Date().toISOString())}-${createShortGuid()}`;
}

/**
 * Truncates `value` to at most `maxBytes` of UTF-8. Measured in bytes, not
 * characters — filesystem name limits are byte limits — and cut between code
 * points (surrogate pairs stay whole), so the result never ends in a split
 * UTF-8 sequence.
 */
export function truncateToUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0)
    return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes)
    return value;
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes)
      break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}
