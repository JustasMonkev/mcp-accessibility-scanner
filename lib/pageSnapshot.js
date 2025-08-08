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
import { callOnPageNoTrace } from './tools/utils.js';
export class PageSnapshot {
    _page;
    _text;
    constructor(page) {
        this._page = page;
    }
    static async create(page) {
        const snapshot = new PageSnapshot(page);
        await snapshot._build();
        return snapshot;
    }
    text() {
        return this._text;
    }
    async _build() {
        const snapshot = await callOnPageNoTrace(this._page, page => page._snapshotForAI());
        this._text = [
            `- Page Snapshot`,
            '```yaml',
            snapshot,
            '```',
        ].join('\n');
    }
    refLocator(params) {
        return this._page.locator(`aria-ref=${params.ref}`).describe(params.element);
    }
}
//# sourceMappingURL=pageSnapshot.js.map