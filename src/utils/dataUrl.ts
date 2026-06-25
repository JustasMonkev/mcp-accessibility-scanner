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
  if (!startsWithIgnoreCase(url, 0, dataUrlPrefix) && !startsWithIgnoreCase(url, 0, encodedDataUrlPrefix))
    return url;

  const match = parseDataUrl(url, 0);
  if (!match)
    return url;
  return `${match.displayPrefix}...`;
}

export function truncateDataUrls(text: string): string {
  let result = '';
  let offset = 0;
  const lowerText = text.toLowerCase();

  while (offset < text.length) {
    const start = findDataUrlStart(text, lowerText, offset);
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

function findDataUrlStart(text: string, lowerText: string, offset: number): number {
  let start = nextDataUrlPrefix(lowerText, offset);
  while (start !== -1) {
    if (isDataUrlStartBoundary(text, start))
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
  const isEncodedPrefix = startsWithIgnoreCase(text, start, encodedDataUrlPrefix);
  const metadataStart = start + (isEncodedPrefix ? encodedDataUrlPrefix.length : dataUrlPrefix.length);
  const delimiter = findDataUrlDelimiter(text, metadataStart);
  if (!delimiter)
    return;

  const metadata = text.slice(metadataStart, delimiter.start);
  const isEncodedMetadata = isEncodedPrefix || containsPercentEncoding(metadata);
  if (!isValidDataUrlMetadata(metadata, isEncodedMetadata))
    return;

  const decodedMetadata = decodeDataUrlMetadata(metadata, isEncodedMetadata);
  return {
    payloadStart: delimiter.end,
    displayPrefix: dataUrlDisplayPrefix(text, start, metadata, decodedMetadata, delimiter, isEncodedMetadata),
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
    if (char === '&' && looksLikeQueryParam(text, position + 1))
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
  if (!decodedMetadata || /[\r\n]/.test(decodedMetadata) || /[\s"'<>()[\]{}]/.test(metadata))
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
    if (match.isBase64 && isEncodedPayloadTerminator(text, end))
      break;
    if (match.isBase64 && isBase64PayloadTerminator(char))
      break;
    if (!match.isBase64 && match.quote && char === match.quote && isQuotedDataUrlEnd(text, match, end))
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
  return text[position] === '>' || (position >= payloadStart + 2 && startsWithIgnoreCase(text, position - 2, '%3e'));
}

function isRawPayloadSuffixBoundary(text: string, match: DataUrlMatch, position: number): boolean {
  const char = text[position];
  if (/\s/.test(char))
    return !isRawMarkupPayload(text, match.payloadStart) || isRawPayloadCompleteBefore(text, match.payloadStart, position);
  if (isRawPayloadWrapperBoundary(text, match, position))
    return true;
  if (isEncodedPayloadTerminator(text, position))
    return isRawPayloadCompleteBefore(text, match.payloadStart, position) || isRawPayloadBoundarySuffix(text, position + 3);
  if (char !== ':')
    return false;
  if (isRawMarkupPayload(text, match.payloadStart) && !isRawPayloadCompleteBefore(text, match.payloadStart, position))
    return false;
  return looksLikeSourceLocationSuffix(text, position);
}

function isQuotedDataUrlEnd(text: string, match: DataUrlMatch, quote: number): boolean {
  return !isRawMarkupPayload(text, match.payloadStart) || isRawPayloadCompleteBefore(text, match.payloadStart, quote);
}

function isRawMarkupPayload(text: string, payloadStart: number): boolean {
  return text[payloadStart] === '<' || startsWithIgnoreCase(text, payloadStart, '%3c');
}

function looksLikeSourceLocationSuffix(text: string, colon: number): boolean {
  let position = colon + 1;
  if (!/\d/.test(text[position] || ''))
    return false;
  while (position < text.length && /\d/.test(text[position]))
    position++;
  return position === text.length || isLineBreak(text[position]) || /\s/.test(text[position]);
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

function containsPercentEncoding(text: string): boolean {
  return /%[0-9a-f]{2}/i.test(text);
}

function isDataUrlStartBoundary(text: string, start: number): boolean {
  if (start === 0)
    return true;
  if (!/[A-Za-z0-9_-]/.test(text[start - 1]))
    return true;

  const encodedChar = percentEncodedCharBefore(text, start);
  return !!encodedChar && !/[A-Za-z0-9_-]/.test(encodedChar);
}

function isRawPayloadWrapperBoundary(text: string, match: DataUrlMatch, position: number): boolean {
  return [')', ']', '}'].includes(text[position]) && (isRawPayloadCompleteBefore(text, match.payloadStart, position) || isRawPayloadBoundarySuffix(text, position + 1));
}

function isRawPayloadBoundarySuffix(text: string, offset: number): boolean {
  if (offset >= text.length)
    return true;
  const char = text[offset];
  return isLineBreak(char) || /\s/.test(char) || ['"', '\'', ')', ']', '}', '`'].includes(char) || (char === '&' && looksLikeQueryParam(text, offset + 1));
}

function isEncodedPayloadTerminator(text: string, position: number): boolean {
  const encodedChar = percentEncodedCharAt(text, position);
  return !!encodedChar && ['"', '\'', ')', ']', '}', '`'].includes(encodedChar);
}

function percentEncodedCharBefore(text: string, position: number): string | undefined {
  return position >= 3 ? percentEncodedCharAt(text, position - 3) : undefined;
}

function percentEncodedCharAt(text: string, position: number): string | undefined {
  if (position < 0 || text[position] !== '%' || !/^[0-9a-f]{2}$/i.test(text.slice(position + 1, position + 3)))
    return;
  return String.fromCharCode(Number.parseInt(text.slice(position + 1, position + 3), 16));
}

function startsWithIgnoreCase(text: string, position: number, value: string): boolean {
  return text.slice(position, position + value.length).toLowerCase() === value;
}
