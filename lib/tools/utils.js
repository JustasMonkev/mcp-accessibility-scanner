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
export async function waitForCompletion(context, tab, callback) {
    const requests = new Set();
    let frameNavigated = false;
    let waitCallback = () => { };
    const waitBarrier = new Promise(f => { waitCallback = f; });
    const requestListener = (request) => requests.add(request);
    const requestFinishedListener = (request) => {
        requests.delete(request);
        if (!requests.size)
            waitCallback();
    };
    const frameNavigateListener = (frame) => {
        if (frame.parentFrame())
            return;
        frameNavigated = true;
        dispose();
        clearTimeout(timeout);
        void tab.waitForLoadState('load').then(waitCallback);
    };
    const onTimeout = () => {
        dispose();
        waitCallback();
    };
    tab.page.on('request', requestListener);
    tab.page.on('requestfinished', requestFinishedListener);
    tab.page.on('framenavigated', frameNavigateListener);
    const timeout = setTimeout(onTimeout, 10000);
    const dispose = () => {
        tab.page.off('request', requestListener);
        tab.page.off('requestfinished', requestFinishedListener);
        tab.page.off('framenavigated', frameNavigateListener);
        clearTimeout(timeout);
    };
    try {
        const result = await callback();
        if (!requests.size && !frameNavigated)
            waitCallback();
        await waitBarrier;
        await context.waitForTimeout(1000);
        return result;
    }
    finally {
        dispose();
    }
}
export function sanitizeForFilePath(s) {
    const sanitize = (s) => s.replace(/[\x00-\x2C\x2E-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/g, '-');
    const separator = s.lastIndexOf('.');
    if (separator === -1)
        return sanitize(s);
    return sanitize(s.substring(0, separator)) + '.' + sanitize(s.substring(separator + 1));
}
export async function generateLocator(locator) {
    try {
        return await locator._generateLocatorString();
    }
    catch (e) {
        if (e instanceof Error && /locator._generateLocatorString: No element matching locator/.test(e.message))
            throw new Error('Ref not found, likely because element was removed. Use browser_snapshot to see what elements are currently on the page.');
        throw e;
    }
}
export async function callOnPageNoTrace(page, callback) {
    return await page._wrapApiCall(() => callback(page), { internal: true });
}
//# sourceMappingURL=utils.js.map