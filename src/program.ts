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

import { program } from 'commander';
import readline from 'node:readline/promises';
import * as mcpServer from './mcp/server.js';
import { resolveCLIConfig } from './config.js';
import { packageJSON } from './utils/package.js';
import { Context } from './context.js';
import { contextFactory } from './browserContextFactory.js';
import { BrowserServerBackend } from './browserServerBackend.js';
import { ExtensionContextFactory } from './extension/extensionContextFactory.js';
import { resolveProgramMode } from './programMode.js';
import { addSharedServerOptions, configureProgramOptions } from './programOptions.js';
import { callToolDirect, callToolErrorResult, listToolsDirect, parseToolInput, runWithBackend, toolResultAsText } from './cliDirect.js';

import { runVSCodeTools } from './vscode/host.js';

configureProgramOptions(program)
    .description('Start the MCP server (default mode).')
    .action(async options => {
      setupExitWatchdog();
      await runServer(options);
    });

addSharedServerOptions(
    program.command('serve')
        .description('Start the MCP server explicitly.'),
).action(async options => {
  setupExitWatchdog();
  await runServer(options);
});

addSharedServerOptions(
    program.command('list-tools')
        .description('List available tools using direct CLI mode (without an MCP client).')
        .option('--json', 'Print full tool metadata as JSON instead of names only.'),
).action(async options => {
  await runCLICommand(async () => {
    applyLegacyVisionOption(options);
    const tools = await listToolsDirect(options);
    if (options.json) {
      printJSON({ tools });
      return;
    }
    for (const tool of tools)
      process.stdout.write(`${tool.name}\n`);
  });
});

addSharedServerOptions(
    program.command('call')
        .description('Call a tool directly using CLI mode (without an MCP client).')
        .argument('<toolName>', 'Tool name to call')
        .option('--input <json>', 'JSON object arguments for the tool call.')
        .option('--input-file <path>', 'Path to a JSON file with tool arguments.')
        .option('--one-shot', 'Run one command and close the browser session immediately.')
        .option('--output <format>', 'Output format: json or text.', 'json'),
).action(async (toolName: string, options) => {
  await runCLICommand(async () => {
    applyLegacyVisionOption(options);
    const format = options.output === 'text' ? 'text' : 'json';
    const oneShot = options.oneShot || !process.stdin.isTTY;

    if (!oneShot) {
      await runInteractiveSession(toolName, options, format);
      return;
    }

    const result = await callToolDirect(toolName, options);
    writeToolResult(result, format);
    if (result.isError)
      process.exitCode = 1;
  });
});

async function runServer(options: Record<string, any>) {
  applyLegacyVisionOption(options);

  const config = await resolveCLIConfig(options);
  const browserContextFactory = contextFactory(config);
  const extensionContextFactory = new ExtensionContextFactory(config.browser.launchOptions.channel || 'chrome', config.browser.userDataDir, config.browser.launchOptions.executablePath);
  const mode = resolveProgramMode(options);

  if (mode === 'extension') {
    const serverBackendFactory: mcpServer.ServerBackendFactory = {
      name: 'Playwright w/ extension',
      nameInConfig: 'playwright-extension',
      version: packageJSON.version,
      create: () => new BrowserServerBackend(config, extensionContextFactory)
    };
    await mcpServer.start(serverBackendFactory, config.server);
    return;
  }

  if (mode === 'vscode') {
    await runVSCodeTools(config);
    return;
  }

  const factory: mcpServer.ServerBackendFactory = {
    name: 'Playwright',
    nameInConfig: 'playwright',
    version: packageJSON.version,
    create: () => new BrowserServerBackend(config, browserContextFactory)
  };
  await mcpServer.start(factory, config.server);
}

function applyLegacyVisionOption(options: Record<string, any>) {
  if (!options.vision)
    return;
  process.stderr.write('The --vision option is deprecated, use --caps=vision instead\n');

  const caps = normalizeCaps(options.caps);
  if (!caps.includes('vision'))
    caps.push('vision');
  options.caps = caps;
}

async function runCLICommand(command: () => Promise<void>) {
  try {
    await command();
  } catch (error: any) {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exitCode = 1;
  }
}

function writeToolResult(result: mcpServer.CallToolResult, format: 'json' | 'text') {
  if (format === 'text')
    process.stdout.write(`${toolResultAsText(result)}\n`);
  else
    printJSON(result);
}

function normalizeCaps(caps: unknown): string[] {
  if (Array.isArray(caps))
    return [...caps];
  if (typeof caps === 'string')
    return caps.split(',').map(cap => cap.trim()).filter(Boolean);
  return [];
}

async function runInteractiveSession(
  initialToolName: string,
  options: Record<string, any>,
  format: 'json' | 'text',
) {
  let initialResult: mcpServer.CallToolResult = { content: [] };
  try {
    const input = await parseToolInput(options);
    await runWithBackend(options, async backend => {
      initialResult = await callToolWithErrorResult(backend, initialToolName, input);
      writeToolResult(initialResult, format);
      if (initialResult.isError || initialToolName === 'browser_close')
        return;

      process.stderr.write('Session is open. Run `<toolName> [json]` and use `browser_close` to close.\n');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: true,
      });
      try {
        while (true) {
          const line = (await rl.question('mcp> ')).trim();
          if (!line)
            continue;
          if (line === 'help') {
            process.stderr.write('Usage: <toolName> [jsonObject]\n');
            process.stderr.write('Example: browser_navigate {"url":"https://google.com"}\n');
            process.stderr.write('Use browser_close to close the session.\n');
            continue;
          }

          let parsed: { toolName: string, args: Record<string, any> };
          try {
            parsed = parseInteractiveCommand(line);
          } catch (error) {
            writeToolResult(callToolErrorResult(error), format);
            process.exitCode = 1;
            continue;
          }

          const result = await callToolWithErrorResult(backend, parsed.toolName, parsed.args);
          writeToolResult(result, format);
          if (result.isError)
            process.exitCode = 1;
          if (parsed.toolName === 'browser_close' && !result.isError)
            break;
        }
      } finally {
        rl.close();
      }
    });
  } catch (error) {
    initialResult = callToolErrorResult(error);
    writeToolResult(initialResult, format);
  }
  if (initialResult.isError)
    process.exitCode = 1;
}

function parseInteractiveCommand(line: string): { toolName: string, args: Record<string, any> } {
  const trimmed = line.trim();
  const splitAt = trimmed.search(/\s/);
  if (splitAt === -1)
    return { toolName: trimmed, args: {} };

  const toolName = trimmed.slice(0, splitAt).trim();
  const rawJSON = trimmed.slice(splitAt + 1).trim();
  if (!rawJSON)
    return { toolName, args: {} };
  const parsed = JSON.parse(rawJSON);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Tool input JSON must be an object.');
  return { toolName, args: parsed };
}

async function callToolWithErrorResult(
  backend: mcpServer.ServerBackend,
  toolName: string,
  input: Record<string, any>,
): Promise<mcpServer.CallToolResult> {
  try {
    return await backend.callTool(toolName, input);
  } catch (error) {
    return callToolErrorResult(error);
  }
}

function printJSON(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

program.showHelpAfterError('(run with --help for usage details)');
program.configureHelp({ sortSubcommands: true });
program.configureHelp({ sortOptions: true });

function setupExitWatchdog() {
  let isExiting = false;
  const handleExit = async () => {
    if (isExiting)
      return;
    isExiting = true;
    setTimeout(() => process.exit(0), 15000);
    await Context.disposeAll();
    process.exit(0);
  };

  process.stdin.on('close', handleExit);
  process.on('SIGINT', handleExit);
  process.on('SIGTERM', handleExit);
}

void program.parseAsync(process.argv);
