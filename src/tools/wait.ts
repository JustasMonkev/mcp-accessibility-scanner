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

const maxWaitSeconds = 30;

const wait = defineTool({
  capability: 'core',

  schema: {
    name: 'browser_wait_for',
    title: 'Wait for',
    description: 'Wait for text to appear or disappear or a specified time to pass. When both text and textGone are provided, waits for the first one to happen',
    inputSchema: z.object({
      time: z.number().min(0).optional().describe(`The time to wait in seconds, at most ${maxWaitSeconds}. When combined with text or textGone, serves as a timeout for them instead of the default action timeout`),
      text: z.string().optional().describe('The text to wait for'),
      textGone: z.string().optional().describe('The text to wait for to disappear'),
    }),
    type: 'readOnly',
  },

  handle: async (context, params, response) => {
    if (!params.text && !params.textGone && !params.time)
      throw new Error('Either time, text or textGone must be provided');

    const tab = context.currentTabOrDie();
    const time = params.time ? Math.min(maxWaitSeconds, params.time) : undefined;

    if (params.text || params.textGone) {
      const timeoutOptions = time ? { timeout: time * 1000 } : {};
      const conditions = [
        ...(params.text ? [{ text: params.text, state: 'visible' as const }] : []),
        ...(params.textGone ? [{ text: params.textGone, state: 'hidden' as const }] : []),
      ];
      const waitForCode = ({ text, state }: typeof conditions[number]) => {
        const options = time ? `{ state: '${state}', timeout: ${time * 1000} }` : `{ state: '${state}' }`;
        return `page.getByText(${JSON.stringify(text)}).first().waitFor(${options})`;
      };
      response.addCode(conditions.length === 1
        ? `await ${waitForCode(conditions[0])};`
        : `await Promise.race([\n${conditions.map(condition => `  ${waitForCode(condition)},`).join('\n')}\n]);`);

      // Abort the losing wait once the race settles so it does not keep polling until its timeout.
      const abortController = new AbortController();
      const waits = conditions.map(async ({ text, state }) => {
        await tab.page.getByText(text).first().waitFor({ state, ...timeoutOptions, signal: abortController.signal });
        return `Waited for ${text}`;
      });
      for (const wait of waits)
        wait.catch(() => {});
      try {
        response.addResult(await Promise.race(waits));
      } finally {
        abortController.abort();
      }
    } else if (time) {
      response.addCode(`await new Promise(f => setTimeout(f, ${time} * 1000));`);
      await new Promise(f => setTimeout(f, time * 1000));
      if (time !== params.time)
        response.addResult(`Waited for ${time} seconds (requested ${params.time}, maximum is ${maxWaitSeconds})`);
      else
        response.addResult(`Waited for ${time} seconds`);
    }
    response.setIncludeSnapshot();
  },
});

export default [
  wait,
];
