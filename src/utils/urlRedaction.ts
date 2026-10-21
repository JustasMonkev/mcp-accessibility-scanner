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

export function createUrlRedactor(names?: readonly string[]) {
  if (!names?.length)
    return;
  const regex = new RegExp(`([?&#](?:${names.map(RegExp.escape).join('|')})=)[^&#\\s"'<>()\\[\\]\`\\\\]+`, 'gi');
  return (text: string) => text.replace(regex, '$1REDACTED');
}

export function redactToolResult(result: ToolResult, redactSecrets?: (text: string) => string): ToolResult {
  if (!redactSecrets)
    return result;
  return {
    ...result,
    content: result.content.map(item => item.type === 'text' ? { ...item, text: redactSecrets(item.text) } : item),
    structuredContent: result.structuredContent
      ? JSON.parse(JSON.stringify(result.structuredContent, (_key, value: unknown) => typeof value === 'string' ? redactSecrets(value) : value))
      : result.structuredContent,
  };
}
