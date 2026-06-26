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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import screenshotTools from '../src/tools/screenshot.js';
import { Response } from '../src/response.js';
import type { Context } from '../src/context.js';

describe('Screenshot Tools', () => {
  const screenshotTool = screenshotTools.find(t => t.schema.name === 'browser_take_screenshot')!;

  let mockContext: Context;
  let mockTab: any;
  let mockPage: any;
  let response: Response;

  beforeEach(() => {
    mockPage = {
      url: () => 'https://example.com',
      screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-image')),
    };

    mockTab = {
      page: mockPage,
      context: { outputFile: vi.fn().mockResolvedValue('/out/page.png') },
      modalStates: () => [],
    };

    mockContext = {
      currentTabOrDie: () => mockTab,
    } as any;

    response = new Response(mockContext, 'browser_take_screenshot', {});
  });

  it('should exist with the expected schema', () => {
    expect(screenshotTool).toBeDefined();
    expect(screenshotTool.schema.name).toBe('browser_take_screenshot');
    expect(screenshotTool.schema.type).toBe('readOnly');
  });

  it('should expose a scale option defaulting to css', () => {
    const params = screenshotTool.schema.inputSchema.parse({});
    expect(params.scale).toBe('css');
  });

  it('should reject an invalid scale value', () => {
    expect(() => screenshotTool.schema.inputSchema.parse({ scale: 'retina' })).toThrow();
  });

  it('should default the screenshot to css scale', async () => {
    const params = screenshotTool.schema.inputSchema.parse({});
    await screenshotTool.handle(mockContext, params, response);

    expect(mockPage.screenshot).toHaveBeenCalledWith(expect.objectContaining({ scale: 'css' }));
  });

  it('should pass device scale through to page.screenshot', async () => {
    const params = screenshotTool.schema.inputSchema.parse({ scale: 'device' });
    await screenshotTool.handle(mockContext, params, response);

    expect(mockPage.screenshot).toHaveBeenCalledWith(expect.objectContaining({ scale: 'device' }));
  });
});
