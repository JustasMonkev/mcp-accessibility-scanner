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

import { afterEach, expect, it, vi } from 'vitest';
import { printToolResult } from '../src/utils/terminal.js';
import { createUrlRedactor } from '../src/utils/urlRedaction.js';

afterEach(() => vi.restoreAllMocks());

it.each([false, true])('prints interactive text and resource links to the correct stream (isError: %s)', isError => {
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  printToolResult({
    isError,
    content: [
      { type: 'text', text: 'Audit details' },
      { type: 'resource_link', name: 'report.json', uri: 'file:///tmp/report.json' },
      { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
    ],
  });
  expect((isError ? stdout : stderr).mock.calls).toEqual([]);
  expect((isError ? stderr : stdout).mock.calls).toEqual([
    ['Audit details'],
    ['Resource link: report.json (file:///tmp/report.json)'],
  ]);
});

it('redacts resource links when rendering without modifying their usable URLs', () => {
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  const link = { type: 'resource_link' as const, name: 'report?token=name-secret', uri: 'https://example.com/report?token=uri-secret&format=json' };
  printToolResult({ content: [link] }, createUrlRedactor(['token']));
  expect(stdout.mock.calls).toEqual([['Resource link: report?token=REDACTED (https://example.com/report?token=REDACTED&format=json)']]);
  expect(link.uri).toBe('https://example.com/report?token=uri-secret&format=json');
});
