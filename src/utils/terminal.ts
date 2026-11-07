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

export function printToolResult(result: CallToolResult, redactSecrets?: (text: string) => string): void {
  const print = result.isError ? printToStderr : printToStdout;
  for (const item of result.content) {
    let text: string;
    if (item.type === 'text')
      text = item.text;
    else if (item.type === 'resource_link')
      text = `Resource link: ${item.name} (${item.uri})`;
    else
      continue;
    print(redactSecrets?.(text) ?? text);
  }
}

export function printToStdout(text: string): void {
  console.log(text);
}

export function printToStderr(text: string): void {
  console.error(text);
}
