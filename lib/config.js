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
import fs from 'fs';
import os from 'os';
import path from 'path';
import { devices } from 'playwright';
import { sanitizeForFilePath } from './tools/utils.js';
const headlessMode = true;
const defaultConfig = {
    browser: {
        browserName: 'chromium',
        launchOptions: {
            channel: 'chrome',
            headless: headlessMode,
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
    outputDir: path.join(os.tmpdir(), 'mcp-accessibility-scanner-output', sanitizeForFilePath(new Date().toISOString())),
};
export async function resolveConfig(config) {
    return mergeConfig(defaultConfig, config);
}
export async function resolveCLIConfig(cliOptions) {
    const configInFile = await loadConfig(cliOptions.config);
    const cliOverrides = await configFromCLIOptions(cliOptions);
    const result = mergeConfig(mergeConfig(defaultConfig, configInFile), cliOverrides);
    // Derive artifact output directory from config.outputDir
    if (result.saveTrace)
        result.browser.launchOptions.tracesDir = path.join(result.outputDir, 'traces');
    return result;
}
export async function configFromCLIOptions(cliOptions) {
    let browserName;
    let channel;
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
    const launchOptions = {
        channel,
        executablePath: cliOptions.executablePath,
        headless: headlessMode
    };
    // --no-sandbox was passed, disable the sandbox
    if (!cliOptions.sandbox)
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
    // Context options
    const contextOptions = cliOptions.device ? devices[cliOptions.device] : {};
    if (cliOptions.storageState)
        contextOptions.storageState = cliOptions.storageState;
    if (cliOptions.userAgent)
        contextOptions.userAgent = cliOptions.userAgent;
    if (cliOptions.viewportSize) {
        try {
            const [width, height] = cliOptions.viewportSize.split(',').map(n => +n);
            if (isNaN(width) || isNaN(height))
                throw new Error('Invalid viewport size format: width and height must be numbers.');
            contextOptions.viewport = { width, height };
        }
        catch (e) {
            throw new Error('Invalid viewport size format: use "width,height", for example --viewport-size="800,600"');
        }
    }
    if (cliOptions.ignoreHttpsErrors)
        contextOptions.ignoreHTTPSErrors = true;
    if (cliOptions.blockServiceWorkers)
        contextOptions.serviceWorkers = 'block';
    return {
        browser: {
            browserAgent: cliOptions.browserAgent ?? process.env.PW_BROWSER_AGENT,
            browserName,
            isolated: cliOptions.isolated,
            userDataDir: cliOptions.userDataDir,
            launchOptions,
            contextOptions,
            cdpEndpoint: cliOptions.cdpEndpoint,
        },
        server: {
            port: cliOptions.port,
            host: cliOptions.host,
        },
        capabilities: cliOptions.caps?.split(',').map((c) => c.trim()),
        vision: !!cliOptions.vision,
        network: {
            allowedOrigins: cliOptions.allowedOrigins,
            blockedOrigins: cliOptions.blockedOrigins,
        },
        saveTrace: cliOptions.saveTrace,
        outputDir: cliOptions.outputDir,
        imageResponses: cliOptions.imageResponses,
    };
}
async function loadConfig(configFile) {
    if (!configFile)
        return {};
    try {
        return JSON.parse(await fs.promises.readFile(configFile, 'utf8'));
    }
    catch (error) {
        throw new Error(`Failed to load config file: ${configFile}, ${error}`);
    }
}
export async function outputFile(config, name) {
    await fs.promises.mkdir(config.outputDir, { recursive: true });
    const fileName = sanitizeForFilePath(name);
    return path.join(config.outputDir, fileName);
}
function pickDefined(obj) {
    return Object.fromEntries(Object.entries(obj ?? {}).filter(([_, v]) => v !== undefined));
}
function mergeConfig(base, overrides) {
    const browser = {
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
    };
}
//# sourceMappingURL=config.js.map