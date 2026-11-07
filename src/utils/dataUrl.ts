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
  base64SuffixBoundary?: number;
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
  if (!isValidDataUrlMetadata(metadata, isEncodedMetadata))
    return;

  const decodedMetadata = decodeDataUrlPart(metadata, isEncodedMetadata);
  return {
    payloadStart: delimiter.markupStart ?? delimiter.end,
    displayPrefix: dataUrlDisplayPrefix(text, start, delimiter, { raw: metadata, decoded: decodedMetadata, isEncoded: isEncodedMetadata }),
    isBase64: delimiter.markupStart === undefined && decodedMetadata.toLowerCase().split(';').includes('base64'),
    base64SuffixBoundary: delimiter.base64SuffixBoundary,
    isEmbeddedQueryValue: start > 0 && text[start - 1] === '=',
    quote: dataUrlQuoteAt(text, start),
  };
}

const dataUrlDelimiterPattern = /[,\s"'<>()[\]{}&]|%2c/gi;
const base64BeforeOuterSuffix = /(?:[a-z0-9+/_=-]|%[0-9a-f]{2})*(?=[&#])/iy;

type DataUrlDelimiter = { start: number; end: number; markupStart?: number; base64SuffixBoundary?: number };

function findDataUrlDelimiter(text: string, offset: number): DataUrlDelimiter | undefined {
  dataUrlDelimiterPattern.lastIndex = offset;
  let encodedDelimiter: DataUrlDelimiter | undefined;
  for (let match = dataUrlDelimiterPattern.exec(text); match; match = dataUrlDelimiterPattern.exec(text)) {
    if (match[0] === ',') {
      if (!encodedDelimiter)
        return { start: match.index, end: match.index + 1 };
      // A later delimiter may begin markup or base64 after an escaped MIME parameter.
      // Keep it out of the preview: text after the first comma may already be payload.
      const payloadStart = match.index + 1;
      if (isRawMarkupPayload(text, payloadStart)) {
        encodedDelimiter.markupStart = payloadStart;
      } else if (/(?:;|%3b)base64$/i.test(text.slice(encodedDelimiter.end, match.index))) {
        base64BeforeOuterSuffix.lastIndex = payloadStart;
        const payload = base64BeforeOuterSuffix.exec(text)?.[0];
        if (payload === '' || (payload && /^[a-z0-9+/_-]+={0,2}$/i.test(decodeDataUrlPart(payload, true))))
          encodedDelimiter.base64SuffixBoundary = base64BeforeOuterSuffix.lastIndex;
      }
      return encodedDelimiter;
    }
    if (match[0].length === 3) {
      if (encodedDelimiter)
        continue;
      encodedDelimiter = { start: match.index, end: match.index + 3 };
      const metadata = text.slice(offset, match.index);
      const parameterStart = metadata.search(/;|%3b/i);
      if (parameterStart === -1 || !/(?:=|%3d)/i.test(metadata.slice(parameterStart + 1)))
        return encodedDelimiter;
      continue;
    }
    if (match[0] !== '&' || looksLikeQueryParam(text, match.index + 1))
      break;
  }
  return encodedDelimiter;
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

function isValidDataUrlMetadata(metadata: string, isEncoded: boolean): boolean {
  if (!metadata)
    return true;
  const decodedMetadata = decodeDataUrlPart(metadata, isEncoded);
  if (!decodedMetadata || /[\r\n]/.test(decodedMetadata) || /[\s"'<>()[\]{}]/.test(metadata))
    return false;
  if (decodedMetadata.startsWith(';'))
    return true;

  const mediaTypeEnd = decodedMetadata.indexOf(';');
  const mediaType = mediaTypeEnd === -1 ? decodedMetadata : decodedMetadata.slice(0, mediaTypeEnd);
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mediaType);
}

function decodeDataUrlPart(text: string, isEncoded: boolean): string {
  if (!isEncoded)
    return text;
  try {
    return decodeURIComponent(text);
  } catch {
    return '';
  }
}

const encodedQueryParamPattern = /%26(?:[a-z0-9_.~+-]|%(?!26|23|3d)[0-9a-f]{2})+%3d/iy;

function findDataUrlEnd(text: string, match: DataUrlMatch): number {
  let end = match.payloadStart;
  while (end < text.length) {
    const char = text[end];
    if (isLineBreak(char))
      break;
    if (end === match.base64SuffixBoundary && char === '#')
      break;
    if (match.isEmbeddedQueryValue && char === '&' && isQueryParamBoundary(text, match, end))
      break;
    if (match.isBase64 && (char === '&' || char === '#'))
      break;
    if (match.isBase64 && char === '%') {
      encodedQueryParamPattern.lastIndex = end;
      if (isEncodedPayloadTerminator(text, end) || startsWithIgnoreCase(text, end, '%23') || encodedQueryParamPattern.test(text))
        break;
    }
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
  switch (char) {
    case '"': case '\'': case '<': case '>':
    case ')': case ']': case '}': case '`': case ':':
      return true;
    default:
      return isWhitespace(char);
  }
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function isQueryParamBoundary(text: string, match: DataUrlMatch, ampersand: number): boolean {
  if (!looksLikeQueryParam(text, ampersand + 1))
    return false;
  return match.isBase64 || ampersand === match.base64SuffixBoundary || isRawPayloadCompleteBefore(text, match.payloadStart, ampersand);
}

function isRawPayloadCompleteBefore(text: string, payloadStart: number, end: number): boolean {
  let position = end - 1;
  while (position >= payloadStart && isWhitespace(text[position]))
    position--;
  return text[position] === '>' || (position >= payloadStart + 2 && startsWithIgnoreCase(text, position - 2, '%3e'));
}

function isRawPayloadSuffixBoundary(text: string, match: DataUrlMatch, position: number): boolean {
  const char = text[position];
  if (isWhitespace(char))
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
  return position === text.length || isLineBreak(text[position]) || isWhitespace(text[position]);
}

function looksLikeQueryParam(text: string, offset: number): boolean {
  if (offset >= text.length)
    return false;
  for (let position = offset; position < text.length; position++) {
    const char = text[position];
    if (char === '=')
      return position > offset;
    if (isLineBreak(char) || isWhitespace(char) || ['&', '#', '"', '\'', '<', '>', ')', '}', '`'].includes(char))
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
  return [')', ']', '}'].includes(text[position]) && (isRawPayloadCompleteBefore(text, match.payloadStart, position) || isRawPayloadBoundarySuffix(text, position + 1));
}

function isRawPayloadBoundarySuffix(text: string, offset: number): boolean {
  if (offset >= text.length)
    return true;
  const char = text[offset];
  return isLineBreak(char) || isWhitespace(char) || ['"', '\'', ')', ']', '}', '`'].includes(char) || (char === '&' && looksLikeQueryParam(text, offset + 1));
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
