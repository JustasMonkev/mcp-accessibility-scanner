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

import type { Server } from '@modelcontextprotocol/server';
import type { Config } from './config.js';
import type { BrowserContext } from 'playwright';

/**
 * @deprecated `createConnection` has never returned this shape. It resolves to
 * the MCP `Server` itself; the wrapper is kept only so an existing import of
 * the name still compiles. Use `Server` directly.
 */
export type Connection = Server;

/**
 * Creates an MCP server for this package.
 *
 * Returns the `Server` — connect it to a transport with `server.connect(...)`
 * and close it with `server.close()`. This declaration previously promised a
 * `{ server, close() }` wrapper that `src/index.ts` never produced, so a
 * TypeScript consumer reading `connection.server` compiled cleanly and got
 * `undefined` at runtime.
 */
export declare function createConnection(config?: Config, contextGetter?: () => Promise<BrowserContext>): Promise<Server>;
export {};
