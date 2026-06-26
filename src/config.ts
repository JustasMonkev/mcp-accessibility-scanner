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

/**
 * Prefix of the per-context trace folder created by `startTraceServer`.
 */
export const OUTPUT_TRACE_FOLDER_PREFIX = 'traces-';

/**
 * Supplies the set of output directories that belong to live sessions (session
 * logs and in-progress traces) and must be preserved during `outputMaxSize`
 * eviction. The provider is registered by the context layer so that eviction —
 * which can be triggered from any tool, in any of several concurrent HTTP
 * sessions sharing one output directory — protects every active session's
 * folders, not just a single inferred one. Defaults to protecting nothing.
 */
type ProtectedOutputDirsProvider = () => string[];

let protectedOutputDirsProvider: ProtectedOutputDirsProvider = () => [];

export function setProtectedOutputDirsProvider(provider: ProtectedOutputDirsProvider): void {
  protectedOutputDirsProvider = provider;
}

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
    headless?: boolean;
    host?: string;
    ignoreHttpsErrors?: boolean;
    isolated?: boolean;
    imageResponses?: 'allow' | 'omit';
    sandbox?: boolean;
    outputDir?: string;
    port?: number;
    proxyBypass?: string;
    proxyServer?: string;
    saveSession?: boolean;
    saveTrace?: boolean;
    outputMaxSize?: number;
    storageState?: string;
    userAgent?: string;
    userDataDir?: string;
    viewportSize?: string;
    navigationTimeout?: number;
    defaultTimeout?: number;
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
  const envOverrides = configFromEnv();
  const cliOverrides = configFromCLIOptions(cliOptions);
  let result = defaultConfig;
  result = mergeConfig(result, configInFile);
  result = mergeConfig(result, envOverrides);
  result = mergeConfig(result, cliOverrides);
  return result;
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
    outputMaxSize: cliOptions.outputMaxSize,
    imageResponses: cliOptions.imageResponses,
    timeouts: {
      navigationTimeout: cliOptions.navigationTimeout,
      defaultTimeout: cliOptions.defaultTimeout,
    }
  };
}

function configFromEnv(): Config {
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
  options.sandbox = envToBoolean(process.env.PLAYWRIGHT_MCP_SANDBOX);
  options.outputDir = envToString(process.env.PLAYWRIGHT_MCP_OUTPUT_DIR);
  options.outputMaxSize = envToNumber(process.env.PLAYWRIGHT_MCP_OUTPUT_MAX_SIZE);
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
  return configFromCLIOptions(options);
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
  // Pure path allocation: eviction is driven centrally by `evictOutputFiles`
  // (see `OutputEvictionGate`) so it never races with a tool that is writing.
  const outputDir = outputDirectory(config, rootPath);
  await fs.promises.mkdir(outputDir, { recursive: true });
  const fileName = sanitizeForFilePath(name);
  return path.join(outputDir, fileName);
}

export async function evictOutputFiles(config: FullConfig, rootPath: string | undefined): Promise<void> {
  // Skip all filesystem work (including creating the output directory) when no
  // size cap is configured, so plain tool calls never materialize an output dir
  // for users who never opted into eviction.
  if (config.outputMaxSize === undefined)
    return;
  const outputDir = outputEvictionDirectory(config, rootPath);
  await evictOldOutputFiles(outputDir, config.outputMaxSize);
}

function outputDirectory(config: FullConfig, rootPath: string | undefined): string {
  return config.outputDir
    ?? (rootPath ? path.join(rootPath, '.playwright-mcp') : undefined)
    ?? path.join(defaultTempOutputDirectory(), sanitizeForFilePath(new Date().toISOString()));
}

function outputEvictionDirectory(config: FullConfig, rootPath: string | undefined): string {
  return config.outputDir
    ?? (rootPath ? path.join(rootPath, '.playwright-mcp') : undefined)
    ?? defaultTempOutputDirectory();
}

function defaultTempOutputDirectory(): string {
  return path.join(os.tmpdir(), 'playwright-mcp-output');
}

async function evictOldOutputFiles(outputDir: string, maxSize: number | undefined) {
  const limit = validateOutputMaxSize(maxSize);
  if (limit === undefined)
    return;

  // Folders for every live session (session logs and in-progress traces across
  // all concurrent contexts) are skipped wholesale so a tool in one session can
  // never evict another session's active artifacts.
  const protectedDirs = protectedOutputDirsProvider().map(dir => path.resolve(dir));
  const evictableFiles = await collectEvictableFiles(outputDir, protectedDirs);

  let totalSize = evictableFiles.reduce((total, file) => total + file.size, 0);
  evictableFiles.sort((a, b) => a.mtimeMs - b.mtimeMs || a.filePath.localeCompare(b.filePath));
  for (const file of evictableFiles) {
    if (totalSize <= limit)
      return;
    await fs.promises.rm(file.filePath, { force: true });
    totalSize -= file.size;
  }
}

type OutputFileEntry = {
  filePath: string;
  size: number;
  mtimeMs: number;
};

async function collectEvictableFiles(outputDir: string, protectedDirs: string[]): Promise<OutputFileEntry[]> {
  const files: OutputFileEntry[] = [];

  const walk = async (dir: string): Promise<void> => {
    if (isWithinAnyDir(dir, protectedDirs))
      return;

    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isFileNotFoundError(error))
        return;
      throw error;
    }

    await Promise.all(dirents.map(async dirent => {
      const filePath = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(filePath);
        return;
      }
      if (!dirent.isFile())
        return;
      let size: number;
      let mtimeMs: number;
      try {
        ({ size, mtimeMs } = await fs.promises.stat(filePath));
      } catch (error) {
        if (isFileNotFoundError(error))
          return;
        throw error;
      }
      files.push({ filePath, size, mtimeMs });
    }));
  };

  await walk(path.resolve(outputDir));
  return files;
}

function isWithinAnyDir(filePath: string, dirs: string[]): boolean {
  return dirs.some(dir => filePath === dir || filePath.startsWith(dir + path.sep));
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function validateOutputMaxSize(outputMaxSize: number | undefined): number | undefined {
  if (outputMaxSize === undefined)
    return undefined;
  if (!Number.isFinite(outputMaxSize) || outputMaxSize < 0)
    throw new Error('outputMaxSize must be a non-negative number');
  return outputMaxSize;
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

  const outputMaxSize = validateOutputMaxSize(overrides.outputMaxSize ?? base.outputMaxSize);

  return {
    ...pickDefined(base),
    ...pickDefined(overrides),
    outputMaxSize,
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
