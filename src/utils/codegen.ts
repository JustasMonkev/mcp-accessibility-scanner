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

export function escapeWithQuotes(text: string, char: string = '\'') {
  const stringified = JSON.stringify(text);
  if (char === '"')
    return stringified;
  const escapedText = stringified.substring(1, stringified.length - 1).replace(/\\"/g, '"');
  if (char === '\'')
    return char + escapedText.replace(/[']/g, '\\\'') + char;
  if (char === '`')
    return char + escapedText.replace(/[`]/g, '\\`') + char;
  throw new Error('Invalid escape char');
}

export function quote(text: string) {
  return escapeWithQuotes(text, '\'');
}

export function formatObject(value: unknown, indent = '  '): string {
  if (typeof value === 'string')
    return quote(value);
  if (Array.isArray(value))
    return `[${value.map(o => formatObject(o)).join(', ')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : 1);
    if (!entries.length)
      return '{}';
    const tokens = entries.map(([key, item]) => `${key}: ${formatObject(item)}`);
    return `{\n${indent}${tokens.join(`,\n${indent}`)}\n}`;
  }
  return String(value);
}

export function formatObjectOrVoid(value: unknown, indent = '  '): string {
  const result = formatObject(value, indent);
  return result === '{}' ? '' : result;
}
