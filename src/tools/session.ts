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

const open = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_session_open',
    title: 'Open browser session',
    description: 'Open a separate browser session — its own browser context with its own tabs, cookies and storage — and return its browserSessionId. Pass that id as the optional browserSessionId argument of the non-session browser tools to run them in this session instead of the default one. Unavailable in modes that share one live browser context (non-isolated CDP attach, extension); such modes reject the call instead of handing out a session that is not separate. Idle sessions expire automatically, so close the session with browser_session_close when done.',
    inputSchema: z.object({}),
    type: 'readOnly',
  },
  handle: async (context, _params, response) => {
    const browserSessionId = context.browserSessions().open();
    response.addResult(`Opened browser session "${browserSessionId}". Pass browserSessionId: "${browserSessionId}" to other browser tools to use it.`);
    response.setStructuredContent({ browserSessionId });
  },
});

const close = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_session_close',
    title: 'Close browser session',
    description: 'Close a browser session previously opened with browser_session_open and release its browser resources. The default session cannot be closed this way.',
    inputSchema: z.object({
      browserSessionId: z.string().describe('The browser session handle to close, as returned by browser_session_open'),
    }),
    type: 'destructive',
  },
  handle: async (context, params, response) => {
    await context.browserSessions().close(params.browserSessionId);
    response.addResult(`Closed browser session "${params.browserSessionId}".`);
  },
});

export default [
  open,
  close,
];
