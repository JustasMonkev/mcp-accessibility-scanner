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
import { safeIsoTimestampForFileName, sanitizeForFilePath } from './utils/fileUtils.js';

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
    snapshotBoxes?: boolean;
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
        chromiumSandboxDefaulted?: boolean;
        launchOptions: NonNullable<BrowserUserConfig['launchOptions']>;
        contextOptions: NonNullable<BrowserUserConfig['contextOptions']>;
    },
    network: NonNullable<Config['network']>,
    saveTrace: boolean;
    server: NonNullable<Config['server']>,
    timeouts: NonNullable<Config['timeouts']>,
};

export async function resolveConfig(config: Config): Promise<FullConfig> {
  return validateResolvedConfig(mergeConfig(defaultConfig, config));
}

export async function resolveCLIConfig(cliOptions: CLIOptions): Promise<FullConfig> {
  const configInFile = await loadConfig(cliOptions.config);
  const envOptions = cliOptionsFromEnv();
  const envOverrides = configFromCLIOptions(envOptions, true);
  const cliOverrides = configFromCLIOptions(cliOptions);
  const result = mergeCLIConfigSources(configInFile, envOverrides, cliOverrides);
  return validateResolvedConfig(applyMobileConfig(result, configInFile, envOverrides, cliOverrides, envOptions, cliOptions));
}

// A blank outputDir is an explicit value with no usable meaning, and both
// ways of tolerating it go wrong silently: honoring it would fail on
// mkdir('') only at the first artifact write — deep into a run — while
// treating it as omitted (what a truthiness check on the resolved value does)
// would quietly redirect artifacts the user configured a destination for
// into a temp directory. Rejected here instead, at startup like the other
// config validations, on the merged result so every source (config file,
// env, CLI, programmatic Config) is covered. Only undefined/null count as
// omitted — the nullish semantics the fallback historically used.
function validateResolvedConfig(config: FullConfig): FullConfig {
  if (config.outputDir !== undefined && config.outputDir !== null && !String(config.outputDir).trim())
    throw new Error('outputDir must not be blank: provide a directory path, or omit the option to use a temp directory.');
  if (config.browser.browserName === 'chromium' && !config.browser.remoteEndpoint && config.browser.launchOptions.chromiumSandbox === undefined) {
    const { channel, executablePath } = config.browser.launchOptions;
    config.browser.launchOptions.chromiumSandbox = os.platform() !== 'linux'
      || executablePath !== undefined
      || (channel !== undefined && channel !== 'chromium' && channel !== 'chrome-for-testing');
    config.browser.chromiumSandboxDefaulted = true;
  }
  return config;
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

function configFromCLIOptions(cliOptions: CLIOptions, sandboxTrueIsExplicit = false): Config {
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

  // Commander reports true when --no-sandbox is omitted, while true from the
  // environment is explicit and must override the platform default.
  if (cliOptions.sandbox === false || (sandboxTrueIsExplicit && cliOptions.sandbox === true))
    launchOptions.chromiumSandbox = cliOptions.sandbox;

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
    snapshot: cliOptions.snapshotBoxes !== undefined ? { boxes: cliOptions.snapshotBoxes } : undefined,
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
  options.snapshotBoxes = envToBoolean(process.env.PLAYWRIGHT_MCP_SNAPSHOT_BOXES);
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

// One fallback output directory per resolved config — i.e. per server, which
// resolves its FullConfig once and hands the same object to every consumer.
// Recomputing the timestamped path per call scattered one audit's artifacts
// (screenshots, JSON reports, traces, session logs) across a different temp
// directory per millisecond tick. Keyed weakly on the config object so two
// server instances in one process still get distinct fallback directories.
const defaultOutputDirs = new WeakMap<FullConfig, string>();

/**
 * Resolves the output directory this config's artifacts land in, memoizing
 * the timestamped fallback when no `outputDir` is configured. Exported so a
 * config that crosses an identity boundary — the VS Code integration
 * serializes it into a spawned provider process, where JSON.parse mints a new
 * object the WeakMap has never seen — can materialize the resolved fallback
 * into the serialized copy instead of letting the other side mint a second
 * temp root.
 */
export function resolveOutputDir(config: FullConfig): string {
  if (config.outputDir)
    return config.outputDir;
  let outputDir = defaultOutputDirs.get(config);
  if (!outputDir) {
    // The random token keeps two servers starting in the same millisecond
    // from sharing a fallback directory — the per-call timestamp used to
    // make that unlikely; a per-server one no longer would.
    outputDir = path.join(os.tmpdir(), 'playwright-mcp-output', safeIsoTimestampForFileName());
    defaultOutputDirs.set(config, outputDir);
  }
  return outputDir;
}

export async function outputFile(config: FullConfig, name: string, exclusive = false): Promise<string> {
  const fileName = name.trim() ? sanitizeForFilePath(name) : '';
  if (!fileName || fileName === '.' || fileName === '..' || /[. ]$/.test(name) || /[. ]$/.test(fileName) || /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(fileName))
    throw new Error(`Invalid output filename "${name}": use a portable, non-reserved file name.`);
  const outputDir = resolveOutputDir(config);
  await fs.promises.mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, fileName);
  if (!exclusive)
    return filePath;
  try {
    const handle = await fs.promises.open(filePath, 'wx');
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(`Output file already exists: ${filePath}. Choose a different filename.`, { cause: error });
    throw error;
  }
  return filePath;
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
function newlineSeparatedList(value: string | undefined): string[] | undefined {
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
 *
 * @public
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
