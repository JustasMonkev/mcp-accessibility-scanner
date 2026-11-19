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

import type { ConsoleMessage } from '../tab.js';

const dataUrlPrefix = 'data:';
const encodedDataUrlPrefix = 'data%3a';
const maxDataUrlMetadataLength = 120;

const compactConsoleMessages = new WeakMap<ConsoleMessage, string>();

export function formatConsoleMessage(message: ConsoleMessage): string {
  const cached = compactConsoleMessages.get(message);
  if (cached !== undefined)
    return cached;
  const raw = message.toString();
  const formatted = truncateDataUrls(raw);
  if (formatted.length < raw.length)
    compactConsoleMessages.set(message, formatted);
  return formatted;
}

/** @public */
export function truncateDataUrl(url: string): string {
  if (!startsWithIgnoreCase(url, 0, dataUrlPrefix) && !startsWithIgnoreCase(url, 0, encodedDataUrlPrefix))
    return url;

  const match = parseDataUrl(url, 0);
  if (!match)
    return url;
  return `${match.displayPrefix}...`;
}

export function truncateDataUrls(text: string): string {
  let start = findDataUrlStart(text, 0);
  if (start === -1)
    return text;

  let result = '';
  let offset = 0;
  while (start !== -1) {
    result += text.slice(offset, start);

    const match = parseDataUrl(text, start);
    if (!match) {
      const prefixLength = dataUrlPrefixLengthAt(text, start);
      result += text.slice(start, start + prefixLength);
      offset = start + prefixLength;
    } else {
      result += `${match.displayPrefix}...`;
      offset = findDataUrlEnd(text, match);
    }
    start = findDataUrlStart(text, offset);
  }

  return result + text.slice(offset);
}

type DataUrlMatch = {
  payloadStart: number;
  displayPrefix: string;
  isBase64: boolean;
  isEmbeddedQueryValue: boolean;
  quote: '"' | '\'' | undefined;
};

const dataUrlPrefixPattern = /data(?::|%3a)/gi;

function findDataUrlStart(text: string, offset: number): number {
  dataUrlPrefixPattern.lastIndex = offset;
  for (let match = dataUrlPrefixPattern.exec(text); match; match = dataUrlPrefixPattern.exec(text)) {
    if (isDataUrlStartBoundary(text, match.index))
      return match.index;
  }
  return -1;
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
  const decodedMetadata = decodeDataUrlMetadata(metadata, isEncodedMetadata);
  if (!isValidDataUrlMetadata(metadata, decodedMetadata))
    return;

  return {
    payloadStart: delimiter.end,
    displayPrefix: dataUrlDisplayPrefix(text, start, delimiter, { raw: metadata, decoded: decodedMetadata, isEncoded: isEncodedMetadata }),
    isBase64: decodedMetadata.toLowerCase().split(';').includes('base64'),
    isEmbeddedQueryValue: start > 0 && text[start - 1] === '=',
    quote: dataUrlQuoteAt(text, start),
  };
}

const dataUrlDelimiterPattern = /[,\s"'<>()[\]{}&]|%2c/gi;

function findDataUrlDelimiter(text: string, offset: number): { start: number; end: number } | undefined {
  dataUrlDelimiterPattern.lastIndex = offset;
  for (let match = dataUrlDelimiterPattern.exec(text); match; match = dataUrlDelimiterPattern.exec(text)) {
    if (match[0] === ',' || match[0].length === 3)
      return { start: match.index, end: match.index + match[0].length };
    if (match[0] !== '&' || looksLikeQueryParam(text, match.index + 1))
      return;
  }
}

type DataUrlMetadata = { raw: string, decoded: string, isEncoded: boolean };

function dataUrlDisplayPrefix(text: string, start: number, delimiter: { start: number; end: number }, metadata: DataUrlMetadata): string {
  if (metadata.raw.length <= maxDataUrlMetadataLength)
    return text.slice(start, delimiter.end);

  const scheme = text.slice(start, start + dataUrlPrefixLengthAt(text, start));
  const compactMetadata = encodeDataUrlMetadata(compactDataUrlMetadata(metadata.decoded), metadata.isEncoded);
  const delimiterText = text.slice(delimiter.start, delimiter.end);
  return `${scheme}${compactMetadata}${delimiterText}`;
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

function isValidDataUrlMetadata(metadata: string, decodedMetadata: string): boolean {
  if (!metadata)
    return true;
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

// Raw payloads can contain markup. Base64 payloads have an unconditional set of boundaries.
const base64PayloadEnd = /[\s"'<>)\]}`:&]|%(?:22|27|29|5d|7d|60)/gi;
const base64Alphabet = /[A-Za-z0-9+/=]*/y;
const quotedPayloadBoundary = /["'\r\n]/g;
const rawPayloadBoundary = /[\r\n:&)\]}]|[^\S\r\n]+|%(?:22|27|29|5d|7d|60)/gi;

function findDataUrlEnd(text: string, match: DataUrlMatch): number {
  if (match.isBase64) {
    // Skip the base64 alphabet, which cannot start a boundary, in one cheap pass.
    base64Alphabet.lastIndex = match.payloadStart;
    base64Alphabet.test(text);
    base64PayloadEnd.lastIndex = base64Alphabet.lastIndex;
    return base64PayloadEnd.exec(text)?.index ?? text.length;
  }

  const boundary = match.quote ? quotedPayloadBoundary : rawPayloadBoundary;
  boundary.lastIndex = match.payloadStart;
  const markup = isRawMarkupPayload(text, match.payloadStart);
  for (let candidate = boundary.exec(text); candidate; candidate = boundary.exec(text)) {
    const position = candidate.index;
    const char = text[position];
    if (isLineBreak(char))
      return position;
    if (match.quote) {
      if (char === match.quote && (!markup || isRawPayloadCompleteBefore(text, match.payloadStart, position)))
        return position;
    } else if (char === '&') {
      if (match.isEmbeddedQueryValue && isQueryParamBoundary(text, match, position))
        return position;
    } else if (isRawPayloadSuffixBoundary(text, match, position, markup)) {
      return position;
    }
  }
  return text.length;
}

function dataUrlQuoteAt(text: string, start: number): '"' | '\'' | undefined {
  const char = start > 0 ? text[start - 1] : undefined;
  return char === '"' || char === '\'' ? char : undefined;
}

function isLineBreak(char: string): boolean {
  return char === '\n' || char === '\r';
}

function isWhitespace(char: string | undefined): boolean {
  if (char === undefined)
    return false;
  const code = char.charCodeAt(0);
  if (code < 0x80)
    return code === 32 || (code >= 9 && code <= 13);
  return /\s/.test(char);
}

function isQueryParamBoundary(text: string, match: DataUrlMatch, ampersand: number): boolean {
  if (!looksLikeQueryParam(text, ampersand + 1))
    return false;
  return isRawPayloadCompleteBefore(text, match.payloadStart, ampersand);
}

function isRawPayloadCompleteBefore(text: string, payloadStart: number, end: number): boolean {
  let position = end - 1;
  while (position >= payloadStart && isWhitespace(text[position]))
    position--;
  return text[position] === '>' || (position >= payloadStart + 2 && startsWithIgnoreCase(text, position - 2, '%3e'));
}

function isRawPayloadSuffixBoundary(text: string, match: DataUrlMatch, position: number, markup: boolean): boolean {
  const char = text[position];
  if (isWhitespace(char))
    return !markup || isRawPayloadCompleteBefore(text, match.payloadStart, position);
  if (isRawPayloadWrapperBoundary(text, match, position))
    return true;
  if (char === '%')
    return isRawPayloadCompleteBefore(text, match.payloadStart, position) || isRawPayloadBoundarySuffix(text, position + 3);
  if (char !== ':')
    return false;
  if (markup && !isRawPayloadCompleteBefore(text, match.payloadStart, position))
    return false;
  return looksLikeSourceLocationSuffix(text, position);
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
  return position === text.length || isLineBreak(text[position]) || isWhitespace(text[position]);
}

const queryParamTerminators = ['&', '#', '"', '\'', '<', '>', ')', '}', '`'];
const boundarySuffixStarts = ['"', '\'', ')', ']', '}', '`'];
const wrapperClosers = [')', ']', '}'];

function looksLikeQueryParam(text: string, offset: number): boolean {
  if (offset >= text.length)
    return false;
  for (let position = offset; position < text.length; position++) {
    const char = text[position];
    if (char === '=')
      return position > offset;
    if (isLineBreak(char) || isWhitespace(char) || queryParamTerminators.includes(char))
      return false;
  }
  return false;
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
  return wrapperClosers.includes(text[position]) && (isRawPayloadCompleteBefore(text, match.payloadStart, position) || isRawPayloadBoundarySuffix(text, position + 1));
}

function isRawPayloadBoundarySuffix(text: string, offset: number): boolean {
  if (offset >= text.length)
    return true;
  const char = text[offset];
  return isLineBreak(char) || isWhitespace(char) || boundarySuffixStarts.includes(char) || (char === '&' && looksLikeQueryParam(text, offset + 1));
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
  if (position < 0 || position + value.length > text.length)
    return false;
  for (let index = 0; index < value.length; index++) {
    const char = text.charCodeAt(position + index);
    const expected = value.charCodeAt(index);
    if (char !== expected && !(char >= 65 && char <= 90 && char + 32 === expected))
      return false;
  }
  return true;
}
