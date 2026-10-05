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
import { SessionLog } from '../src/sessionLog.js';
import recorderTools from '../src/tools/recorder.js';

describe('Recorder tools', () => {
  const startTool = recorderTools.find(tool => tool.schema.name === 'browser_start_recording')!;
  const stopTool = recorderTools.find(tool => tool.schema.name === 'browser_stop_recording')!;
  let context: any;
  let page: any;

  beforeEach(() => {
    page = { bringToFront: vi.fn().mockResolvedValue(undefined) };
    context = {
      config: {},
      ensureTab: vi.fn().mockResolvedValue({ page }),
      startRecordingOnCurrentTab: vi.fn().mockResolvedValue(undefined),
      stopRecording: vi.fn().mockResolvedValue([]),
    };
  });

  it('starts recording and brings the page forward', async () => {
    const response = new Response(context, startTool.schema.name, {});

    await startTool.handle(context, {}, response);

    expect(context.startRecordingOnCurrentTab).toHaveBeenCalledTimes(1);
    expect(response.result()).toContain('Recording started');
  });

  it('rejects unsafe stateless recording before opening a tab', async () => {
    context.startRecordingOnCurrentTab.mockImplementation(() => { throw new Error('browserSessionId required'); });

    await expect(startTool.handle(context, {}, new Response(context, startTool.schema.name, {})))
        .rejects.toThrow('browserSessionId required');
    expect(context.ensureTab).not.toHaveBeenCalled();
  });

  it('rejects a duplicate start before opening or focusing a tab', async () => {
    context.startRecordingOnCurrentTab.mockImplementation(() => { throw new Error('Recording is already in progress'); });

    await expect(startTool.handle(context, {}, new Response(context, startTool.schema.name, {})))
        .rejects.toThrow('Recording is already in progress');
    expect(context.ensureTab).not.toHaveBeenCalled();
    expect(page.bringToFront).not.toHaveBeenCalled();
  });

  it('returns recorded JavaScript and includes a snapshot', async () => {
    context.stopRecording.mockResolvedValue(["await page.getByRole('button').click();"]);
    const response = new Response(context, stopTool.schema.name, {});
    const includeSnapshot = vi.spyOn(response, 'setIncludeSnapshot');

    await stopTool.handle(context, {}, response);

    expect(response.result()).toContain("~~~js\nawait page.getByRole('button').click();\n~~~");
    expect(response.code()).toBe('');
    expect(includeSnapshot).toHaveBeenCalledTimes(1);
  });

  it('does not close the session-log result fence around recorded JavaScript', async () => {
    vi.useFakeTimers();
    try {
      context.stopRecording.mockResolvedValue(["await page.getByRole('button').click();"]);
      const response = new Response(context, stopTool.schema.name, {});
      await stopTool.handle(context, {}, response);
      const storage = {
        writeFile: vi.fn().mockResolvedValue(undefined),
        appendFile: vi.fn().mockResolvedValue(undefined),
      };
      const sessionLog = new SessionLog('/unused', storage);

      sessionLog.logResponse(response);
      await vi.advanceTimersByTimeAsync(1000);

      const entry = storage.appendFile.mock.calls[0][1];
      expect(entry).toContain("- Result\n```\nRecording stopped. Recorded actions:\n\n~~~js\nawait page.getByRole('button').click();\n~~~\n```");
      expect(entry.match(/```/g)).toHaveLength(4);
      expect(entry).not.toContain('\n```js\n');
    } finally {
      vi.useRealTimers();
    }
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
