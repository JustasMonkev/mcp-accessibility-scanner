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

const dataUrlOutputTerminator = /[\s\]"'<)]/;

export function truncateDataUrl(url: string): string {
  if (!url.startsWith('data:'))
    return url;
  const comma = url.indexOf(',');
  if (comma === -1)
    return url;
  return url.slice(0, comma + 1) + '\u2026';
}

export function truncateDataUrlsInText(text: string): string {
  let result = '';
  let position = 0;

  while (position < text.length) {
    const start = text.indexOf('data:', position);
    if (start === -1) {
      result += text.slice(position);
      break;
    }

    result += text.slice(position, start);
    let end = start;
    while (end < text.length && !dataUrlOutputTerminator.test(text[end]))
      ++end;

    result += truncateDataUrl(text.slice(start, end));
    position = end;
  }

  return result;
}
