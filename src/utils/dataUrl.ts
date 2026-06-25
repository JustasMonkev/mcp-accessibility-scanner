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

    const comma = text.indexOf(',', start);
    if (comma === -1) {
      result += text.slice(start, start + dataUrlPrefix.length);
      offset = start + dataUrlPrefix.length;
      continue;
    }

    const isBase64 = text.slice(start, comma).toLowerCase().includes(';base64');
    const end = findDataUrlEnd(text, comma + 1, isBase64);
    result += `${text.slice(start, comma + 1)}...`;
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

function findDataUrlEnd(text: string, offset: number, isBase64: boolean): number {
  let end = offset;
  while (end < text.length) {
    const char = text[end];
    if (isLineBreak(char))
      break;
    if (isBase64 && char === '&')
      break;
    if (isBase64 && isBase64PayloadTerminator(char))
      break;
    end++;
  }
  return end;
}

function isLineBreak(char: string): boolean {
  return char === '\n' || char === '\r';
}

function isBase64PayloadTerminator(char: string): boolean {
  return /\s/.test(char) || ['"', '\'', '<', '>', ')', ']', '}', '`'].includes(char);
}
