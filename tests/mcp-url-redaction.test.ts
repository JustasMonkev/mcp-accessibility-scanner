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

import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { createServer } from '../src/mcp/server.js';
import type { ServerBackend } from '../src/mcp/server.js';
import { InProcessTransport } from '../src/mcp/inProcessTransport.js';

it.each(['result', 'error'])('redacts final %s output and forwarded progress outside Response.serialize', async mode => {
  const url = 'https://fixture.test/?code=synthetic-proxy-secret&keep=visible';
  let received: unknown;
  const backend: ServerBackend = {
    listTools: async () => [],
    callTool: async (_name, args, requestContext) => {
      received = args?.url;
      if (requestContext) {
        await requestContext.sendNotification({
          method: 'notifications/progress',
          params: { progressToken: requestContext._meta?.progressToken ?? 0, progress: 1, total: 2, message: `Opening ${url}` },
        });
      }
      if (mode === 'error')
        throw new Error(`Unable to open ${url}`);
      return { content: [{ type: 'text', text: url }], structuredContent: { page: { url }, count: 2 } };
    },
  };
  const server = createServer('redaction-fixture', '1', backend, false, { redactUrlParams: ['code'] });
  const client = new Client({ name: 'redaction-test', version: '1' });
  await client.connect(new InProcessTransport(server));
  const progress: unknown[] = [];
  try {
    const result = await client.callTool({ name: 'fixture', arguments: { url } }, { onprogress: update => progress.push(update) });
    expect(received).toBe(url);
    expect(result.isError === true).toBe(mode === 'error');
    expect(JSON.stringify(result)).not.toContain('synthetic-proxy-secret');
    expect(JSON.stringify(result)).toContain('?code=REDACTED&keep=visible');
    expect(progress).toContainEqual(expect.objectContaining({ progress: 1, total: 2, message: 'Opening https://fixture.test/?code=REDACTED&keep=visible' }));
    if (mode === 'result') {
      expect(result.content).toEqual([{ type: 'text', text: 'https://fixture.test/?code=REDACTED&keep=visible' }]);
      expect(result.structuredContent).toEqual({ page: { url: 'https://fixture.test/?code=REDACTED&keep=visible' }, count: 2 });
    }
  } finally {
    await client.close();
  }
});

it('redacts tool display fields without changing names or input schema contracts', async () => {
  const url = 'https://fixture.test/?code=synthetic-description-secret';
  const expectedInputSchema = { type: 'object', properties: { url: { type: 'string', default: url } } };
  const tool = { name: 'fixture', title: url, description: url, annotations: { title: url }, inputSchema: { type: 'object', properties: { url: { type: 'string', default: url } } } };
  const backend: ServerBackend = {
    listTools: async () => [tool],
    callTool: async () => ({ content: [] }),
  };
  const server = createServer('redaction-fixture', '1', backend, false, { redactUrlParams: ['code'] });
  const client = new Client({ name: 'redaction-test', version: '1' });
  await client.connect(new InProcessTransport(server));
  try {
    const listed = (await client.listTools()).tools[0];
    expect(listed).toMatchObject({ name: 'fixture', title: 'https://fixture.test/?code=REDACTED', description: 'https://fixture.test/?code=REDACTED', annotations: { title: 'https://fixture.test/?code=REDACTED' } });
    expect(listed.inputSchema).toEqual(expectedInputSchema);
    expect(tool.inputSchema).toEqual(expectedInputSchema);
    expect(tool.description).toBe(url);
  } finally {
    await client.close();
  }
});
