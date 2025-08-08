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
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import debug from 'debug';
import * as playwright from 'playwright';
import { userDataDir } from './fileUtils.js';
const testDebug = debug('pw:mcp:test');
export function contextFactory(browserConfig) {
    if (browserConfig.remoteEndpoint)
        return new RemoteContextFactory(browserConfig);
    if (browserConfig.cdpEndpoint)
        return new CdpContextFactory(browserConfig);
    if (browserConfig.isolated)
        return new IsolatedContextFactory(browserConfig);
    if (browserConfig.browserAgent)
        return new BrowserServerContextFactory(browserConfig);
    return new PersistentContextFactory(browserConfig);
}
class BaseContextFactory {
    browserConfig;
    _browserPromise;
    name;
    constructor(name, browserConfig) {
        this.name = name;
        this.browserConfig = browserConfig;
    }
    async _obtainBrowser() {
        if (this._browserPromise)
            return this._browserPromise;
        testDebug(`obtain browser (${this.name})`);
        this._browserPromise = this._doObtainBrowser();
        void this._browserPromise.then(browser => {
            browser.on('disconnected', () => {
                this._browserPromise = undefined;
            });
        }).catch(() => {
            this._browserPromise = undefined;
        });
        return this._browserPromise;
    }
    async _doObtainBrowser() {
        throw new Error('Not implemented');
    }
    async createContext() {
        testDebug(`create browser context (${this.name})`);
        const browser = await this._obtainBrowser();
        const browserContext = await this._doCreateContext(browser);
        return { browserContext, close: () => this._closeBrowserContext(browserContext, browser) };
    }
    async _doCreateContext(browser) {
        throw new Error('Not implemented');
    }
    async _closeBrowserContext(browserContext, browser) {
        testDebug(`close browser context (${this.name})`);
        if (browser.contexts().length === 1)
            this._browserPromise = undefined;
        await browserContext.close().catch(() => { });
        if (browser.contexts().length === 0) {
            testDebug(`close browser (${this.name})`);
            await browser.close().catch(() => { });
        }
    }
}
class IsolatedContextFactory extends BaseContextFactory {
    constructor(browserConfig) {
        super('isolated', browserConfig);
    }
    async _doObtainBrowser() {
        await injectCdpPort(this.browserConfig);
        const browserType = playwright[this.browserConfig.browserName];
        return browserType.launch({
            ...this.browserConfig.launchOptions,
            handleSIGINT: false,
            handleSIGTERM: false,
        }).catch(error => {
            if (error.message.includes('Executable doesn\'t exist'))
                throw new Error(`Browser specified in your config is not installed. Either install it (likely) or change the config.`);
            throw error;
        });
    }
    async _doCreateContext(browser) {
        return browser.newContext(this.browserConfig.contextOptions);
    }
}
class CdpContextFactory extends BaseContextFactory {
    constructor(browserConfig) {
        super('cdp', browserConfig);
    }
    async _doObtainBrowser() {
        return playwright.chromium.connectOverCDP(this.browserConfig.cdpEndpoint);
    }
    async _doCreateContext(browser) {
        return this.browserConfig.isolated ? await browser.newContext() : browser.contexts()[0];
    }
}
class RemoteContextFactory extends BaseContextFactory {
    constructor(browserConfig) {
        super('remote', browserConfig);
    }
    async _doObtainBrowser() {
        const url = new URL(this.browserConfig.remoteEndpoint);
        url.searchParams.set('browser', this.browserConfig.browserName);
        if (this.browserConfig.launchOptions)
            url.searchParams.set('launch-options', JSON.stringify(this.browserConfig.launchOptions));
        return playwright[this.browserConfig.browserName].connect(String(url));
    }
    async _doCreateContext(browser) {
        return browser.newContext();
    }
}
class PersistentContextFactory {
    browserConfig;
    _userDataDirs = new Set();
    constructor(browserConfig) {
        this.browserConfig = browserConfig;
    }
    async createContext() {
        await injectCdpPort(this.browserConfig);
        testDebug('create browser context (persistent)');
        const userDataDir = this.browserConfig.userDataDir ?? await this._createUserDataDir();
        this._userDataDirs.add(userDataDir);
        testDebug('lock user data dir', userDataDir);
        const browserType = playwright[this.browserConfig.browserName];
        for (let i = 0; i < 5; i++) {
            try {
                const browserContext = await browserType.launchPersistentContext(userDataDir, {
                    ...this.browserConfig.launchOptions,
                    ...this.browserConfig.contextOptions,
                    handleSIGINT: false,
                    handleSIGTERM: false,
                });
                const close = () => this._closeBrowserContext(browserContext, userDataDir);
                return { browserContext, close };
            }
            catch (error) {
                if (error.message.includes('Executable doesn\'t exist'))
                    throw new Error(`Browser specified in your config is not installed. Either install it (likely) or change the config.`);
                if (error.message.includes('ProcessSingleton') || error.message.includes('Invalid URL')) {
                    // User data directory is already in use, try again.
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }
                throw error;
            }
        }
        throw new Error(`Browser is already in use for ${userDataDir}, use --isolated to run multiple instances of the same browser`);
    }
    async _closeBrowserContext(browserContext, userDataDir) {
        testDebug('close browser context (persistent)');
        testDebug('release user data dir', userDataDir);
        await browserContext.close().catch(() => { });
        this._userDataDirs.delete(userDataDir);
        testDebug('close browser context complete (persistent)');
    }
    async _createUserDataDir() {
        let cacheDirectory;
        if (process.platform === 'linux')
            cacheDirectory = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
        else if (process.platform === 'darwin')
            cacheDirectory = path.join(os.homedir(), 'Library', 'Caches');
        else if (process.platform === 'win32')
            cacheDirectory = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        else
            throw new Error('Unsupported platform: ' + process.platform);
        const result = path.join(cacheDirectory, 'ms-playwright', `mcp-${this.browserConfig.launchOptions?.channel ?? this.browserConfig?.browserName}-profile`);
        await fs.promises.mkdir(result, { recursive: true });
        return result;
    }
}
export class BrowserServerContextFactory extends BaseContextFactory {
    constructor(browserConfig) {
        super('persistent', browserConfig);
    }
    async _doObtainBrowser() {
        const response = await fetch(new URL(`/json/launch`, this.browserConfig.browserAgent), {
            method: 'POST',
            body: JSON.stringify({
                browserType: this.browserConfig.browserName,
                userDataDir: this.browserConfig.userDataDir ?? await this._createUserDataDir(),
                launchOptions: this.browserConfig.launchOptions,
                contextOptions: this.browserConfig.contextOptions,
            }),
        });
        const info = await response.json();
        if (info.error)
            throw new Error(info.error);
        return await playwright.chromium.connectOverCDP(`http://localhost:${info.cdpPort}/`);
    }
    async _doCreateContext(browser) {
        return this.browserConfig.isolated ? await browser.newContext() : browser.contexts()[0];
    }
    async _createUserDataDir() {
        const dir = await userDataDir(this.browserConfig);
        await fs.promises.mkdir(dir, { recursive: true });
        return dir;
    }
}
async function injectCdpPort(browserConfig) {
    if (browserConfig.browserName === 'chromium')
        browserConfig.launchOptions.cdpPort = await findFreePort();
}
async function findFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}
//# sourceMappingURL=browserContextFactory.js.map