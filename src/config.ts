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
import { assertNetworkPolicySupported } from './networkPolicy.js';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContextOptions, LaunchOptions } from 'playwright';
import { devices } from 'playwright';
import { toolNameList } from './mcp/toolPolicy.js';
import { safeIsoTimestampForFileName, sanitizeForFilePath } from './utils/fileUtils.js';

import type { Config, ToolCapability } from '../config.js';

export type CLIOptions = {
    allowedOrigins?: string[];
    allowedUploadDirs?: string[];
    authToken?: string;
    blockedOrigins?: string[];
    blockServiceWorkers?: boolean;
    browser?: string;
    caps?: string[];
    allowedTools?: string[];
    blockedTools?: string[];
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
    imageResponses?: Config['imageResponses'];
    mobile?: boolean;
    sandbox?: boolean;
    tabGroup?: boolean;
    outputDir?: string;
    filePaths?: string;
    port?: number;
    profileDirName?: string;
    proxyBypass?: string;
    proxyServer?: string;
    redactUrlParams?: string[];
    saveSession?: boolean;
    saveTrace?: boolean;
    snapshotBoxes?: boolean;
    storageState?: string;
    userAgent?: string;
    userDataDir?: string;
    viewportSize?: string;
    navigationTimeout?: number;
    defaultTimeout?: number;
    timeoutSettle?: number;
    timeoutIdle?: number;
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
  tabGroup: true,
  timeouts: {
    navigationTimeout: 60000,
    defaultTimeout: 5000,
    settle: 500,
    idle: 0,
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
    timeouts: Required<NonNullable<Config['timeouts']>>,
};

export async function resolveConfig(config: Config): Promise<FullConfig> {
  return validateResolvedConfig(mergeConfig(defaultConfig, config));
}

export async function resolveCLIConfig(cliOptions: CLIOptions): Promise<FullConfig> {
  const configInFile = await loadConfig(cliOptions.config);
  const envOptions = cliOptionsFromEnv();
  const device = cliOptions.device || envOptions.device;
  if (device && !Object.prototype.hasOwnProperty.call(devices, device))
    throw new Error(`Unknown device "${device}"`);
  const envOverrides = configFromCLIOptions(envOptions, true);
  const noTabGroup = envToBoolean(process.env.PLAYWRIGHT_MCP_NO_TAB_GROUP);
  if (noTabGroup !== undefined)
    envOverrides.tabGroup = !noTabGroup;
  const layers: ConfigLayers = { file: configInFile, env: envOverrides, cli: configFromCLIOptions(cliOptions) };
  const options: OptionLayers = { env: envOptions, cli: cliOptions };
  return validateResolvedConfig(applyMobileConfig(mergeConfigLayers(layers), layers, options));
}

async function validateResolvedConfig(config: FullConfig): Promise<FullConfig> {
  assertNetworkPolicySupported(config);
  normalizeRedactUrlParams(config);
  if (config.allowedTools !== undefined || config.blockedTools !== undefined) {
    const { validateToolPolicy } = await import('./tools.js');
    validateToolPolicy(config);
  }
  validateAuthToken(config.server.authToken);
  parseFilePaths(config.filePaths);
  applyProxyToClientCertificates(config);
  validateIdleTimeout(config.timeouts.idle);
  config.browser.allowedUploadDirs = await resolveUploadDirs(config.browser.allowedUploadDirs);
  if (config.outputDir !== undefined && config.outputDir !== null && !String(config.outputDir).trim())
    throw new Error('outputDir must not be blank: provide a directory path, or omit the option to use a temp directory.');
  validateProfileDirName(config.browser.profileDirName);
  applyDefaultChromiumSandbox(config);
  return config;
}

function normalizeRedactUrlParams(config: FullConfig): void {
  if (config.redactUrlParams === undefined)
    return;
  if (!Array.isArray(config.redactUrlParams) || config.redactUrlParams.some(name => typeof name !== 'string' || !name.trim()))
    throw new Error('redactUrlParams must be an array of non-blank parameter names. Use [] to disable URL parameter redaction.');
  config.redactUrlParams = config.redactUrlParams.map(name => name.trim());
}

const plainBypassEntry = /^\.?[a-z0-9-]+(\.[a-z0-9-]+)*$/i;

function applyProxyToClientCertificates(config: FullConfig): void {
  const { contextOptions, launchOptions } = config.browser;
  if (!contextOptions.clientCertificates?.length)
    return;
  const proxy = contextOptions.proxy ?? launchOptions.proxy;
  // With certificates, Playwright routes every request through its certificate
  // interceptor, which matches bypass entries only as domain suffixes. Reject
  // browser-specific syntax there rather than silently proxying those routes.
  const unsupported = proxy?.bypass?.split(',').map(entry => entry.trim()).filter(entry => entry && !plainBypassEntry.test(entry));
  if (unsupported?.length)
    throw new Error(`clientCertificates supports only host and domain entries in proxy.bypass, such as "example.com" or ".example.com"; unsupported: ${unsupported.map(entry => JSON.stringify(entry)).join(', ')}. Wildcards, ports, IP ranges and <local> are not applied by Playwright's certificate interceptor. No browser was started.`);
  // The interceptor compares entries against the lowercased URL hostname as-is.
  if (proxy)
    contextOptions.proxy = proxy.bypass ? { ...proxy, bypass: proxy.bypass.toLowerCase() } : proxy;
}

const maxTimerDelayMs = 2_147_483_647;

function validateIdleTimeout(idle: number): void {
  if (!Number.isInteger(idle) || idle < 0 || idle > maxTimerDelayMs)
    throw new Error(`timeouts.idle must be an integer from 0 to ${maxTimerDelayMs} milliseconds. Use 0 to disable idle shutdown.`);
}

async function resolveUploadDirs(uploadDirs: string[] | undefined): Promise<string[] | undefined> {
  if (uploadDirs === undefined)
    return undefined;
  if (!Array.isArray(uploadDirs))
    throw new Error('allowedUploadDirs must be an array of directory paths. Use [] to deny all uploads.');
  if (uploadDirs.some(dir => typeof dir !== 'string' || !dir.trim()))
    throw new Error('allowedUploadDirs must not contain blank directory entries. Use [] to deny all uploads.');
  return await Promise.all(uploadDirs.map(dir => fs.promises.realpath(dir)));
}

function validateProfileDirName(profileDirName: unknown): void {
  if (profileDirName !== undefined && (typeof profileDirName !== 'string' || !/^(?:Default|Profile \d+)$/.test(profileDirName)))
    throw new Error(`Invalid browser profile directory name ${JSON.stringify(profileDirName)}: must be a Chrome profile directory name such as "Default" or "Profile 1" (see "Profile Path" at chrome://version).`);
}

function applyDefaultChromiumSandbox(config: FullConfig): void {
  const { browser } = config;
  if (browser.browserName !== 'chromium' || browser.remoteEndpoint || browser.launchOptions.chromiumSandbox !== undefined)
    return;
  const { channel, executablePath } = browser.launchOptions;
  const bundledChromiumOnLinux = os.platform() === 'linux'
    && executablePath === undefined
    && (channel === undefined || channel === 'chromium' || channel === 'chrome-for-testing');
  browser.launchOptions.chromiumSandbox = !bundledChromiumOnLinux;
  browser.chromiumSandboxDefaulted = true;
}

type MobileSource = 'env' | 'cli';
type ConfigLayers = { file: Config, env: Config, cli: Config };
type OptionLayers = { env: CLIOptions, cli: CLIOptions };

function mergeConfigLayers(layers: ConfigLayers, mobile?: { override: Config, source: MobileSource }): FullConfig {
  let result = mergeConfig(defaultConfig, layers.file);
  for (const source of ['env', 'cli'] as const) {
    if (mobile?.source === source)
      result = mergeConfig(result, mobile.override);
    result = mergeConfig(result, layers[source]);
  }
  return result;
}

function mobileSourceOf(options: OptionLayers): MobileSource | undefined {
  if (options.cli.mobile !== undefined)
    return options.cli.mobile ? 'cli' : undefined;
  return options.env.mobile ? 'env' : undefined;
}

function applyMobileConfig(resolved: FullConfig, layers: ConfigLayers, options: OptionLayers): FullConfig {
  const source = mobileSourceOf(options);
  if (!source)
    return resolved;

  if (options.cli.device || options.env.device)
    throw new Error('Cannot use --mobile together with --device, pick one.');
  if (options.cli.extension)
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
  return mergeConfigLayers(layers, { override: { browser: { contextOptions: devices[device] } }, source });
}

const chromiumChannels = new Set(['chrome', 'chrome-beta', 'chrome-canary', 'chrome-dev', 'chromium', 'msedge', 'msedge-beta', 'msedge-canary', 'msedge-dev']);

function browserFromCLIOption(browser: string | undefined): { browserName?: 'chromium' | 'firefox' | 'webkit', channel?: string } {
  if (browser && chromiumChannels.has(browser))
    return { browserName: 'chromium', channel: browser };
  if (browser === 'firefox' || browser === 'webkit')
    return { browserName: browser };
  return {};
}

function parseViewportSize(viewportSize: string): { width: number, height: number } {
  const [width, height] = viewportSize.split(',').map(n => +n);
  if (isNaN(width) || isNaN(height))
    throw new Error('Invalid viewport size format: use "width,height", for example --viewport-size="800,600"');
  return { width, height };
}

function launchOptionsFromCLI(cliOptions: CLIOptions, channel: string | undefined, sandboxTrueIsExplicit: boolean): LaunchOptions {
  const launchOptions: LaunchOptions = {
    channel,
    executablePath: cliOptions.executablePath,
    headless: cliOptions.headless,
  };
  if (cliOptions.sandbox === false || (sandboxTrueIsExplicit && cliOptions.sandbox === true))
    launchOptions.chromiumSandbox = cliOptions.sandbox;
  if (cliOptions.proxyServer) {
    launchOptions.proxy = proxySettingsFromString(cliOptions.proxyServer);
    if (cliOptions.proxyBypass)
      launchOptions.proxy.bypass = cliOptions.proxyBypass;
  }
  return launchOptions;
}

function contextOptionsFromCLI(cliOptions: CLIOptions): BrowserContextOptions {
  const contextOptions: BrowserContextOptions = cliOptions.device ? { ...devices[cliOptions.device] } : {};
  if (cliOptions.storageState)
    contextOptions.storageState = cliOptions.storageState;
  if (cliOptions.userAgent)
    contextOptions.userAgent = cliOptions.userAgent;
  if (cliOptions.viewportSize)
    contextOptions.viewport = parseViewportSize(cliOptions.viewportSize);
  if (cliOptions.ignoreHttpsErrors)
    contextOptions.ignoreHTTPSErrors = true;
  if (cliOptions.blockServiceWorkers)
    contextOptions.serviceWorkers = 'block';
  return contextOptions;
}

function cdpLaunchFromCLI(cliOptions: CLIOptions): NonNullable<Config['browser']>['cdpLaunch'] {
  if (!cliOptions.cdpLaunchCommand)
    return undefined;
  return {
    command: cliOptions.cdpLaunchCommand,
    args: cliOptions.cdpLaunchArgs,
    cwd: cliOptions.cdpLaunchCwd,
    port: cliOptions.cdpLaunchPort,
    startupTimeoutMs: cliOptions.cdpLaunchStartupTimeout,
  };
}

function configFromCLIOptions(cliOptions: CLIOptions, sandboxTrueIsExplicit = false): Config {
  if (cliOptions.device && cliOptions.cdpEndpoint)
    throw new Error('Device emulation is not supported with cdpEndpoint.');
  if (cliOptions.cdpEndpoint && cliOptions.cdpLaunchCommand)
    throw new Error('CDP launch is not supported with cdpEndpoint.');

  const { browserName, channel } = browserFromCLIOption(cliOptions.browser);
  return {
    browser: {
      browserName,
      isolated: cliOptions.isolated,
      userDataDir: cliOptions.userDataDir,
      profileDirName: cliOptions.profileDirName,
      allowedUploadDirs: cliOptions.allowedUploadDirs,
      launchOptions: launchOptionsFromCLI(cliOptions, channel, sandboxTrueIsExplicit),
      contextOptions: contextOptionsFromCLI(cliOptions),
      cdpLaunch: cdpLaunchFromCLI(cliOptions),
      cdpEndpoint: cliOptions.cdpEndpoint,
      cdpHeaders: parseCdpHeaders(cliOptions.cdpHeader),
      cdpTimeout: cliOptions.cdpTimeout,
    },
    server: {
      port: cliOptions.port,
      host: cliOptions.host,
      authToken: cliOptions.authToken,
    },
    capabilities: cliOptions.caps as ToolCapability[],
    allowedTools: cliOptions.allowedTools,
    blockedTools: cliOptions.blockedTools,
    redactUrlParams: cliOptions.redactUrlParams,
    network: {
      allowedOrigins: cliOptions.allowedOrigins,
      blockedOrigins: cliOptions.blockedOrigins,
    },
    tabGroup: cliOptions.tabGroup === false ? false : undefined,
    saveSession: cliOptions.saveSession,
    saveTrace: cliOptions.saveTrace,
    snapshot: cliOptions.snapshotBoxes !== undefined ? { boxes: cliOptions.snapshotBoxes } : undefined,
    outputDir: cliOptions.outputDir,
    filePaths: cliOptions.filePaths as Config['filePaths'],
    imageResponses: cliOptions.imageResponses,
    timeouts: {
      navigationTimeout: cliOptions.navigationTimeout,
      defaultTimeout: cliOptions.defaultTimeout,
      settle: cliOptions.timeoutSettle,
      idle: cliOptions.timeoutIdle,
    }
  };
}

function cliOptionsFromEnv(): CLIOptions {
  const options: CLIOptions = {};
  options.allowedOrigins = semicolonSeparatedList(process.env.PLAYWRIGHT_MCP_ALLOWED_ORIGINS);
  options.allowedUploadDirs = uploadDirectoryList(process.env.PLAYWRIGHT_MCP_ALLOWED_UPLOAD_DIRS);
  options.authToken = process.env.PLAYWRIGHT_MCP_AUTH_TOKEN;
  options.blockedOrigins = semicolonSeparatedList(process.env.PLAYWRIGHT_MCP_BLOCKED_ORIGINS);
  options.blockServiceWorkers = envToBoolean(process.env.PLAYWRIGHT_MCP_BLOCK_SERVICE_WORKERS);
  options.browser = envToString(process.env.PLAYWRIGHT_MCP_BROWSER);
  options.caps = commaSeparatedList(process.env.PLAYWRIGHT_MCP_CAPS);
  options.allowedTools = toolNameList(process.env.PLAYWRIGHT_MCP_ALLOWED_TOOLS);
  options.blockedTools = toolNameList(process.env.PLAYWRIGHT_MCP_BLOCKED_TOOLS);
  options.redactUrlParams = toolNameList(process.env.PLAYWRIGHT_MCP_REDACT_URL_PARAMS);
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
  const imageResponses = process.env.PLAYWRIGHT_MCP_IMAGE_RESPONSES;
  if (imageResponses === 'allow' || imageResponses === 'omit' || imageResponses === 'auto' || imageResponses === 'only')
    options.imageResponses = imageResponses;
  options.mobile = envToBoolean(process.env.PLAYWRIGHT_MCP_MOBILE);
  options.sandbox = envToBoolean(process.env.PLAYWRIGHT_MCP_SANDBOX);
  options.outputDir = envToString(process.env.PLAYWRIGHT_MCP_OUTPUT_DIR);
  options.filePaths = envToString(process.env.PLAYWRIGHT_MCP_FILE_PATHS);
  options.port = envToNumber(process.env.PLAYWRIGHT_MCP_PORT);
  options.proxyBypass = envToString(process.env.PLAYWRIGHT_MCP_PROXY_BYPASS);
  options.proxyServer = envToString(process.env.PLAYWRIGHT_MCP_PROXY_SERVER);
  options.saveTrace = envToBoolean(process.env.PLAYWRIGHT_MCP_SAVE_TRACE);
  options.snapshotBoxes = envToBoolean(process.env.PLAYWRIGHT_MCP_SNAPSHOT_BOXES);
  options.storageState = envToString(process.env.PLAYWRIGHT_MCP_STORAGE_STATE);
  options.userAgent = envToString(process.env.PLAYWRIGHT_MCP_USER_AGENT);
  options.userDataDir = envToString(process.env.PLAYWRIGHT_MCP_USER_DATA_DIR);
  options.profileDirName = envToString(process.env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME) || undefined;
  options.viewportSize = envToString(process.env.PLAYWRIGHT_MCP_VIEWPORT_SIZE);
  options.navigationTimeout = envToNumber(process.env.PLAYWRIGHT_MCP_NAVIGATION_TIMEOUT);
  options.defaultTimeout = envToNumber(process.env.PLAYWRIGHT_MCP_DEFAULT_TIMEOUT);
  options.timeoutSettle = envToNumber(process.env.PLAYWRIGHT_MCP_TIMEOUT_SETTLE);
  options.timeoutIdle = envToNumber(process.env.PLAYWRIGHT_MCP_TIMEOUT_IDLE?.trim());
  return options;
}

async function loadConfig(configFile: string | undefined): Promise<Config> {
  if (!configFile)
    return {};

  try {
    const config: Config = JSON.parse(await fs.promises.readFile(configFile, 'utf8'));
    normalizeConfigPaths(config, path.dirname(path.resolve(configFile)));
    return config;
  } catch (error) {
    throw new Error(`Failed to load config file: ${configFile}, ${error}`);
  }
}

function normalizeConfigPaths(config: Config, configDir: string): void {
  const resolvePath = (value: string) => typeof value === 'string' && value.trim() && !path.isAbsolute(value) ? path.resolve(configDir, value) : value;
  if (config.outputDir !== undefined)
    config.outputDir = resolvePath(config.outputDir);
  const browser = config.browser;
  if (!browser)
    return;
  if (browser.userDataDir !== undefined)
    browser.userDataDir = resolvePath(browser.userDataDir);
  if (Array.isArray(browser.allowedUploadDirs))
    browser.allowedUploadDirs = browser.allowedUploadDirs.map(resolvePath);
  if (browser.cdpLaunch?.cwd !== undefined)
    browser.cdpLaunch.cwd = resolvePath(browser.cdpLaunch.cwd);
  const launchOptions = browser.launchOptions;
  for (const key of ['executablePath', 'downloadsPath', 'tracesDir', 'artifactsDir'] as const) {
    if (launchOptions?.[key] !== undefined)
      launchOptions[key] = resolvePath(launchOptions[key]);
  }
  const contextOptions = browser.contextOptions;
  if (typeof contextOptions?.storageState === 'string')
    contextOptions.storageState = resolvePath(contextOptions.storageState);
  if (contextOptions?.recordHar?.path !== undefined)
    contextOptions.recordHar.path = resolvePath(contextOptions.recordHar.path);
  if (contextOptions?.recordVideo?.dir !== undefined)
    contextOptions.recordVideo.dir = resolvePath(contextOptions.recordVideo.dir);
  for (const certificate of contextOptions?.clientCertificates ?? []) {
    for (const key of ['certPath', 'keyPath', 'pfxPath'] as const) {
      if (certificate[key] !== undefined)
        certificate[key] = resolvePath(certificate[key]);
    }
  }
}

const defaultOutputDirs = new WeakMap<FullConfig, string>();

export function resolveOutputDir(config: FullConfig): string {
  if (config.outputDir)
    return config.outputDir;
  let outputDir = defaultOutputDirs.get(config);
  if (!outputDir) {
    outputDir = path.join(os.tmpdir(), 'playwright-mcp-output', safeIsoTimestampForFileName());
    defaultOutputDirs.set(config, outputDir);
  }
  return outputDir;
}

const windowsReservedFileName = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i;
const endsWithDotOrSpace = /[. ]$/;

function isPortableFileName(requested: string, sanitized: string): boolean {
  return !!sanitized
    && sanitized !== '.'
    && sanitized !== '..'
    && !endsWithDotOrSpace.test(requested)
    && !endsWithDotOrSpace.test(sanitized)
    && !windowsReservedFileName.test(sanitized);
}

export async function outputFile(config: FullConfig, name: string, exclusive = false): Promise<string> {
  const fileName = name.trim() ? sanitizeForFilePath(name) : '';
  if (!isPortableFileName(name, fileName))
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

const undocumentedPlaywrightLaunchOptions = { assistantMode: true };

function mergeConfig(base: FullConfig, overrides: Config): FullConfig {
  const browser: FullConfig['browser'] = {
    ...pickDefined(base.browser),
    ...pickDefined(overrides.browser),
    browserName: overrides.browser?.browserName ?? base.browser?.browserName ?? 'chromium',
    isolated: overrides.browser?.isolated ?? base.browser?.isolated ?? false,
    launchOptions: {
      ...pickDefined(base.browser?.launchOptions),
      ...pickDefined(overrides.browser?.launchOptions),
      ...undocumentedPlaywrightLaunchOptions,
    },
    contextOptions: {
      ...pickDefined(base.browser?.contextOptions),
      ...pickDefined(overrides.browser?.contextOptions),
    },
  };

  if (browser.browserName !== 'chromium')
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
      idle: overrides.timeouts?.idle !== undefined ? overrides.timeouts.idle : base.timeouts.idle,
    },
  } as FullConfig;
}

export function semicolonSeparatedList(value: string | undefined): string[] | undefined {
  if (!value)
    return undefined;
  return value.split(';').map(v => v.trim());
}

export function uploadDirectoryList(value: string | undefined): string[] | undefined {
  if (value === undefined)
    return undefined;
  return value === '' ? [] : value.split(';').map(dir => dir.trim());
}

export function validateAuthToken(token: string | undefined): void {
  if (token !== undefined && (typeof token !== 'string' || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)))
    throw new Error('server.authToken must be a non-blank Bearer token without whitespace.');
}

export function commaSeparatedList(value: string | undefined): string[] | undefined {
  if (!value)
    return undefined;
  return value.split(',').map(v => v.trim());
}

function newlineSeparatedList(value: string | undefined): string[] | undefined {
  if (!value)
    return undefined;
  const entries = value.split('\n').map(v => v.trim()).filter(Boolean);
  return entries.length ? entries : undefined;
}

/** @public */
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
  if (!value?.trim())
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

function parseFilePaths(value: unknown): Config['filePaths'] {
  if (value === undefined || value === 'relative' || value === 'absolute')
    return value;
  throw new Error('filePaths must be "relative" or "absolute".');
}

function proxySettingsFromString(proxy: string): NonNullable<LaunchOptions['proxy']> {
  try {
    const trimmed = proxy.trim();
    const url = new URL(/^\w+:\/\//.test(trimmed) ? trimmed : 'http://' + trimmed);
    if (url.username || url.password) {
      return {
        server: url.protocol + '//' + url.host,
        username: decodeProxyCredential(url.username),
        password: decodeProxyCredential(url.password),
      };
    }
  } catch {}
  return { server: proxy };
}

function decodeProxyCredential(value: string): string {
  return value.replace(/(?:%[0-9a-fA-F]{2})+/g, escapes => {
    try {
      return decodeURIComponent(escapes);
    } catch {
      return escapes;
    }
  });
}

function envToString(value: string | undefined): string | undefined {
  return value ? value.trim() : undefined;
}
