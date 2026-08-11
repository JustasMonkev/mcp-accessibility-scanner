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
import { commaSeparatedList, resolveCLIConfig, semicolonSeparatedList } from './config.js';
import { packageJSON } from './utils/package.js';
import { Context } from './context.js';
import { assertStorageStateDoesNotResetUserProfile, assertStorageStateSupported, contextFactory, PersistentContextFactory, persistentProfileConflictRemedy } from './browserContextFactory.js';
import { ProxyBackend } from './mcp/proxyBackend.js';
import { SharedClientSlot } from './mcp/sharedClientSlot.js';
import { BrowserServerBackend } from './browserServerBackend.js';
import { BrowserSessionRegistry } from './browserSessions.js';
import { ExtensionContextFactory } from './extension/extensionContextFactory.js';
import { filteredTools, serverInstructions } from './tools.js';
import { logUnhandledError } from './utils/log.js';

import { runVSCodeTools } from './vscode/host.js';
import type { MCPProvider, SharedProxySelection } from './mcp/proxyBackend.js';
import type { FullConfig } from './config.js';
import type { BrowserContextFactory } from './browserContextFactory.js';

type ProgramContext = {
  config: FullConfig;
  browserContextFactory: BrowserContextFactory;
  extensionContextFactory: ExtensionContextFactory;
};

async function resolveProgramContext(options: Record<string, unknown>): Promise<ProgramContext> {
  const config = await resolveCLIConfig(options);
  const extensionContextFactory = new ExtensionContextFactory(config.browser.launchOptions.channel || 'chrome', config.browser.userDataDir, config.browser.launchOptions.executablePath);
  // --extension runs every tool through the extension factory, not the one
  // contextFactory() builds, so validate the factory that will actually create
  // the context. Checked first because contextFactory() would otherwise
  // recommend --isolated, which does not help here.
  if (options.extension)
    assertStorageStateSupported(config, extensionContextFactory, '--extension attaches to the browser you are already running and uses the context it already has; --isolated does not change that. Drop the storage state and sign in in that browser before auditing.');
  const browserContextFactory = contextFactory(config);
  // Provider-switching modes with a persistent default provider must reject
  // the profile conflict at startup: the factory itself only rejects the
  // combination lazily, on its first browser operation, while the extension
  // provider refuses the storage state at switch time — so the server would
  // start advertising two providers and neither could ever create a context.
  // (Other default providers ignore --user-data-dir, and the extension leg
  // alone validates at switch time instead.)
  if ((options.connectTool || options.vscode) && browserContextFactory instanceof PersistentContextFactory)
    assertStorageStateDoesNotResetUserProfile(config, persistentProfileConflictRemedy);
  return { config, browserContextFactory, extensionContextFactory };
}

async function startMCPServer(config: FullConfig, browserContextFactory: BrowserContextFactory) {
  // One browser-session handle registry for every backend this factory mints:
  // handshake-free (MCP 2026-07-28) HTTP requests are each served by a fresh
  // backend, and a browserSessionId minted in one request must resolve in the
  // next. Stateful (stdio and v1 HTTP session) backends share it too — handles
  // are already opaque bearer tokens scoped to this server process.
  const sessionRegistry = new BrowserSessionRegistry();
  const factory: mcpServer.ServerBackendFactory = {
    name: 'Playwright',
    title: 'Accessibility Scanner',
    nameInConfig: 'playwright',
    version: packageJSON.version,
    instructions: serverInstructions,
    // The tool list is fixed per process (filteredTools(config) never changes
    // at runtime), so 2026-07-28 clients may cache it for an hour. Scope is
    // `private`: the list depends on this server's local configuration
    // (--caps and connection mode), so it must not be served from a shared
    // cache keyed only on the URL.
    toolListCacheHint: { ttlMs: 3600000, cacheScope: 'private' },
    create: () => new BrowserServerBackend(config, browserContextFactory, sessionRegistry),
    // Handshake-free HTTP serves each request with a throwaway backend whose
    // default context is disposed when the response ends; flagging it
    // ephemeral gives it a disposable profile in default persistent mode, so
    // parallel stateless requests stop contending for the one stable profile.
    createStateless: () => new BrowserServerBackend(config, browserContextFactory, sessionRegistry, { ephemeralDefaultContext: true })
  };
  await mcpServer.start(factory, config.server);
}

// Accumulator for the repeatable `--cdp-header` option. A single-value option
// (rather than variadic) keeps a following subcommand from being swallowed as a
// header value.
function appendCdpHeader(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function configureBaseProgram() {
  program
      .version('Version ' + packageJSON.version)
      .name(packageJSON.name)
      .option('--allowed-origins <origins>', 'semicolon-separated list of origins to allow the browser to request. Default is to allow all.', semicolonSeparatedList)
      .option('--blocked-origins <origins>', 'semicolon-separated list of origins to block the browser from requesting. Blocklist is evaluated before allowlist. If used without the allowlist, requests not matching the blocklist are still allowed.', semicolonSeparatedList)
      .option('--block-service-workers', 'block service workers')
      .option('--browser <browser>', 'browser or chrome channel to use, possible values: chrome, firefox, webkit, msedge.')
      .option('--caps <caps>', 'comma-separated list of additional capabilities to enable, possible values: vision, pdf.', commaSeparatedList)
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
      .option('--image-responses <mode>', 'whether to send image responses to the client. Can be "allow" or "omit", Defaults to "allow".')
      .option('--mobile', 'emulate a generic mobile device (Pixel 10 for Chromium, iPhone 17 for WebKit). Cannot be combined with --device, CDP attach/launch modes, remote browser endpoints, or --extension.')
      .option('--no-sandbox', 'disable the sandbox for all process types that are normally sandboxed.')
      .option('--output-dir <path>', 'path to the directory for output files.')
      .option('--port <port>', 'port to listen on for MCP Streamable HTTP transport.')
      .option('--proxy-bypass <bypass>', 'comma-separated domains to bypass proxy, for example ".com,chromium.org,.domain.com"')
      .option('--proxy-server <proxy>', 'specify proxy server, for example "http://myproxy:3128" or "socks5://myproxy:8080"')
      .option('--save-session', 'Whether to save the Playwright MCP session into the output directory.')
      .option('--save-trace', 'Whether to save the Playwright Trace of the session into the output directory.')
      .option('--storage-state <path>', 'path to the storage state file to start the session from; applied in every mode except --extension (reused contexts receive it via setStorageState, which first clears their cookies and storage).')
      .option('--user-agent <ua string>', 'specify user agent string')
      .option('--user-data-dir <path>', 'path to the user data directory. If not specified, a temporary directory will be created.')
      .option('--viewport-size <size>', 'specify browser viewport size in pixels, for example "1280, 720"')
      .option('--navigation-timeout <ms>', 'maximum time in milliseconds for page navigation. Defaults to 60000ms (60 seconds).', parseInt)
      .option('--default-timeout <ms>', 'default timeout for all Playwright operations (clicks, fills, etc). Defaults to 5000ms (5 seconds).', parseInt)
      .option('--timeout-settle <ms>', 'how long to wait after each action for triggered work to settle, in milliseconds. Defaults to 500ms.', parseInt)
      .addOption(new Option('--connect-tool', 'Allow to switch between different browser connection methods.').hideHelp())
      .addOption(new Option('--vscode', 'VS Code tools.').hideHelp());

  return program;
}

configureBaseProgram()
    .action(async options => {
      // Cleanups the proxy modes register for their process-scoped switched
      // clients; they run before the contexts are disposed so a switched
      // provider (e.g. a spawned VS Code child) shuts down deliberately
      // instead of relying on process teardown.
      const exitCleanups: Array<() => Promise<void>> = [];
      setupExitWatchdog(async () => {
        for (const cleanup of exitCleanups)
          await cleanup().catch(logUnhandledError);
        await Context.disposeAll();
      });

      const { config, browserContextFactory, extensionContextFactory } = await resolveProgramContext(options);

      if (options.extension) {
        // Shared for the same reason as in startMCPServer (the extension
        // factory vetoes browser_session_open, but the veto itself must
        // still reach handshake-free HTTP requests consistently).
        const sessionRegistry = new BrowserSessionRegistry();
        const serverBackendFactory: mcpServer.ServerBackendFactory = {
          name: 'Playwright w/ extension',
          title: 'Accessibility Scanner (browser extension)',
          nameInConfig: 'playwright-extension',
          version: packageJSON.version,
          instructions: serverInstructions,
          // Static per process, same rationale as in startMCPServer above.
          toolListCacheHint: { ttlMs: 3600000, cacheScope: 'private' },
          create: () => new BrowserServerBackend(config, extensionContextFactory, sessionRegistry)
        };
        await mcpServer.start(serverBackendFactory, config.server);
        return;
      }

      if (options.vscode) {
        await runVSCodeTools(config, cleanup => exitCleanups.push(cleanup));
        return;
      }

      if (options.connectTool) {
        // Process-scoped, like startMCPServer's: over stateless HTTP every
        // handshake-free POST builds a fresh proxy with a fresh inner
        // backend, and a browserSessionId minted in one request must resolve
        // in the next instead of dying with the response. Shared between the
        // two providers as well, so a handle opened under one provider can
        // still be closed after a switch (each session's Context keeps the
        // factory it was created with).
        const sessionRegistry = new BrowserSessionRegistry();
        // A stateless per-request proxy flags its inner default context
        // ephemeral (disposable profile, see startMCPServer); stateful
        // proxies keep the stable profile.
        const makeProviders = (ephemeralDefaultContext: boolean): MCPProvider[] => [
          {
            name: 'default',
            description: 'Starts standalone browser',
            connect: () => mcpServer.wrapInProcess(new BrowserServerBackend(config, browserContextFactory, sessionRegistry, { ephemeralDefaultContext })),
          },
          {
            name: 'extension',
            description: 'Connect to a browser using the Playwright MCP extension',
            // Runs before the default provider is torn down, so a rejected
            // switch keeps the session on the provider that works.
            validate: () => assertStorageStateSupported(config, extensionContextFactory, 'The "extension" method works through the browser you are already running and uses the context it already has. Stay on the "default" method, or restart without the storage state and sign in in that browser.'),
            connect: () => mcpServer.wrapInProcess(new BrowserServerBackend(config, extensionContextFactory, sessionRegistry, { ephemeralDefaultContext })),
          },
        ];
        // Process-scoped browser_connect selection for handshake-free HTTP:
        // each such POST serves with a throwaway ProxyBackend, so a switch
        // stored only there would report success and silently revert to the
        // default provider on the next request. The shared client connects
        // through the stateful-flavored providers — it outlives any single
        // response, so it must not take the ephemeral per-request default
        // context.
        const sharedSelection: SharedProxySelection = { slot: new SharedClientSlot(), providers: makeProviders(false) };
        exitCleanups.push(async () => {
          // dispose(), not replace(undefined): shutdown must close the
          // switched client even while in-flight requests still hold leases
          // on it — nothing outlives the process, and waiting for a drain
          // could stall exit forever.
          await sharedSelection.slot.dispose();
        });
        const factory: mcpServer.ServerBackendFactory = {
          name: 'Playwright w/ switch',
          nameInConfig: 'playwright-switch',
          version: packageJSON.version,
          create: () => new ProxyBackend(makeProviders(false)),
          createStateless: () => new ProxyBackend(makeProviders(true), sharedSelection),
        };
        await mcpServer.start(factory, config.server);
        return;
      }

      await startMCPServer(config, browserContextFactory);
    });

program
    .command('list-tools')
    .description('List available MCP tools')
    .action(async () => {
      const parentOptions = program.opts();
      const { config } = await resolveProgramContext(parentOptions);
      const tools = filteredTools(config);
      for (const tool of tools) {
        // eslint-disable-next-line no-console
        console.log(`${tool.schema.name}  ${tool.schema.description}`);
      }
    });

program
    .command('interactive')
    .description('Start an interactive REPL for manual tool execution')
    .action(async () => {
      const parentOptions = program.opts();
      const { config, browserContextFactory, extensionContextFactory } = await resolveProgramContext(parentOptions);
      const backend = new BrowserServerBackend(config, parentOptions.extension ? extensionContextFactory : browserContextFactory);
      const handleExit = setupExitWatchdog();
      await backend.initialize(
          { notifyToolListChanged: async () => {} },
          { name: 'interactive-cli', version: packageJSON.version },
      );

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      // eslint-disable-next-line no-console
      console.log('Interactive mode. Type "<tool-name> <json>" to call a tool. Ctrl+D to exit.');

      const prompt = () => rl.prompt();
      rl.setPrompt('> ');
      prompt();

      rl.on('line', async (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) {
          prompt();
          return;
        }

        const spaceIndex = trimmed.indexOf(' ');
        const toolName = spaceIndex === -1 ? trimmed : trimmed.substring(0, spaceIndex);
        const jsonStr = spaceIndex === -1 ? '{}' : trimmed.substring(spaceIndex + 1).trim();

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(jsonStr) as Record<string, unknown>;
        } catch {
          // eslint-disable-next-line no-console
          console.error(`Invalid JSON: ${jsonStr}`);
          prompt();
          return;
        }

        try {
          const result = await backend.callTool(toolName, args);
          if (result.content) {
            for (const item of result.content) {
              if (item.type === 'text')
                // eslint-disable-next-line no-console
                console.log(item.text);
            }
          }
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(`Error: ${String(error)}`);
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
  return handleExit;
}

void program.parseAsync(process.argv);
