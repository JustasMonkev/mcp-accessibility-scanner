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
import { redactToolResult, redactUrlParams } from '../src/utils/urlRedaction.js';
import type { CallToolResult } from '@modelcontextprotocol/server';

describe('URL parameter redaction', () => {
  it.each([
    ['https://example.test/path?token=secret&safe=a%2Bb', 'https://example.test/path?token=REDACTED&safe=a%2Bb'],
    ['https://example.test/?ToKeN=first&token=second', 'https://example.test/?ToKeN=REDACTED&token=REDACTED'],
    ['https://example.test/?%74oKeN=secret&%2574oken=visible', 'https://example.test/?%74oKeN=REDACTED&%2574oken=visible'],
    ['https://example.test/?token=&token&token=secret', 'https://example.test/?token=&token&token=REDACTED'],
    ['https://example.test/?token=a%26b%3Dc%20d%2C%29#safe=x', 'https://example.test/?token=REDACTED#safe=x'],
    ['https://example.test/?token=https://nested.test/?x=secret&safe=1', 'https://example.test/?token=REDACTED&safe=1'],
    ['https://example.test/#token=secret&safe=a%3Fb', 'https://example.test/#token=REDACTED&safe=a%3Fb'],
    ['https://example.test/#/route?token=secret&safe=1', 'https://example.test/#/route?token=REDACTED&safe=1'],
    ['https://example.test/?token=first#/route?TOKEN=second', 'https://example.test/?token=REDACTED#/route?TOKEN=REDACTED'],
    ['/next?token=secret&safe=%2Fhome', '/next?token=REDACTED&safe=%2Fhome'],
    ['./next?token=secret', './next?token=REDACTED'],
    ['../next?token=secret', '../next?token=REDACTED'],
    ['?token=secret', '?token=REDACTED'],
    ['#token=secret', '#token=REDACTED'],
    ['#/route?token=secret', '#/route?token=REDACTED'],
    ['[Open](https://example.test/?token=secret).', '[Open](https://example.test/?token=REDACTED).'],
    ['Link (https://example.test/?token=secret), then continue.', 'Link (https://example.test/?token=REDACTED), then continue.'],
    ['{"url":"https://example.test/?token=secret","count":1}', '{"url":"https://example.test/?token=REDACTED","count":1}'],
    ['- /url: /next?token=secret\n- text: visible', '- /url: /next?token=REDACTED\n- text: visible'],
    ['await page.goto(\'/next?token=secret\');', 'await page.goto(\'/next?token=REDACTED\');'],
    ['https://example.test/?tokens=visible&mytoken=visible&safe=token=visible', 'https://example.test/?tokens=visible&mytoken=visible&safe=token=visible'],
    ['https://example.test/token=visible#heading', 'https://example.test/token=visible#heading'],
    ['token=visible; why?token=visible; plain prose.', 'token=visible; why?token=visible; plain prose.'],
    ['https://example.test/?token%ZZ=visible', 'https://example.test/?token%ZZ=visible'],
  ])('preserves URL syntax and unrelated text in %s', (input, expected) => {
    expect(redactUrlParams(input, ['token'])).toBe(expected);
  });

  it('matches decoded literal names, not regular expressions or substrings', () => {
    const input = '/next?a.b=one&aXb=visible&api+key=two&%28a%2B%29%2B%24=three';
    expect(redactUrlParams(input, ['a.b', 'API KEY', '(a+)+$'])).toBe('/next?a.b=REDACTED&aXb=visible&api+key=REDACTED&%28a%2B%29%2B%24=REDACTED');
  });

  it('uses forgiving one-pass query decoding for malformed escapes without rewriting them', () => {
    expect(redactUrlParams('/next?%74oken%=secret&%2574oken=visible&??=third', ['token%', '??'])).toBe('/next?%74oken%=REDACTED&%2574oken=visible&??=REDACTED');
  });

  it.each([
    ['login?token=relative-secret', 'login?token=REDACTED'],
    ['- /url: login?token=relative-secret', '- /url: login?token=REDACTED'],
    ["await page.goto('login?token=relative-secret');", "await page.goto('login?token=REDACTED');"],
    ['/next?token=!!!', '/next?token=REDACTED'],
    ['/next?token=secret,.;!', '/next?token=REDACTED'],
    ["https://example.test/?token=apostrophe'secret&safe=keep", 'https://example.test/?token=REDACTED&safe=keep'],
    ["- /url: /next?token=apostrophe'secret&safe=keep", '- /url: /next?token=REDACTED&safe=keep'],
    ['- /url: /next?token=space secret&safe=keep', '- /url: /next?token=REDACTED&safe=keep'],
    ['- /url: /next?token=double"secret&safe=keep', '- /url: /next?token=REDACTED&safe=keep'],
    ['- /url: "/next?token=alpha: secret&safe=keep"', '- /url: "/next?token=REDACTED&safe=keep"'],
    ['- /url: /next?safe=space kept&token=secret\r\n', '- /url: /next?safe=space kept&token=REDACTED\r\n'],
    ["await page.goto('https://example.test/?token=apostrophe\\'secret&safe=keep');", "await page.goto('https://example.test/?token=REDACTED&safe=keep');"],
    ['<https://example.test/?token=secret>', '<https://example.test/?token=REDACTED>'],
    ['[Open](https://example.test/?token=paren(secret)), next.', '[Open](https://example.test/?token=REDACTED), next.'],
    ['`/next?token=secret`', '`/next?token=REDACTED`'],
  ])('masks complete values while preserving actual wrappers in %s', (input, expected) => {
    expect(redactUrlParams(input, ['token'])).toBe(expected);
  });

  it('preserves parseable JSON and JavaScript quoting while masking escaped value tails', () => {
    const json = JSON.stringify({ url: 'https://example.test/?token=double"secret&safe=keep', message: 'Error https://example.test/?token=secret retry later' });
    const redacted = redactUrlParams(json, ['token']);
    expect(JSON.parse(redacted)).toEqual({ url: 'https://example.test/?token=REDACTED&safe=keep', message: 'Error https://example.test/?token=REDACTED retry later' });
    const code = "await page.goto('https://example.test/?token=apostrophe\\'secret&safe=keep');";
    expect(redactUrlParams(code, ['token'])).toBe("await page.goto('https://example.test/?token=REDACTED&safe=keep');");
  });

  it('keeps default output unchanged and is idempotent when enabled', () => {
    const input = '/next?token=secret&token=second';
    expect(redactUrlParams(input)).toBe(input);
    expect(redactUrlParams(input, [])).toBe(input);
    const redacted = redactUrlParams(input, ['token']);
    expect(redactUrlParams(redacted, ['token'])).toBe(redacted);
  });

  it('handles long unmatched text and many parameter fields without user-controlled patterns', () => {
    const input = 'a'.repeat(100_000) + '/not-a-url ' + '/next?' + 'safe=value&'.repeat(10_000) + 'token=secret';
    expect(redactUrlParams(input, ['(a+)+$', 'token'])).toBe(input.replace('token=secret', 'token=REDACTED'));
  });
});

describe('tool result URL redaction', () => {
  it('copies nested string values without changing keys, original objects or resource/image content', () => {
    const url = '/next?token=secret';
    const result: Pick<CallToolResult, 'content' | 'structuredContent' | 'isError'> = {
      content: [
        { type: 'text', text: `Failure at ${url}` },
        { type: 'resource_link', uri: `https://example.test${url}`, name: url },
        { type: 'image', mimeType: 'image/png', data: url },
      ],
      structuredContent: { [url]: { nested: [url, { message: url }, 4, false, null] }, empty: '' },
      isError: true,
    };
    const before = JSON.stringify(result);
    const redacted = redactToolResult(result, ['token']);
    expect(redacted.content[0]).toEqual({ type: 'text', text: 'Failure at /next?token=REDACTED' });
    expect(redacted.content.slice(1)).toEqual(result.content.slice(1));
    expect(redacted.structuredContent).toEqual({ [url]: { nested: ['/next?token=REDACTED', { message: '/next?token=REDACTED' }, 4, false, null] }, empty: '' });
    expect(redacted.isError).toBe(true);
    expect(JSON.stringify(result)).toBe(before);
    expect(redactToolResult(redacted, ['token'])).toEqual(redacted);
  });
});
