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

import { z } from 'zod';
import { defineTool } from './tool.js';

const startRecording = defineTool({
  capability: 'devtools',
  schema: {
    name: 'browser_start_recording',
    title: 'Start recording user actions',
    description: 'Start recording actions that the user performs in the browser as Playwright code. Call browser_stop_recording when the user is done.',
    inputSchema: z.object({}),
    type: 'stateChanging',
  },
  handle: async (context, _params, response) => {
    context.assertRecordingCanPersist();
    const tab = await context.ensureTab();
    await context.startRecording();
    await tab.page.bringToFront();
    response.addResult('Recording started. Call browser_stop_recording to retrieve the recorded actions.');
  },
});

const stopRecording = defineTool({
  capability: 'devtools',
  schema: {
    name: 'browser_stop_recording',
    title: 'Stop recording user actions',
    description: 'Stop the recording started with browser_start_recording and return the recorded actions as Playwright code.',
    inputSchema: z.object({}),
    type: 'destructive',
  },
  handle: async (context, _params, response) => {
    const actions = await context.stopRecording();
    if (!actions)
      throw new Error('No recording in progress, use browser_start_recording to start one.');
    response.addResult(actions.length
      ? `Recording stopped. Recorded actions:\n\n\`\`\`js\n${actions.join('\n')}\n\`\`\``
      : 'Recording stopped. No actions were recorded.');
    response.setIncludeSnapshot();
  },
});

export default [startRecording, stopRecording];
