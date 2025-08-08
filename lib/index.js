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
import { createConnection as createConnectionImpl } from './connection.js';
import { resolveConfig } from './config.js';
import { contextFactory } from './browserContextFactory.js';
export async function createConnection(userConfig = {}, contextGetter) {
    const config = await resolveConfig(userConfig);
    const factory = contextGetter ? new SimpleBrowserContextFactory(contextGetter) : contextFactory(config.browser);
    return createConnectionImpl(config, factory);
}
class SimpleBrowserContextFactory {
    _contextGetter;
    constructor(contextGetter) {
        this._contextGetter = contextGetter;
    }
    async createContext() {
        const browserContext = await this._contextGetter();
        return {
            browserContext,
            close: () => browserContext.close()
        };
    }
}
//# sourceMappingURL=index.js.map