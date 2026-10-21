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

import type { CallToolResult } from '@modelcontextprotocol/server';

type ToolResult = Pick<CallToolResult, 'content' | 'structuredContent' | 'isError'>;

export function redactUrlParams(text: string, names?: readonly string[]): string {
  if (!names?.length)
    return text;
  return redactText(text, new Set(names.map(name => name.toLowerCase())));
}

export function redactToolResult(result: ToolResult, names?: readonly string[]): ToolResult {
  if (!names?.length)
    return result;
  const selected = new Set(names.map(name => name.toLowerCase()));
  const redactEntries = (entries: [string, unknown][]): Record<string, unknown> => Object.fromEntries(entries.map(([key, item]) => [key, redactValue(item)]));
  const redactValue = (value: unknown): unknown => {
    if (typeof value === 'string')
      return redactText(value, selected);
    if (Array.isArray(value))
      return value.map(redactValue);
    if (value && typeof value === 'object')
      return redactEntries(Object.entries(value));
    return value;
  };
  return {
    ...result,
    content: result.content.map(item => item.type === 'text' ? { ...item, text: redactText(item.text, selected) } : item),
    structuredContent: result.structuredContent ? redactEntries(Object.entries(result.structuredContent)) : result.structuredContent,
  };
}

function redactText(text: string, names: ReadonlySet<string>): string {
  text = text.replace(/^([ \t]*(?:- )?\/url:[ \t]*)(.*)$/gm, (_match, prefix: string, value: string) => {
    const lineEnd = value.endsWith('\r') ? '\r' : '';
    const field = lineEnd ? value.slice(0, -1) : value;
    const first = field[0];
    const quoted = (first === '"' || first === "'") && field.endsWith(first);
    return prefix + (quoted ? first + redactUrl(field.slice(1, -1), names) + first : redactUrl(field, names)) + lineEnd;
  });
  const start = /(?:[a-z][a-z0-9+.-]*:\/\/|\.{0,2}\/|[?#])/iyu;
  const relativeLeaf = /[\p{L}\p{N}_%~.-][^\s<>"'`\\()[\]{},;:=?#]*[?#]/iyu;
  const wholeToken = !/\s/.test(text);
  const boundaries = " \t\r\n\"'`(<[{=,:";
  const parts: string[] = [];
  let copied = 0;
  let quote: string | undefined;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const previous = text[index - 1];
    const directQuote = quote !== undefined && previous === quote;
    start.lastIndex = index;
    relativeLeaf.lastIndex = index;
    if ((index === 0 || boundaries.includes(previous)) && (start.test(text) || ((wholeToken || directQuote) && relativeLeaf.test(text)))) {
      const closing = previous === '(' ? ')' : previous === '[' ? ']' : previous === '{' ? '}' : undefined;
      let depth = 1;
      let end = index;
      while (end < text.length) {
        const next = text[end];
        if ((!directQuote && /\s/.test(next)) || next === '<' || next === '>')
          break;
        if (quote && next === '\\' && end + 1 < text.length) {
          end += 2;
          continue;
        }
        if (quote && next === quote)
          break;
        if (closing) {
          if (next === previous)
            depth++;
          else if (next === closing && --depth === 0)
            break;
        }
        end++;
      }
      parts.push(text.slice(copied, index), redactUrl(text.slice(index, end), names));
      copied = end;
      index = end;
      continue;
    }
    if (char === '\n' || char === '\r') {
      quote = undefined;
    } else if (quote && char === '\\') {
      index += 2;
      continue;
    } else if (char === quote) {
      quote = undefined;
    } else if (!quote && (char === '"' || char === "'" || (char === '`' && text[index - 1] !== '`' && text[index + 1] !== '`')) && (index === 0 || boundaries.includes(text[index - 1]))) {
      quote = char;
    }
    index++;
  }
  parts.push(text.slice(copied));
  return parts.join('');
}

function redactUrl(url: string, names: ReadonlySet<string>): string {
  const hash = url.indexOf('#');
  const beforeHash = hash === -1 ? url : url.slice(0, hash);
  const query = beforeHash.indexOf('?');
  const redacted = query === -1 ? beforeHash : beforeHash.slice(0, query + 1) + redactFields(beforeHash.slice(query + 1), names);
  if (hash === -1)
    return redacted;
  const fragment = url.slice(hash + 1);
  const question = fragment.indexOf('?');
  const equals = fragment.indexOf('=');
  const fieldsStart = question !== -1 && (equals === -1 || question < equals) ? question + 1 : 0;
  return redacted + '#' + fragment.slice(0, fieldsStart) + redactFields(fragment.slice(fieldsStart), names);
}

function redactFields(text: string, names: ReadonlySet<string>): string {
  return text.split('&').map(field => {
    const equals = field.indexOf('=');
    if (equals === -1 || equals === field.length - 1)
      return field;
    const key = field.slice(0, equals);
    const decoded = new URLSearchParams('key=' + key).get('key') ?? key;
    return names.has(decoded.toLowerCase()) ? field.slice(0, equals + 1) + 'REDACTED' : field;
  }).join('&');
}
