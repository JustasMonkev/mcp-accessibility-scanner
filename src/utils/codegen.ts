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

// adapted from:
// - https://github.com/microsoft/playwright/blob/76ee48dc9d4034536e3ec5b2c7ce8be3b79418a8/packages/playwright-core/src/utils/isomorphic/stringUtils.ts
// - https://github.com/microsoft/playwright/blob/76ee48dc9d4034536e3ec5b2c7ce8be3b79418a8/packages/playwright-core/src/server/codegen/javascript.ts

// NOTE: this function should not be used to escape any selectors.
export function escapeWithQuotes(text: string, char: string = '\'') {
  const stringified = JSON.stringify(text);
  const escapedText = stringified.substring(1, stringified.length - 1).replace(/\\"/g, '"');
  if (char === '\'')
    return char + escapedText.replace(/[']/g, '\\\'') + char;
  if (char === '"')
    return char + escapedText.replace(/["]/g, '\\"') + char;
  if (char === '`')
    return char + escapedText.replace(/[`]/g, '\\`') + char;
  throw new Error('Invalid escape char');
}

export function quote(text: string) {
  return escapeWithQuotes(text, '\'');
}

export function formatObject(value: any, indent = '  '): string {
  if (typeof value === 'string')
    return quote(value);
  if (Array.isArray(value))
    return `[${value.map(o => formatObject(o)).join(', ')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
    if (!keys.length)
      return '{}';
    const tokens: string[] = [];
    for (const key of keys) {
      const keyToken = /^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key);
      tokens.push(`${keyToken}: ${formatObject(value[key])}`);
    }
    return `{\n${indent}${tokens.join(`,\n${indent}`)}\n}`;
  }
  return String(value);
}

// Formats an options object for code generation, returning an empty string
// when every property is undefined (i.e. there are no options to emit).
export function formatObjectOrVoid(value: any, indent = '  '): string {
  const result = formatObject(value, indent);
  return result === '{}' ? '' : result;
}
