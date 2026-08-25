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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toMcpTool } from '../src/mcp/tool.js';
import { Response } from '../src/response.js';
import recorderTools from '../src/tools/recorder.js';

describe('Recorder tools', () => {
  const startTool = recorderTools.find(tool => tool.schema.name === 'browser_start_recording')!;
  const stopTool = recorderTools.find(tool => tool.schema.name === 'browser_stop_recording')!;
  let context: any;
  let page: any;

  beforeEach(() => {
    page = { bringToFront: vi.fn().mockResolvedValue(undefined) };
    context = {
      assertRecordingCanPersist: vi.fn(),
      ensureTab: vi.fn().mockResolvedValue({ page }),
      startRecording: vi.fn().mockResolvedValue(undefined),
      stopRecording: vi.fn().mockResolvedValue([]),
    };
  });

  it('starts recording and brings the page forward', async () => {
    const response = new Response(context, startTool.schema.name, {});

    await startTool.handle(context, {}, response);

    expect(context.startRecording).toHaveBeenCalledTimes(1);
    expect(page.bringToFront).toHaveBeenCalledTimes(1);
    expect(page.bringToFront.mock.invocationCallOrder[0]).toBeLessThan(context.startRecording.mock.invocationCallOrder[0]);
    expect(response.result()).toContain('Recording started');
  });

  it('rejects unsafe stateless recording before opening a tab', async () => {
    context.assertRecordingCanPersist.mockImplementation(() => { throw new Error('browserSessionId required'); });

    await expect(startTool.handle(context, {}, new Response(context, startTool.schema.name, {})))
        .rejects.toThrow('browserSessionId required');
    expect(context.ensureTab).not.toHaveBeenCalled();
  });

  it('returns recorded JavaScript and includes a snapshot', async () => {
    context.stopRecording.mockResolvedValue(["await page.getByRole('button').click();"]);
    const response = new Response(context, stopTool.schema.name, {});
    const includeSnapshot = vi.spyOn(response, 'setIncludeSnapshot');

    await stopTool.handle(context, {}, response);

    expect(response.result()).toContain("```js\nawait page.getByRole('button').click();\n```");
    expect(includeSnapshot).toHaveBeenCalledTimes(1);
  });

  it('reports an empty recording and rejects stop without start', async () => {
    const emptyResponse = new Response(context, stopTool.schema.name, {});
    await stopTool.handle(context, {}, emptyResponse);
    expect(emptyResponse.result()).toContain('No actions were recorded');

    context.stopRecording.mockResolvedValue(undefined);
    await expect(stopTool.handle(context, {}, new Response(context, stopTool.schema.name, {})))
        .rejects.toThrow('No recording in progress');
  });

  it('keeps both tools behind the devtools capability', () => {
    expect(recorderTools).toHaveLength(2);
    expect(recorderTools.every(tool => tool.capability === 'devtools')).toBe(true);
    expect(startTool.schema.type).toBe('stateChanging');
    expect(stopTool.schema.type).toBe('destructive');
    expect(toMcpTool(startTool.schema).annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(toMcpTool(stopTool.schema).annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });
});
