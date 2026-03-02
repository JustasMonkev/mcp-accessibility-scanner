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

import { Option } from 'commander';
import type { Command } from 'commander';
import { commaSeparatedList, semicolonSeparatedList } from './config.js';
import { packageJSON } from './utils/package.js';

function parseMilliseconds(value: string): number {
  const milliseconds = Number.parseInt(value, 10);
  if (!Number.isFinite(milliseconds))
    throw new Error(`Invalid milliseconds value: ${value}`);
  return milliseconds;
}

export function addSharedServerOptions(target: Command): Command {
  return target
      .option('--allowed-origins <origins>', 'semicolon-separated list of origins to allow the browser to request. Default is to allow all.', semicolonSeparatedList)
      .option('--blocked-origins <origins>', 'semicolon-separated list of origins to block the browser from requesting. Blocklist is evaluated before allowlist. If used without the allowlist, requests not matching the blocklist are still allowed.', semicolonSeparatedList)
      .option('--block-service-workers', 'block service workers')
      .option('--browser <browser>', 'browser or chrome channel to use, possible values: chrome, firefox, webkit, msedge.')
      .option('--caps <caps>', 'comma-separated list of additional capabilities to enable, possible values: vision, pdf.', commaSeparatedList)
      .option('--cdp-endpoint <endpoint>', 'CDP endpoint to connect to.')
      .option('--config <path>', 'path to the configuration file.')
      .option('--device <device>', 'device to emulate, for example: "iPhone 15"')
      .option('--executable-path <path>', 'path to the browser executable.')
      .option('--extension', 'Connect to a running browser instance (Edge/Chrome only). Requires the "Playwright MCP Bridge" browser extension to be installed.')
      .option('--headless', 'run browser in headless mode, headed by default')
      .option('--host <host>', 'host to bind server to. Default is localhost. Use 0.0.0.0 to bind to all interfaces.')
      .option('--ignore-https-errors', 'ignore https errors')
      .option('--isolated', 'keep the browser profile in memory, do not save it to disk.')
      .option('--image-responses <mode>', 'whether to send image responses to the client. Can be "allow" or "omit", Defaults to "allow".')
      .option('--no-sandbox', 'disable the sandbox for all process types that are normally sandboxed.')
      .option('--output-dir <path>', 'path to the directory for output files.')
      .option('--port <port>', 'port to listen on for SSE transport.')
      .option('--proxy-bypass <bypass>', 'comma-separated domains to bypass proxy, for example ".com,chromium.org,.domain.com"')
      .option('--proxy-server <proxy>', 'specify proxy server, for example "http://myproxy:3128" or "socks5://myproxy:8080"')
      .option('--save-session', 'Whether to save the Playwright MCP session into the output directory.')
      .option('--save-trace', 'Whether to save the Playwright Trace of the session into the output directory.')
      .option('--storage-state <path>', 'path to the storage state file for isolated sessions.')
      .option('--user-agent <ua string>', 'specify user agent string')
      .option('--user-data-dir <path>', 'path to the user data directory. If not specified, a temporary directory will be created.')
      .option('--viewport-size <size>', 'specify browser viewport size in pixels, for example "1280, 720"')
      .option('--navigation-timeout <ms>', 'maximum time in milliseconds for page navigation. Defaults to 60000ms (60 seconds).', parseMilliseconds)
      .option('--default-timeout <ms>', 'default timeout for all Playwright operations (clicks, fills, etc). Defaults to 5000ms (5 seconds).', parseMilliseconds)
      .addOption(new Option('--vscode', 'VS Code tools.').hideHelp())
      .addOption(new Option('--vision', 'Legacy option, use --caps=vision instead').hideHelp());
}

export function configureProgramOptions(target: Command): Command {
  return addSharedServerOptions(target)
      .version('Version ' + packageJSON.version)
      .name(packageJSON.name);
}
