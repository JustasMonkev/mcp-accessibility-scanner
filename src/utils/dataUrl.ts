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

const dataUrlPrefix = 'data:';

export function truncateDataUrl(url: string): string {
  if (!url.startsWith(dataUrlPrefix))
    return url;
  const comma = url.indexOf(',');
  if (comma === -1)
    return url;
  return `${url.slice(0, comma + 1)}...`;
}

export function truncateDataUrls(text: string): string {
  let result = '';
  let offset = 0;

  while (offset < text.length) {
    const start = findDataUrlStart(text, offset);
    if (start === -1) {
      result += text.slice(offset);
      break;
    }

    result += text.slice(offset, start);

    let end = start;
    while (end < text.length && !isDataUrlTerminator(text[end]))
      end++;

    result += truncateDataUrl(text.slice(start, end));
    offset = end;
  }

  return result;
}

function findDataUrlStart(text: string, offset: number): number {
  let start = text.indexOf(dataUrlPrefix, offset);
  while (start !== -1) {
    if (start === 0 || !/[A-Za-z0-9_-]/.test(text[start - 1]))
      return start;
    start = text.indexOf(dataUrlPrefix, start + dataUrlPrefix.length);
  }
  return -1;
}

function isDataUrlTerminator(char: string): boolean {
  return /\s/.test(char) || ['"', '\'', '<', '>', ')', ']', '}', '`'].includes(char);
}
