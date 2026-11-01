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

import type { Response } from '../response.js';
import type { Tab } from '../tab.js';

const maxWaitSeconds = 30;

type TextCondition = { text: string, state: 'visible' | 'hidden' };

const wait = defineTool({
  capability: 'core',

  schema: {
    name: 'browser_wait_for',
    title: 'Wait for',
    description: 'Wait for text to appear or disappear or a specified time to pass. When both text and textGone are provided, waits for the first one to happen',
    inputSchema: z.object({
      time: z.number().min(0).optional().describe(`The time to wait in seconds, at most ${maxWaitSeconds}. When combined with text or textGone, serves as a timeout for them instead of the default action timeout. 0 is treated the same as omitting it`),
      text: z.string().optional().describe('The text to wait for'),
      textGone: z.string().optional().describe('The text to wait for to disappear'),
    }),
    type: 'readOnly',
  },

  handle: async (context, params, response, signal) => {
    signal?.throwIfAborted();
    if (!params.text && !params.textGone && !params.time)
      throw new Error('Either time, text or textGone must be provided');

    const tab = context.currentTabOrDie();
    const seconds = params.time ? Math.min(maxWaitSeconds, params.time) : undefined;
    const conditions: TextCondition[] = [
      ...(params.text ? [{ text: params.text, state: 'visible' as const }] : []),
      ...(params.textGone ? [{ text: params.textGone, state: 'hidden' as const }] : []),
    ];

    if (conditions.length) {
      await waitForFirstTextCondition(tab, conditions, seconds, response, signal);
    } else if (seconds) {
      response.addCode(`await new Promise(f => setTimeout(f, ${seconds} * 1000));`);
      await sleep(seconds * 1000, signal);
      response.addResult(seconds === params.time
        ? `Waited for ${seconds} seconds`
        : `Waited for ${seconds} seconds (requested ${params.time}, maximum is ${maxWaitSeconds})`);
    }
    response.setIncludeSnapshot();
  },
});

async function waitForFirstTextCondition(tab: Tab, conditions: TextCondition[], seconds: number | undefined, response: Response, signal?: AbortSignal): Promise<void> {
  const timeout = seconds ? seconds * 1000 : undefined;
  response.addCode(replayableTextWait(conditions, timeout));

  const cancelLosers = new AbortController();
  const waitSignal = signal ? AbortSignal.any([signal, cancelLosers.signal]) : cancelLosers.signal;
  const waits = conditions.map(async ({ text, state }) => {
    await tab.page.getByText(text).first().waitFor({ state, ...(timeout ? { timeout } : {}), signal: waitSignal });
    return `Waited for ${text}`;
  });
  for (const pendingWait of waits)
    pendingWait.catch(() => {});
  try {
    response.addResult(await Promise.race(waits));
  } finally {
    cancelLosers.abort();
    await Promise.allSettled(waits);
  }
}

function replayableTextWait(conditions: TextCondition[], timeout: number | undefined): string {
  const waitFor = ({ text, state }: TextCondition, signal?: string) => {
    const timeoutOption = timeout ? `, timeout: ${timeout}` : '';
    const signalOption = signal ? `, signal: ${signal}` : '';
    return `page.getByText(${JSON.stringify(text)}).first().waitFor({ state: '${state}'${timeoutOption}${signalOption} })`;
  };
  if (conditions.length === 1)
    return `await ${waitFor(conditions[0])};`;
  return [
    '{',
    '  const abortController = new AbortController();',
    '  await Promise.race([',
    ...conditions.map(condition => `    ${waitFor(condition, 'abortController.signal')},`),
    '  ]).finally(() => abortController.abort());',
    '}',
  ].join('\n');
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export default [
  wait,
];
