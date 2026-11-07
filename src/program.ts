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

import readline from 'node:readline';

import { program, Option } from 'commander';
import * as mcpServer from './mcp/server.js';
import { commaSeparatedList, resolveCLIConfig, semicolonSeparatedList, uploadDirectoryList } from './config.js';
import { packageJSON } from './utils/package.js';
import { Context } from './context.js';
import { assertStorageStateDoesNotResetUserProfile, assertStorageStateSupported, contextFactory, PersistentContextFactory, persistentProfileConflictRemedy } from './browserContextFactory.js';
import { ProxyBackend } from './mcp/proxyBackend.js';
import { toolNameList } from './mcp/toolPolicy.js';
import { SharedClientSlot } from './mcp/sharedClientSlot.js';
import { BrowserServerBackend } from './browserServerBackend.js';
import { BrowserSessionRegistry } from './browserSessions.js';
import { assertNetworkPolicySupported } from './networkPolicy.js';
import { ExtensionContextFactory } from './extension/extensionContextFactory.js';
import { filteredTools, serverInstructions } from './tools.js';
import { logUnhandledError } from './utils/log.js';
import { createUrlRedactor } from './utils/urlRedaction.js';

import { runVSCodeTools } from './vscode/host.js';
import type { MCPProvider, SharedProxySelection } from './mcp/proxyBackend.js';
import type { FullConfig } from './config.js';
import type { BrowserContextFactory } from './browserContextFactory.js';
import { printToolResult, printToStderr, printToStdout } from './utils/terminal.js';

type ProgramContext = {
  config: FullConfig;
  browserContextFactory: BrowserContextFactory;
  extensionContextFactory: ExtensionContextFactory;
};

async function resolveProgramContext(options: Record<string, unknown>, extensionProviderReachable?: boolean): Promise<ProgramContext> {
  const config = await resolveCLIConfig(options);
  assertNetworkPolicySupported(config, !options.extension);
  if (config.browser.profileDirName) {
    const reachable = extensionProviderReachable ?? (options.extension || (options.connectTool && !options.vscode));
    if (!reachable)
      throw new Error('--profile-dir-name is only supported in extension mode (--extension or --connect-tool).');
    if (!config.browser.userDataDir)
      throw new Error('--profile-dir-name requires --user-data-dir to name the profile directory inside it.');
    if (config.browser.contextOptions?.storageState && !options.extension)
      throw new Error('--profile-dir-name cannot reach the extension provider with a storage state: the --connect-tool extension provider refuses storage states at switch time. Drop the storage state, or run --extension without it.');
  }
  const extensionContextFactory = new ExtensionContextFactory({
    browserChannel: config.browser.launchOptions.channel || 'chrome',
    userDataDir: config.browser.userDataDir,
    executablePath: config.browser.launchOptions.executablePath,
    profileDirName: config.browser.profileDirName,
    tabGroup: config.tabGroup,
  });
  if (options.extension)
    assertStorageStateSupported(config, extensionContextFactory, '--extension attaches to the browser you are already running and uses the context it already has; --isolated does not change that. Drop the storage state and sign in in that browser before auditing.');
  const browserContextFactory = contextFactory(config);
  if (!options.extension && browserContextFactory instanceof PersistentContextFactory)
    assertStorageStateDoesNotResetUserProfile(config, persistentProfileConflictRemedy);
  return { config, browserContextFactory, extensionContextFactory };
}

const toolListCacheTtlMs = 3_600_000;

function browserBackendFactory(
  config: FullConfig,
  browserContextFactory: BrowserContextFactory,
  names: Pick<mcpServer.ServerBackendFactory, 'name' | 'title' | 'nameInConfig'>
): mcpServer.ServerBackendFactory {
  const sessionRegistry = new BrowserSessionRegistry();
  return {
    ...names,
    version: packageJSON.version,
    instructions: serverInstructions(config),
    redactUrlParams: config.redactUrlParams,
    toolListCacheHint: { ttlMs: toolListCacheTtlMs, cacheScope: 'private' },
    create: () => new BrowserServerBackend(config, browserContextFactory, sessionRegistry),
    createStateless: () => new BrowserServerBackend(config, browserContextFactory, sessionRegistry, { ephemeralDefaultContext: true }),
  };
}

function parseInteractiveLine(line: string): { toolName: string, json: string } {
  const spaceIndex = line.indexOf(' ');
  if (spaceIndex === -1)
    return { toolName: line, json: '{}' };
  return { toolName: line.substring(0, spaceIndex), json: line.substring(spaceIndex + 1).trim() };
}

function appendCdpHeader(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function configureBaseProgram() {
  program
      .version('Version ' + packageJSON.version)
      .name(packageJSON.name)
      .option('--allowed-origins <origins>', 'semicolon-separated host patterns to allow for locally launched Chromium HTTP(S) requests and page WebSockets. Worker sockets are not filtered. Default is to allow all.', semicolonSeparatedList)
      .option('--allowed-upload-dirs <dirs>', 'semicolon-separated list of directories that browser_file_upload and browser_drop may read files from. An empty list denies all file uploads and drops.', uploadDirectoryList)
      .option('--blocked-origins <origins>', 'semicolon-separated host patterns to block for locally launched Chromium HTTP(S) requests and page WebSockets. Blocklist takes precedence over allowlist. Worker sockets are not filtered.', semicolonSeparatedList)
      .option('--block-service-workers', 'block service workers')
      .option('--browser <browser>', 'browser or chrome channel to use, possible values: chrome, firefox, webkit, msedge.')
      .option('--allowed-tools <tools>', 'comma-separated exact tool names to enable in addition to core and capability tools (not a whitelist).', toolNameList)
      .option('--blocked-tools <tools>', 'comma-separated exact tool names to hide and reject; takes precedence over --allowed-tools.', toolNameList)
      .option('--caps <caps>', 'comma-separated list of additional capabilities to enable, possible values: vision, pdf, verify, devtools, install (allows browser downloads).', commaSeparatedList)
      .option('--cdp-launch-command <command>', 'launch a desktop app command and connect to its CDP endpoint.')
      .option('--cdp-launch-args <args>', 'comma-separated arguments passed to the CDP launch command.', commaSeparatedList)
      .option('--cdp-launch-cwd <path>', 'working directory for the CDP launch command.')
      .option('--cdp-launch-port <port>', 'port to use for the launched app CDP endpoint.', parseInt)
      .option('--cdp-launch-startup-timeout <ms>', 'maximum time in milliseconds to wait for a launched app CDP endpoint.', parseInt)
      .option('--cdp-endpoint <endpoint>', 'CDP endpoint to connect to.')
      .option('--cdp-header <header>', 'CDP header to send with the connect request, in "Name: Value" form (for example "Authorization: Bearer <token>"). Repeat the flag to send multiple headers.', appendCdpHeader, [])
      .option('--cdp-timeout <ms>', 'maximum time in milliseconds to wait when connecting to the CDP endpoint. Defaults to 30000ms (30 seconds).', parseInt)
      .option('--config <path>', 'path to the configuration file.')
      .option('--device <device>', 'device to emulate, for example: "iPhone 15"')
      .option('--executable-path <path>', 'path to the browser executable.')
      .option('--extension', 'Connect to a running browser instance (Edge/Chrome only). Requires the "Playwright Extension" to be installed.')
      .option('--headless', 'run browser in headless mode, headed by default')
      .option('--host <host>', 'host to bind server to. Default is localhost. Use 0.0.0.0 to bind to all interfaces.')
      .option('--ignore-https-errors', 'ignore https errors')
      .option('--isolated', 'keep the browser profile in memory, do not save it to disk.')
      .option('--image-responses <mode>', 'image response policy: "allow" (default), "omit", or "only". "only" omits text from successful responses with images; errors, browser lifecycle notices, structured content and resource links are preserved. "auto" is an alias for "allow".')
      .option('--mobile', 'emulate a generic mobile device (Pixel 10 for Chromium, iPhone 17 for WebKit). Cannot be combined with --device, CDP attach/launch modes, remote browser endpoints, or --extension.')
      .option('--no-tab-group', 'do not group controlled tabs when using the extension browser provider.')
      .option('--no-sandbox', 'disable the sandbox for all process types that are normally sandboxed.')
      .option('--output-dir <path>', 'path to the directory for output files.')
      .option('--file-paths <relative|absolute>', 'render output paths relative to the server working directory or as absolute paths; omitted preserves legacy rendering.')
      .option('--port <port>', 'port to listen on for MCP Streamable HTTP transport.')
      .option('--profile-dir-name <name>', 'name of the Chrome profile directory to connect to with --extension, for example "Profile 1". Requires --user-data-dir. Defaults to the last-used profile that has the extension installed.')
      .option('--proxy-bypass <bypass>', 'comma-separated domains to bypass proxy, for example ".com,chromium.org,.domain.com"')
      .option('--proxy-server <proxy>', 'specify proxy server, for example "http://myproxy:3128", "http://user:password@myproxy:3128" or "socks5://myproxy:8080"')
      .option('--redact-url-params <names>', 'comma-separated URL parameter names to mask in response and saved session text (case-insensitive); an empty value clears the list. Does not change browser requests or binary artifacts.', toolNameList)
      .option('--save-session', 'Whether to save the Playwright MCP session into the output directory.')
      .option('--save-trace', 'Whether to save the Playwright Trace of the session into the output directory.')
      .option('--snapshot-boxes', 'include each element\'s bounding box as [box=x,y,width,height] in snapshots. Coordinates are viewport-relative, in CSS pixels.')
      .option('--storage-state <path>', 'path to the storage state file for a fresh context; existing CDP/VS Code contexts and --extension reject imports. Use --isolated with CDP.')
      .option('--user-agent <ua string>', 'specify user agent string')
      .option('--user-data-dir <path>', 'path to the user data directory. If not specified, a temporary directory will be created.')
      .option('--viewport-size <size>', 'specify browser viewport size in pixels, for example "1280, 720"')
      .option('--navigation-timeout <ms>', 'maximum time in milliseconds for page navigation. Defaults to 60000ms (60 seconds).', parseInt)
      .option('--default-timeout <ms>', 'default timeout for all Playwright operations (clicks, fills, etc). Defaults to 5000ms (5 seconds).', parseInt)
      .option('--timeout-settle <ms>', 'how long to wait after each action for triggered work to settle, in milliseconds. Defaults to 500ms.', parseInt)
      .option('--timeout-idle <ms>', 'release the default browser context after inactivity, in milliseconds. Defaults to 0 (disabled).', value => value.trim() ? Number(value) : NaN)
      .addOption(new Option('--connect-tool', 'Allow to switch between different browser connection methods.').hideHelp())
      .addOption(new Option('--vscode', 'VS Code tools.').hideHelp());

  return program;
}

configureBaseProgram()
    .action(async options => {
      const exitCleanups: Array<() => Promise<void>> = [];
      setupExitWatchdog(async () => {
        for (const cleanup of exitCleanups)
          await cleanup().catch(logUnhandledError);
        await Context.disposeAll();
      });

      const { config, browserContextFactory, extensionContextFactory } = await resolveProgramContext(options);

      if (options.extension) {
        await mcpServer.start(browserBackendFactory(config, extensionContextFactory, {
          name: 'Playwright w/ extension',
          title: 'Accessibility Scanner (browser extension)',
          nameInConfig: 'playwright-extension',
        }), config.server);
        return;
      }

      if (options.vscode) {
        await runVSCodeTools(config, cleanup => exitCleanups.push(cleanup));
        return;
      }

      if (options.connectTool) {
        const sessionRegistry = new BrowserSessionRegistry();
        const makeProviders = (ephemeralDefaultContext: boolean): MCPProvider[] => [
          {
            name: 'default',
            description: 'Starts standalone browser',
            connect: () => mcpServer.wrapInProcess(new BrowserServerBackend(config, browserContextFactory, sessionRegistry, { ephemeralDefaultContext })),
          },
          {
            name: 'extension',
            description: 'Connect to a browser using the Playwright MCP extension',
            validate: () => {
              assertNetworkPolicySupported(config, false);
              assertStorageStateSupported(config, extensionContextFactory, 'The "extension" method works through the browser you are already running and uses the context it already has. Stay on the "default" method, or restart without the storage state and sign in in that browser.');
            },
            connect: () => mcpServer.wrapInProcess(new BrowserServerBackend(config, extensionContextFactory, sessionRegistry, { ephemeralDefaultContext })),
          },
        ];
        const sharedSelection: SharedProxySelection = { slot: new SharedClientSlot(), providers: makeProviders(false) };
        exitCleanups.push(async () => {
          await sharedSelection.slot.dispose();
        });
        const factory: mcpServer.ServerBackendFactory = {
          name: 'Playwright w/ switch',
          nameInConfig: 'playwright-switch',
          version: packageJSON.version,
          redactUrlParams: config.redactUrlParams,
          create: () => new ProxyBackend(makeProviders(false), undefined, config),
          createStateless: () => new ProxyBackend(makeProviders(true), sharedSelection, config),
        };
        await mcpServer.start(factory, config.server);
        return;
      }

      await mcpServer.start(browserBackendFactory(config, browserContextFactory, {
        name: 'Playwright',
        title: 'Accessibility Scanner',
        nameInConfig: 'playwright',
      }), config.server);
    });

program
    .command('list-tools')
    .description('List available MCP tools')
    .action(async () => {
      const parentOptions = program.opts();
      const { config } = await resolveProgramContext(parentOptions);
      for (const tool of filteredTools(config))
        printToStdout(`${tool.schema.name}  ${tool.schema.description}`);
    });

program
    .command('interactive')
    .description('Start an interactive REPL for manual tool execution')
    .action(async () => {
      const parentOptions = program.opts();
      const { config, browserContextFactory, extensionContextFactory } = await resolveProgramContext(parentOptions, Boolean(parentOptions.extension));
      if (config.imageResponses === 'only')
        throw new Error('Interactive mode prints text only. Use --image-responses allow or omit instead of only.');
      const backend = new BrowserServerBackend(config, parentOptions.extension ? extensionContextFactory : browserContextFactory);
      const redactSecrets = createUrlRedactor(config.redactUrlParams);
      const handleExit = setupExitWatchdog(async () => {
        await backend.serverClosed();
        await Context.disposeAll();
      });
      await backend.initialize(
          { notifyToolListChanged: async () => {} },
          { name: 'interactive-cli', version: packageJSON.version },
      );

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      printToStdout('Interactive mode. Type "<tool-name> <json>" to call a tool. Ctrl+D to exit.');

      const prompt = () => rl.prompt();
      rl.setPrompt('> ');
      prompt();

      rl.on('line', async (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) {
          prompt();
          return;
        }

        const { toolName, json: jsonStr } = parseInteractiveLine(trimmed);

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(jsonStr) as Record<string, unknown>;
        } catch {
          printToStderr(`Invalid JSON: ${jsonStr}`);
          prompt();
          return;
        }

        try {
          printToolResult(await backend.callTool(toolName, args), redactSecrets);
        } catch (error) {
          printToStderr(`Error: ${String(error)}`);
        }

        prompt();
      });

      rl.on('close', () => {
        void handleExit();
      });
    });

function setupExitWatchdog(cleanup: () => Promise<void> = () => Context.disposeAll()) {
  let isExiting = false;
  const handleExit = async () => {
    if (isExiting)
      return;
    isExiting = true;
    setTimeout(() => process.exit(0), 15000);
    try {
      await cleanup();
    } catch (error) {
      logUnhandledError(error);
    } finally {
      process.exit(0);
    }
  };

  process.stdin.on('close', () => {
    void handleExit();
  });
  process.on('SIGINT', () => {
    void handleExit();
  });
  process.on('SIGTERM', () => {
    void handleExit();
  });
  process.on('SIGHUP', () => {
    void handleExit();
  });
  return handleExit;
}

void program.parseAsync(process.argv);
