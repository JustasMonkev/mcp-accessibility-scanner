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
import { defineTabTool } from './tool.js';
import { formatConsoleMessage } from '../utils/dataUrl.js';

const console = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_console_messages',
    title: 'Get console messages',
    description: 'Returns the most recent 200 console messages since the last explicit navigation, including messages from pages reached by link clicks or back navigation, with a count of any omitted ones',
    inputSchema: z.object({}),
    type: 'readOnly',
  },
  handle: async (tab, params, response) => {
    const omitted = tab.omittedConsoleMessages();
    if (omitted)
      response.addResult(`${omitted} earlier console ${omitted === 1 ? 'message was' : 'messages were'} omitted; only the most recent ${tab.consoleMessages().length} are kept.`);
    for (const message of tab.consoleMessages())
      response.addResult(formatConsoleMessage(message));
  },
});

export default [
  console,
];
