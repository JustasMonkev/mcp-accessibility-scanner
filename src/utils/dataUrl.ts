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
const maxDataUrlMetadataLength = 120;

export function truncateDataUrl(url: string): string {
  const match = parseDataUrl(url, 0);
  if (!match)
    return url;
  return `${match.displayPrefix}...`;
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
    result += `${match.displayPrefix}...`;
    offset = end;
  }

  return result;
}

type DataUrlMatch = {
  payloadStart: number;
  displayPrefix: string;
  isBase64: boolean;
  isEmbeddedQueryValue: boolean;
  quote: '"' | '\'' | undefined;
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
  const delimiter = findDataUrlDelimiter(text, metadataStart);
  if (!delimiter)
    return;

  const metadata = text.slice(metadataStart, delimiter.start);
  if (!isValidDataUrlMetadata(metadata, isEncoded))
    return;

  const decodedMetadata = decodeDataUrlMetadata(metadata, isEncoded);
  return {
    payloadStart: delimiter.end,
    displayPrefix: dataUrlDisplayPrefix(text, start, metadata, decodedMetadata, delimiter, isEncoded),
    isBase64: decodedMetadata.toLowerCase().split(';').includes('base64'),
    isEmbeddedQueryValue: start > 0 && text[start - 1] === '=',
    quote: dataUrlQuoteAt(text, start),
  };
}

function findDataUrlDelimiter(text: string, offset: number): { start: number; end: number } | undefined {
  let position = offset;
  while (position < text.length) {
    const char = text[position];
    if (isLineBreak(char))
      return;
    if (char === ',')
      return { start: position, end: position + 1 };
    if (startsWithEncodedComma(text, position))
      return { start: position, end: position + 3 };
    position++;
  }
}

function dataUrlDisplayPrefix(text: string, start: number, metadata: string, decodedMetadata: string, delimiter: { start: number; end: number }, isEncoded: boolean): string {
  if (metadata.length <= maxDataUrlMetadataLength)
    return text.slice(start, delimiter.end);

  const compactMetadata = compactDataUrlMetadata(decodedMetadata);
  const delimiterText = text.slice(delimiter.start, delimiter.end);
  return `${text.slice(start, start + dataUrlPrefixLengthAt(text, start))}${encodeDataUrlMetadata(compactMetadata, isEncoded)}${delimiterText}`;
}

function compactDataUrlMetadata(decodedMetadata: string): string {
  const parts = decodedMetadata.split(';');
  const mediaType = parts[0]?.includes('/') ? parts[0] : '';
  const base64 = parts.some(part => part.toLowerCase() === 'base64') ? ';base64' : '';
  return `${mediaType}${base64}`;
}

function encodeDataUrlMetadata(metadata: string, isEncoded: boolean): string {
  return isEncoded ? encodeURIComponent(metadata) : metadata;
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
    if (match.isEmbeddedQueryValue && char === '&' && isQueryParamBoundary(text, match, end))
      break;
    if (match.isBase64 && char === '&')
      break;
    if (match.isBase64 && isBase64PayloadTerminator(char))
      break;
    if (!match.isBase64 && match.quote && char === match.quote && isQuotedDataUrlEnd(text, end))
      break;
    if (!match.isBase64 && !match.quote && isRawPayloadSuffixBoundary(text, match, end))
      break;
    end++;
  }
  return end;
}

function dataUrlQuoteAt(text: string, start: number): '"' | '\'' | undefined {
  const char = start > 0 ? text[start - 1] : undefined;
  return char === '"' || char === '\'' ? char : undefined;
}

function isLineBreak(char: string): boolean {
  return char === '\n' || char === '\r';
}

function isBase64PayloadTerminator(char: string): boolean {
  return /\s/.test(char) || ['"', '\'', '<', '>', ')', ']', '}', '`', ':'].includes(char);
}

function isQueryParamBoundary(text: string, match: DataUrlMatch, ampersand: number): boolean {
  if (!looksLikeQueryParam(text, ampersand + 1))
    return false;
  return match.isBase64 || isRawPayloadCompleteBefore(text, match.payloadStart, ampersand);
}

function isRawPayloadCompleteBefore(text: string, payloadStart: number, end: number): boolean {
  let position = end - 1;
  while (position >= payloadStart && /\s/.test(text[position]))
    position--;
  return text[position] === '>' || (position >= 2 && startsWithIgnoreCase(text, position - 2, '%3e'));
}

function isRawPayloadSuffixBoundary(text: string, match: DataUrlMatch, position: number): boolean {
  const char = text[position];
  return (/\s/.test(char) || char === ':') && isRawPayloadCompleteBefore(text, match.payloadStart, position);
}

function isQuotedDataUrlEnd(text: string, quote: number): boolean {
  let position = quote + 1;
  while (position < text.length && /[ \t]/.test(text[position]))
    position++;
  return position === text.length || isLineBreak(text[position]) || text[position] === '[';
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
