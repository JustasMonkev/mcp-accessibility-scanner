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

import fs from 'fs/promises';
import { pathToFileURL } from 'url';
import { resolveCLIConfig } from './config.js';
import { contextFactory } from './browserContextFactory.js';
import { BrowserServerBackend } from './browserServerBackend.js';
import { ExtensionContextFactory } from './extension/extensionContextFactory.js';
import { resolveProgramMode } from './programMode.js';
import { packageJSON } from './utils/package.js';
import { Context } from './context.js';

import type * as mcpServer from './mcp/server.js';
import type { CLIOptions } from './config.js';
import type { ProgramModeOptions } from './programMode.js';

type ToolInputSource = {
  input?: string;
  inputFile?: string;
};

type DirectCLIOptions = CLIOptions & ProgramModeOptions & ToolInputSource;

export async function parseToolInput(source: ToolInputSource): Promise<Record<string, any>> {
  if (source.input && source.inputFile)
    throw new Error('Use either --input or --input-file, not both.');

  const raw = source.inputFile
    ? await fs.readFile(source.inputFile, 'utf8')
    : source.input;

  if (!raw)
    return {};

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Tool input JSON must be an object.');
    return parsed;
  } catch (error: any) {
    throw new Error(`Failed to parse tool input JSON: ${error.message || error}`);
  }
}

export async function createBackendFromOptions(options: DirectCLIOptions): Promise<mcpServer.ServerBackend> {
  const config = await resolveCLIConfig(options);
  const browserContext = contextFactory(config);
  const extensionContext = new ExtensionContextFactory(config.browser.launchOptions.channel || 'chrome', config.browser.userDataDir, config.browser.launchOptions.executablePath);
  const mode = resolveProgramMode(options);

  if (mode === 'vscode')
    throw new Error('The --vscode option is only supported when running the MCP server.');

  return new BrowserServerBackend(config, mode === 'extension' ? extensionContext : browserContext);
}

async function withBackend<T>(options: DirectCLIOptions, callback: (backend: mcpServer.ServerBackend) => Promise<T>): Promise<T> {
  const backend = await createBackendFromOptions(options);
  const cwdRoot = {
    uri: pathToFileURL(process.cwd()).toString(),
    name: 'cwd',
  } as mcpServer.Root;
  await backend.initialize?.(
      {} as mcpServer.Server,
      { name: `${packageJSON.name}-cli`, version: packageJSON.version },
      [cwdRoot],
  );
  try {
    return await callback(backend);
  } finally {
    backend.serverClosed?.({} as mcpServer.Server);
    await Context.disposeAll();
  }
}

export async function listToolsDirect(options: DirectCLIOptions): Promise<mcpServer.Tool[]> {
  return withBackend(options, backend => backend.listTools());
}

export async function callToolDirect(toolName: string, options: DirectCLIOptions): Promise<mcpServer.CallToolResult> {
  const input = await parseToolInput(options);
  return withBackend(options, backend => backend.callTool(toolName, input));
}

export function toolResultAsText(result: mcpServer.CallToolResult): string {
  const lines: string[] = [];
  for (const item of result.content || []) {
    if (item.type === 'text')
      lines.push(item.text);
  }
  if (!lines.length)
    lines.push(JSON.stringify(result, null, 2));
  return lines.join('\n');
}
