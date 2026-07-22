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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContextOptions, LaunchOptions } from 'playwright';
import { devices } from 'playwright';
import { sanitizeForFilePath } from './utils/fileUtils.js';

import type { Config, ToolCapability } from '../config.js';

export type CLIOptions = {
    allowedOrigins?: string[];
    blockedOrigins?: string[];
    blockServiceWorkers?: boolean;
    browser?: string;
    caps?: string[];
    cdpLaunchArgs?: string[];
    cdpLaunchCommand?: string;
    cdpLaunchCwd?: string;
    cdpLaunchPort?: number;
    cdpLaunchStartupTimeout?: number;
    cdpEndpoint?: string;
    cdpHeader?: string[];
    cdpTimeout?: number;
    config?: string;
    device?: string;
    executablePath?: string;
    extension?: boolean;
    headless?: boolean;
    host?: string;
    ignoreHttpsErrors?: boolean;
    isolated?: boolean;
    imageResponses?: 'allow' | 'omit';
    mobile?: boolean;
    sandbox?: boolean;
    outputDir?: string;
    port?: number;
    proxyBypass?: string;
    proxyServer?: string;
    saveSession?: boolean;
    saveTrace?: boolean;
    storageState?: string;
    userAgent?: string;
    userDataDir?: string;
    viewportSize?: string;
    navigationTimeout?: number;
    defaultTimeout?: number;
    settleTimeout?: number;
};

const defaultConfig: FullConfig = {
  browser: {
    browserName: 'chromium',
    launchOptions: {
      channel: 'chrome',
      headless: os.platform() === 'linux' && !process.env.DISPLAY,
      chromiumSandbox: true,
    },
    contextOptions: {
      viewport: null,
    },
  },
  network: {
    allowedOrigins: undefined,
    blockedOrigins: undefined,
  },
  server: {},
  saveTrace: false,
  timeouts: {
    navigationTimeout: 60000,
    defaultTimeout: 5000,
    settle: 500,
  },
};

type BrowserUserConfig = NonNullable<Config['browser']>;

export type FullConfig = Config & {
    browser: Omit<BrowserUserConfig, 'browserName'> & {
        browserName: 'chromium' | 'firefox' | 'webkit';
        launchOptions: NonNullable<BrowserUserConfig['launchOptions']>;
        contextOptions: NonNullable<BrowserUserConfig['contextOptions']>;
    },
    network: NonNullable<Config['network']>,
    saveTrace: boolean;
    server: NonNullable<Config['server']>,
    timeouts: NonNullable<Config['timeouts']>,
};

export async function resolveConfig(config: Config): Promise<FullConfig> {
  return mergeConfig(defaultConfig, config);
}

export async function resolveCLIConfig(cliOptions: CLIOptions): Promise<FullConfig> {
  const configInFile = await loadConfig(cliOptions.config);
  const envOptions = cliOptionsFromEnv();
  const envOverrides = configFromCLIOptions(envOptions);
  const cliOverrides = configFromCLIOptions(cliOptions);
  const result = mergeCLIConfigSources(configInFile, envOverrides, cliOverrides);
  return applyMobileConfig(result, configInFile, envOverrides, cliOverrides, envOptions, cliOptions);
}

type MobileSource = 'env' | 'cli';

function mergeCLIConfigSources(configInFile: Config, envOverrides: Config, cliOverrides: Config, mobileOverride?: Config, mobileSource?: MobileSource): FullConfig {
  let result = defaultConfig;
  result = mergeConfig(result, configInFile);
  if (mobileSource === 'env' && mobileOverride)
    result = mergeConfig(result, mobileOverride);
  result = mergeConfig(result, envOverrides);
  if (mobileSource === 'cli' && mobileOverride)
    result = mergeConfig(result, mobileOverride);
  result = mergeConfig(result, cliOverrides);
  return result;
}

function applyMobileConfig(resolved: FullConfig, configInFile: Config, envOverrides: Config, cliOverrides: Config, envOptions: CLIOptions, cliOptions: CLIOptions): FullConfig {
  const source = cliOptions.mobile !== undefined ? (cliOptions.mobile ? 'cli' : undefined) : (envOptions.mobile ? 'env' : undefined);
  if (!source)
    return resolved;

  if (cliOptions.device || envOptions.device)
    throw new Error('Cannot use --mobile together with --device, pick one.');
  if (cliOptions.extension)
    throw new Error('Mobile emulation is not supported with --extension.');
  if (resolved.browser.browserName === 'firefox')
    throw new Error('--mobile is not supported with the Firefox browser.');
  if (resolved.browser.cdpEndpoint)
    throw new Error('Mobile emulation is not supported with cdpEndpoint.');
  if (resolved.browser.remoteEndpoint)
    throw new Error('Mobile emulation is not supported with remoteEndpoint.');
  if (resolved.browser.cdpLaunch)
    throw new Error('Mobile emulation is not supported with --cdp-launch-command.');

  const device = resolved.browser.browserName === 'webkit' ? 'iPhone 17' : 'Pixel 10';
  const mobileOverride: Config = { browser: { contextOptions: devices[device] } };
  return mergeCLIConfigSources(configInFile, envOverrides, cliOverrides, mobileOverride, source);
}

export function configFromCLIOptions(cliOptions: CLIOptions): Config {
  let browserName: 'chromium' | 'firefox' | 'webkit' | undefined;
  let channel: string | undefined;
  switch (cliOptions.browser) {
    case 'chrome':
    case 'chrome-beta':
    case 'chrome-canary':
    case 'chrome-dev':
    case 'chromium':
    case 'msedge':
    case 'msedge-beta':
    case 'msedge-canary':
    case 'msedge-dev':
      browserName = 'chromium';
      channel = cliOptions.browser;
      break;
    case 'firefox':
      browserName = 'firefox';
      break;
    case 'webkit':
      browserName = 'webkit';
      break;
  }

  // Launch options
  const launchOptions: LaunchOptions = {
    channel,
    executablePath: cliOptions.executablePath,
    headless: cliOptions.headless,
  };

  // --no-sandbox was passed, disable the sandbox
  if (cliOptions.sandbox === false)
    launchOptions.chromiumSandbox = false;

  if (cliOptions.proxyServer) {
    launchOptions.proxy = {
      server: cliOptions.proxyServer
    };
    if (cliOptions.proxyBypass)
      launchOptions.proxy.bypass = cliOptions.proxyBypass;
  }

  if (cliOptions.device && cliOptions.cdpEndpoint)
    throw new Error('Device emulation is not supported with cdpEndpoint.');

  if (cliOptions.cdpEndpoint && cliOptions.cdpLaunchCommand)
    throw new Error('CDP launch is not supported with cdpEndpoint.');

  // Context options
  const contextOptions: BrowserContextOptions = cliOptions.device ? devices[cliOptions.device] : {};
  if (cliOptions.storageState)
    contextOptions.storageState = cliOptions.storageState;

  if (cliOptions.userAgent)
    contextOptions.userAgent = cliOptions.userAgent;

  if (cliOptions.viewportSize) {
    try {
      const [width, height] = cliOptions.viewportSize.split(',').map(n => +n);
      if (isNaN(width) || isNaN(height))
        throw new Error('bad values');
      contextOptions.viewport = { width, height };
    } catch (e) {
      throw new Error('Invalid viewport size format: use "width,height", for example --viewport-size="800,600"');
    }
  }

  if (cliOptions.ignoreHttpsErrors)
    contextOptions.ignoreHTTPSErrors = true;

  if (cliOptions.blockServiceWorkers)
    contextOptions.serviceWorkers = 'block';

  const cdpLaunch = cliOptions.cdpLaunchCommand ? {
    command: cliOptions.cdpLaunchCommand,
    args: cliOptions.cdpLaunchArgs,
    cwd: cliOptions.cdpLaunchCwd,
    port: cliOptions.cdpLaunchPort,
    startupTimeoutMs: cliOptions.cdpLaunchStartupTimeout,
  } : undefined;

  return {
    browser: {
      browserName,
      isolated: cliOptions.isolated,
      userDataDir: cliOptions.userDataDir,
      launchOptions,
      contextOptions,
      cdpLaunch,
      cdpEndpoint: cliOptions.cdpEndpoint,
      cdpHeaders: parseCdpHeaders(cliOptions.cdpHeader),
      cdpTimeout: cliOptions.cdpTimeout,
    },
    server: {
      port: cliOptions.port,
      host: cliOptions.host,
    },
    capabilities: cliOptions.caps as ToolCapability[],
    network: {
      allowedOrigins: cliOptions.allowedOrigins,
      blockedOrigins: cliOptions.blockedOrigins,
    },
    saveSession: cliOptions.saveSession,
    saveTrace: cliOptions.saveTrace,
    outputDir: cliOptions.outputDir,
    imageResponses: cliOptions.imageResponses,
    timeouts: {
      navigationTimeout: cliOptions.navigationTimeout,
      defaultTimeout: cliOptions.defaultTimeout,
      settle: cliOptions.settleTimeout,
    }
  };
}

function cliOptionsFromEnv(): CLIOptions {
  const options: CLIOptions = {};
  options.allowedOrigins = semicolonSeparatedList(process.env.PLAYWRIGHT_MCP_ALLOWED_ORIGINS);
  options.blockedOrigins = semicolonSeparatedList(process.env.PLAYWRIGHT_MCP_BLOCKED_ORIGINS);
  options.blockServiceWorkers = envToBoolean(process.env.PLAYWRIGHT_MCP_BLOCK_SERVICE_WORKERS);
  options.browser = envToString(process.env.PLAYWRIGHT_MCP_BROWSER);
  options.caps = commaSeparatedList(process.env.PLAYWRIGHT_MCP_CAPS);
  options.cdpLaunchArgs = commaSeparatedList(process.env.PLAYWRIGHT_MCP_CDP_LAUNCH_ARGS);
  options.cdpLaunchCommand = envToString(process.env.PLAYWRIGHT_MCP_CDP_LAUNCH_COMMAND);
  options.cdpLaunchCwd = envToString(process.env.PLAYWRIGHT_MCP_CDP_LAUNCH_CWD);
  options.cdpLaunchPort = envToNumber(process.env.PLAYWRIGHT_MCP_CDP_LAUNCH_PORT);
  options.cdpLaunchStartupTimeout = envToNumber(process.env.PLAYWRIGHT_MCP_CDP_LAUNCH_STARTUP_TIMEOUT);
  options.cdpEndpoint = envToString(process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT);
  options.cdpHeader = newlineSeparatedList(process.env.PLAYWRIGHT_MCP_CDP_HEADERS);
  options.cdpTimeout = envToNumber(process.env.PLAYWRIGHT_MCP_CDP_TIMEOUT);
  options.config = envToString(process.env.PLAYWRIGHT_MCP_CONFIG);
  options.device = envToString(process.env.PLAYWRIGHT_MCP_DEVICE);
  options.executablePath = envToString(process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH);
  options.headless = envToBoolean(process.env.PLAYWRIGHT_MCP_HEADLESS);
  options.host = envToString(process.env.PLAYWRIGHT_MCP_HOST);
  options.ignoreHttpsErrors = envToBoolean(process.env.PLAYWRIGHT_MCP_IGNORE_HTTPS_ERRORS);
  options.isolated = envToBoolean(process.env.PLAYWRIGHT_MCP_ISOLATED);
  if (process.env.PLAYWRIGHT_MCP_IMAGE_RESPONSES === 'omit')
    options.imageResponses = 'omit';
  options.mobile = envToBoolean(process.env.PLAYWRIGHT_MCP_MOBILE);
  options.sandbox = envToBoolean(process.env.PLAYWRIGHT_MCP_SANDBOX);
  options.outputDir = envToString(process.env.PLAYWRIGHT_MCP_OUTPUT_DIR);
  options.port = envToNumber(process.env.PLAYWRIGHT_MCP_PORT);
  options.proxyBypass = envToString(process.env.PLAYWRIGHT_MCP_PROXY_BYPASS);
  options.proxyServer = envToString(process.env.PLAYWRIGHT_MCP_PROXY_SERVER);
  options.saveTrace = envToBoolean(process.env.PLAYWRIGHT_MCP_SAVE_TRACE);
  options.storageState = envToString(process.env.PLAYWRIGHT_MCP_STORAGE_STATE);
  options.userAgent = envToString(process.env.PLAYWRIGHT_MCP_USER_AGENT);
  options.userDataDir = envToString(process.env.PLAYWRIGHT_MCP_USER_DATA_DIR);
  options.viewportSize = envToString(process.env.PLAYWRIGHT_MCP_VIEWPORT_SIZE);
  options.navigationTimeout = envToNumber(process.env.PLAYWRIGHT_MCP_NAVIGATION_TIMEOUT);
  options.defaultTimeout = envToNumber(process.env.PLAYWRIGHT_MCP_DEFAULT_TIMEOUT);
  options.settleTimeout = envToNumber(process.env.PLAYWRIGHT_MCP_TIMEOUT_SETTLE);
  return options;
}

async function loadConfig(configFile: string | undefined): Promise<Config> {
  if (!configFile)
    return {};

  try {
    return JSON.parse(await fs.promises.readFile(configFile, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to load config file: ${configFile}, ${error}`);
  }
}

export async function outputFile(config: FullConfig, rootPath: string | undefined, name: string): Promise<string> {
  const outputDir = config.outputDir
        ?? (rootPath ? path.join(rootPath, '.playwright-mcp') : undefined)
        ?? path.join(os.tmpdir(), 'playwright-mcp-output', sanitizeForFilePath(new Date().toISOString()));

  await fs.promises.mkdir(outputDir, { recursive: true });
  const fileName = sanitizeForFilePath(name);
  return path.join(outputDir, fileName);
}

function pickDefined<T extends object>(obj: T | undefined): Partial<T> {
  return Object.fromEntries(
      Object.entries(obj ?? {}).filter(([_, v]) => v !== undefined)
  ) as Partial<T>;
}

function mergeConfig(base: FullConfig, overrides: Config): FullConfig {
  const browser: FullConfig['browser'] = {
    ...pickDefined(base.browser),
    ...pickDefined(overrides.browser),
    browserName: overrides.browser?.browserName ?? base.browser?.browserName ?? 'chromium',
    isolated: overrides.browser?.isolated ?? base.browser?.isolated ?? false,
    launchOptions: {
      ...pickDefined(base.browser?.launchOptions),
      ...pickDefined(overrides.browser?.launchOptions),
      ...{ assistantMode: true },
    },
    contextOptions: {
      ...pickDefined(base.browser?.contextOptions),
      ...pickDefined(overrides.browser?.contextOptions),
    },
  };

  if (browser.browserName !== 'chromium' && browser.launchOptions)
    delete browser.launchOptions.channel;

  return {
    ...pickDefined(base),
    ...pickDefined(overrides),
    browser,
    network: {
      ...pickDefined(base.network),
      ...pickDefined(overrides.network),
    },
    server: {
      ...pickDefined(base.server),
      ...pickDefined(overrides.server),
    },
    timeouts: {
      navigationTimeout: overrides.timeouts?.navigationTimeout ?? base.timeouts.navigationTimeout,
      defaultTimeout: overrides.timeouts?.defaultTimeout ?? base.timeouts.defaultTimeout,
      settle: overrides.timeouts?.settle ?? base.timeouts.settle,
    },
  } as FullConfig;
}

export function semicolonSeparatedList(value: string | undefined): string[] | undefined {
  if (!value)
    return undefined;
  return value.split(';').map(v => v.trim());
}

export function commaSeparatedList(value: string | undefined): string[] | undefined {
  if (!value)
    return undefined;
  return value.split(',').map(v => v.trim());
}

/**
 * Splits a value into a list on newlines, trimming each entry and dropping
 * empties. Used for `PLAYWRIGHT_MCP_CDP_HEADERS` so that commas inside header
 * values (e.g. `Forwarded: for=a, for=b`) are preserved.
 */
export function newlineSeparatedList(value: string | undefined): string[] | undefined {
  if (!value)
    return undefined;
  const entries = value.split('\n').map(v => v.trim()).filter(Boolean);
  return entries.length ? entries : undefined;
}

/**
 * Parses `Name: Value` header entries (from `--cdp-header` flags or the
 * newline-separated `PLAYWRIGHT_MCP_CDP_HEADERS` env var) into a header map.
 * Only the first colon is treated as the name/value separator, so colons inside
 * the value are preserved.
 */
export function parseCdpHeaders(entries: string[] | undefined): Record<string, string> | undefined {
  if (!entries || !entries.length)
    return undefined;
  const headers: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf(':');
    if (separator === -1)
      throw new Error(`Invalid CDP header "${entry}", expected "Name: Value" format.`);
    const name = entry.slice(0, separator).trim();
    if (!name)
      throw new Error(`Invalid CDP header "${entry}", header name is empty.`);
    headers[name] = entry.slice(separator + 1).trim();
  }
  return headers;
}

function envToNumber(value: string | undefined): number | undefined {
  if (!value)
    return undefined;
  return +value;
}

function envToBoolean(value: string | undefined): boolean | undefined {
  if (value === 'true' || value === '1')
    return true;
  if (value === 'false' || value === '0')
    return false;
  return undefined;
}

function envToString(value: string | undefined): string | undefined {
  return value ? value.trim() : undefined;
}
