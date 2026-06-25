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
const encodedDataUrlPrefix = 'data%3a';

export function truncateDataUrl(url: string): string {
  const match = parseDataUrl(url, 0);
  if (!match)
    return url;
  return `${url.slice(0, match.payloadStart)}...`;
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

    const match = parseDataUrl(text, start);
    if (!match) {
      const prefixLength = dataUrlPrefixLengthAt(text, start);
      result += text.slice(start, start + prefixLength);
      offset = start + prefixLength;
      continue;
    }

    const end = findDataUrlEnd(text, match);
    result += `${text.slice(start, match.payloadStart)}...`;
    offset = end;
  }

  return result;
}

type DataUrlMatch = {
  payloadStart: number;
  isBase64: boolean;
  isEmbeddedQueryValue: boolean;
};

function findDataUrlStart(text: string, offset: number): number {
  const lowerText = text.toLowerCase();
  let start = nextDataUrlPrefix(lowerText, offset);
  while (start !== -1) {
    if (start === 0 || !/[A-Za-z0-9_-]/.test(text[start - 1]))
      return start;
    start = nextDataUrlPrefix(lowerText, start + dataUrlPrefixLengthAt(lowerText, start));
  }
  return -1;
}

function nextDataUrlPrefix(lowerText: string, offset: number): number {
  const literalStart = lowerText.indexOf(dataUrlPrefix, offset);
  const encodedStart = lowerText.indexOf(encodedDataUrlPrefix, offset);
  if (literalStart === -1)
    return encodedStart;
  if (encodedStart === -1)
    return literalStart;
  return Math.min(literalStart, encodedStart);
}

function dataUrlPrefixLengthAt(text: string, start: number): number {
  return startsWithIgnoreCase(text, start, encodedDataUrlPrefix) ? encodedDataUrlPrefix.length : dataUrlPrefix.length;
}

function parseDataUrl(text: string, start: number): DataUrlMatch | undefined {
  const isEncoded = startsWithIgnoreCase(text, start, encodedDataUrlPrefix);
  const metadataStart = start + (isEncoded ? encodedDataUrlPrefix.length : dataUrlPrefix.length);
  const delimiter = findDataUrlDelimiter(text, metadataStart, isEncoded);
  if (!delimiter)
    return;

  const metadata = text.slice(metadataStart, delimiter.start);
  if (!isValidDataUrlMetadata(metadata, isEncoded))
    return;

  const decodedMetadata = decodeDataUrlMetadata(metadata, isEncoded);
  return {
    payloadStart: delimiter.end,
    isBase64: decodedMetadata.toLowerCase().split(';').includes('base64'),
    isEmbeddedQueryValue: start > 0 && text[start - 1] === '=',
  };
}

function findDataUrlDelimiter(text: string, offset: number, isEncoded: boolean): { start: number; end: number } | undefined {
  let position = offset;
  while (position < text.length) {
    const char = text[position];
    if (isLineBreak(char))
      return;
    if (char === ',')
      return { start: position, end: position + 1 };
    if (isEncoded && startsWithEncodedComma(text, position))
      return { start: position, end: position + 3 };
    position++;
  }
}

function isValidDataUrlMetadata(metadata: string, isEncoded: boolean): boolean {
  if (!metadata)
    return true;
  const decodedMetadata = decodeDataUrlMetadata(metadata, isEncoded);
  if (!decodedMetadata || /[\s"'<>()[\]{}]/.test(decodedMetadata))
    return false;
  if (decodedMetadata.startsWith(';'))
    return true;

  const mediaTypeEnd = decodedMetadata.indexOf(';');
  const mediaType = mediaTypeEnd === -1 ? decodedMetadata : decodedMetadata.slice(0, mediaTypeEnd);
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mediaType);
}

function decodeDataUrlMetadata(metadata: string, isEncoded: boolean): string {
  if (!isEncoded)
    return metadata;
  try {
    return decodeURIComponent(metadata);
  } catch {
    return '';
  }
}

function findDataUrlEnd(text: string, match: DataUrlMatch): number {
  let end = match.payloadStart;
  while (end < text.length) {
    const char = text[end];
    if (isLineBreak(char))
      break;
    if (match.isEmbeddedQueryValue && char === '&' && looksLikeQueryParam(text, end + 1))
      break;
    if (match.isBase64 && char === '&')
      break;
    if (match.isBase64 && isBase64PayloadTerminator(char))
      break;
    end++;
  }
  return end;
}

function isLineBreak(char: string): boolean {
  return char === '\n' || char === '\r';
}

function isBase64PayloadTerminator(char: string): boolean {
  return /\s/.test(char) || ['"', '\'', '<', '>', ')', ']', '}', '`', ':'].includes(char);
}

function looksLikeQueryParam(text: string, offset: number): boolean {
  if (offset >= text.length)
    return false;
  for (let position = offset; position < text.length; position++) {
    const char = text[position];
    if (char === '=')
      return position > offset;
    if (isLineBreak(char) || /\s/.test(char) || ['&', '#', '"', '\'', '<', '>', ')', '}', '`'].includes(char))
      return false;
  }
  return false;
}

function startsWithEncodedComma(text: string, position: number): boolean {
  return startsWithIgnoreCase(text, position, '%2c');
}

function startsWithIgnoreCase(text: string, position: number, value: string): boolean {
  return text.slice(position, position + value.length).toLowerCase() === value;
}
