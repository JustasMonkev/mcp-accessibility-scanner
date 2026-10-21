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

import { describe, expect, it } from 'vitest';
import { createUrlRedactor, redactToolResult } from '../src/utils/urlRedaction.js';
import type { CallToolResult } from '@modelcontextprotocol/server';

describe('URL parameter redaction', () => {
  const redact = createUrlRedactor(['token']);

  it.each([
    ['https://example.test/path?token=secret&safe=a%2Bb', 'https://example.test/path?token=REDACTED&safe=a%2Bb'],
    ['https://example.test/?ToKeN=first&token=second', 'https://example.test/?ToKeN=REDACTED&token=REDACTED'],
    ['https://example.test/?token=&token&token=secret', 'https://example.test/?token=&token&token=REDACTED'],
    ['https://example.test/?token=a%26b%3Dc%20d%2C%29#safe=x', 'https://example.test/?token=REDACTED#safe=x'],
    ['https://example.test/#token=secret&safe=a%3Fb', 'https://example.test/#token=REDACTED&safe=a%3Fb'],
    ['https://example.test/?token=first#/route?TOKEN=second', 'https://example.test/?token=REDACTED#/route?TOKEN=REDACTED'],
    ['https://example.test/#/filter/status=active?token=secret&safe=1', 'https://example.test/#/filter/status=active?token=REDACTED&safe=1'],
    ['/next?token=secret&safe=%2Fhome', '/next?token=REDACTED&safe=%2Fhome'],
    ['login?token=secret', 'login?token=REDACTED'],
    ['#/route?token=secret', '#/route?token=REDACTED'],
    ['[Open](https://example.test/?token=secret).', '[Open](https://example.test/?token=REDACTED).'],
    ['See [Open](login?token=secret) now.', 'See [Open](login?token=REDACTED) now.'],
    ['<https://example.test/?token=secret>', '<https://example.test/?token=REDACTED>'],
    ['- /url: /next?token=secret\n- text: visible', '- /url: /next?token=REDACTED\n- text: visible'],
    ["await page.goto('/next?token=secret');", "await page.goto('/next?token=REDACTED');"],
    [JSON.stringify({ message: 'Fetch "https://example.test/?token=secret" now' }), JSON.stringify({ message: 'Fetch "https://example.test/?token=REDACTED" now' })],
    ['await page.evaluate(\'() => fetch("https://example.test/?token=secret")\');', 'await page.evaluate(\'() => fetch("https://example.test/?token=REDACTED")\');'],
    ['https://example.test/?tokens=visible&mytoken=visible&safe=token=visible', 'https://example.test/?tokens=visible&mytoken=visible&safe=token=visible'],
    ['https://example.test/token=visible#heading', 'https://example.test/token=visible#heading'],
  ])('preserves wrappers and unrelated parameters in %s', (input, expected) => {
    expect(redact?.(input)).toBe(expected);
  });

  it('uses escaped literal case-insensitive names, not regex patterns or decoded keys', () => {
    const redactNames = createUrlRedactor(['a.b', 'API KEY', '(a+)+$']);
    const input = '/next?a.b=one&aXb=visible&api key=two&(a+)+$=three&api+key=visible';
    expect(redactNames?.(input)).toBe('/next?a.b=REDACTED&aXb=visible&api key=REDACTED&(a+)+$=REDACTED&api+key=visible');
    expect(redact?.('/next?%74oken=visible&%2574oken=visible&token%ZZ=visible')).toBe('/next?%74oken=visible&%2574oken=visible&token%ZZ=visible');
  });

  it.each([' ', '\n', '"', "'", '<', '>', '(', ')', '[', ']', '`', '\\'])('follows the upstream delimiter policy, leaving suffixes after %j unchanged', delimiter => {
    expect(redact?.(`/next?token=first${delimiter}tail&safe=keep`)).toBe(`/next?token=REDACTED${delimiter}tail&safe=keep`);
  });

  it('matches parameter-shaped text without requiring a URL', () => {
    expect(redact?.('plain?token=secret then &TOKEN=another')).toBe('plain?token=REDACTED then &TOKEN=REDACTED');
  });

  it('is disabled by default or an empty list and reusable without accumulating regex state', () => {
    expect(createUrlRedactor()).toBeUndefined();
    expect(createUrlRedactor([])).toBeUndefined();
    const input = '/next?token=secret&token=second';
    const expected = '/next?token=REDACTED&token=REDACTED';
    expect(redact?.(input)).toBe(expected);
    expect(redact?.(input)).toBe(expected);
    expect(redact?.(expected)).toBe(expected);
  });
});

describe('tool result URL redaction', () => {
  it('copies nested string values without changing keys, original objects or protected content/metadata', () => {
    const url = '/next?token=secret';
    const result: Pick<CallToolResult, 'content' | 'structuredContent' | 'isError' | '_meta'> = {
      content: [
        { type: 'text', text: `Failure at ${url}` },
        { type: 'resource_link', uri: `https://example.test${url}`, name: url },
        { type: 'image', mimeType: 'image/png', data: url },
      ],
      structuredContent: { [url]: { nested: [url, { message: url }, 4, false, null] }, empty: '' },
      isError: true,
      _meta: { original: url },
    };
    const before = JSON.stringify(result);
    const redact = createUrlRedactor(['token']);
    expect(redactToolResult(result)).toBe(result);
    const redacted = redactToolResult(result, redact);
    expect(redacted.content[0]).toEqual({ type: 'text', text: 'Failure at /next?token=REDACTED' });
    expect(redacted.content.slice(1)).toEqual(result.content.slice(1));
    expect(redacted.structuredContent).toEqual({ [url]: { nested: ['/next?token=REDACTED', { message: '/next?token=REDACTED' }, 4, false, null] }, empty: '' });
    expect(redacted.isError).toBe(true);
    expect(redacted).toMatchObject({ _meta: { original: url } });
    expect(JSON.stringify(result)).toBe(before);
    expect(redactToolResult(redacted, redact)).toEqual(redacted);
  });
});
