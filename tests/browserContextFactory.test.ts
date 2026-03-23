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

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connectOverCDP, spawnMock } = vi.hoisted(() => ({
  connectOverCDP: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('playwright', () => ({
  chromium: {
    connectOverCDP,
    launch: vi.fn(),
    launchPersistentContext: vi.fn(),
  },
  firefox: {
    connect: vi.fn(),
    launch: vi.fn(),
    launchPersistentContext: vi.fn(),
  },
  webkit: {
    connect: vi.fn(),
    launch: vi.fn(),
    launchPersistentContext: vi.fn(),
  },
  devices: {},
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import { contextFactory } from '../src/browserContextFactory.js';
import { resolveConfig } from '../src/config.js';

function createMockBrowserContext() {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    pages: vi.fn().mockReturnValue([]),
    on: vi.fn(),
    route: vi.fn().mockResolvedValue(undefined),
    tracing: {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    },
  } as any;
}

function createMockBrowser(browserContext: any) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    contexts: vi.fn().mockReturnValue([browserContext]),
    on: vi.fn(),
  } as any;
}

function createMockChildProcess() {
  const childProcess = new EventEmitter() as any;
  childProcess.stderr = new EventEmitter();
  childProcess.exitCode = null;
  childProcess.kill = vi.fn().mockImplementation(() => {
    childProcess.exitCode = 0;
    childProcess.emit('exit', 0);
    return true;
  });
  return childProcess;
}

describe('browserContextFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disconnects from attach-only CDP sessions without closing the external context', async () => {
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    connectOverCDP.mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpEndpoint: 'http://127.0.0.1:9222',
      },
    });

    const factory = contextFactory(config);
    const result = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    await result.close();

    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browserContext.close).not.toHaveBeenCalled();
  });

  it('launches a desktop app, retries CDP attach, and terminates the child on close', async () => {
    const browserContext = createMockBrowserContext();
    const browser = createMockBrowser(browserContext);
    const childProcess = createMockChildProcess();

    spawnMock.mockReturnValue(childProcess);
    connectOverCDP
        .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:9222'))
        .mockResolvedValue(browser);

    const config = await resolveConfig({
      browser: {
        cdpLaunch: {
          command: 'open',
          args: ['-a', 'Slack', '--args', '--remote-debugging-port={port}'],
          cwd: '/tmp/slack',
          env: {
            SLACK_ENV: 'test',
          },
          port: 9222,
          startupTimeoutMs: 500,
        },
      },
    });

    const factory = contextFactory(config);
    const result = await factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined);

    expect(spawnMock).toHaveBeenCalledWith('open', ['-a', 'Slack', '--args', '--remote-debugging-port=9222'], expect.objectContaining({
      cwd: '/tmp/slack',
      env: expect.objectContaining({
        SLACK_ENV: 'test',
      }),
      stdio: ['ignore', 'ignore', 'pipe'],
    }));
    expect(connectOverCDP).toHaveBeenCalledTimes(2);
    expect(connectOverCDP).toHaveBeenLastCalledWith('http://127.0.0.1:9222', {
      headers: {
        'User-Agent': 'vitest/1.0.0',
      },
    });

    await result.close();

    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(childProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('fails with a timeout when the launched CDP endpoint never becomes available', async () => {
    const childProcess = createMockChildProcess();
    spawnMock.mockReturnValue(childProcess);
    connectOverCDP.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const config = await resolveConfig({
      browser: {
        cdpLaunch: {
          command: 'open',
          port: 9222,
          startupTimeoutMs: 10,
        },
      },
    });

    const factory = contextFactory(config);

    await expect(factory.createContext({ name: 'vitest', version: '1.0.0' }, new AbortController().signal, undefined)).rejects.toThrow('Timed out waiting for CDP endpoint http://127.0.0.1:9222.');
    expect(childProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
