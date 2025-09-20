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

import {z} from 'zod';
import {defineTabTool, defineTool} from './tool.js';
import * as javascript from '../utils/codegen.js';
import {generateLocator} from './utils.js';
import AxeBuilder from "@axe-core/playwright";


const tagValues = [
    'wcag2a', 'wcag2aa', 'wcag2aaa', 'wcag21a', 'wcag21aa', 'wcag21aaa',
    'wcag22a', 'wcag22aa', 'wcag22aaa', 'section508', 'cat.aria', 'cat.color',
    'cat.forms', 'cat.keyboard', 'cat.language', 'cat.name-role-value',
    'cat.parsing', 'cat.semantics', 'cat.sensory-and-visual-cues',
    'cat.structure', 'cat.tables', 'cat.text-alternatives', 'cat.time-and-media',
] as const;


const scanPageSchema = z.object({
    violationsTag: z
        .array(z.enum(tagValues))
        .min(1)
        .default([...tagValues])
        .describe('Array of tags to filter violations by. If not specified, all violations are returned.')
});

type AxeScanResult = Awaited<ReturnType<InstanceType<typeof AxeBuilder>['analyze']>>;
type AxeViolation = AxeScanResult['violations'][number];
type AxeNode = AxeViolation['nodes'][number];

const dedupeViolationNodes = (nodes: AxeNode[]): AxeNode[] => {
    const seen = new Set<string>();
    return nodes.filter((node) => {
        const key = JSON.stringify({target: node.target ?? [], html: node.html ?? ''});
        if (seen.has(key))
            return false;

        seen.add(key);
        return true;
    });
};

const scanPage = defineTool({
    capability: 'core',
    schema: {
        name: 'scan_page',
        title: 'Scan page for accessibility violations',
        description: 'Scan the current page for accessibility violations using Axe',
        inputSchema: scanPageSchema,
        type: 'destructive',
    },

    handle: async (context, params, response) => {
        const tab = context.currentTabOrDie();
        const axe = new AxeBuilder({page: tab.page}).withTags(params.violationsTag);

        const results = await axe.analyze();

        response.addResult([
            `URL: ${results.url}`,
            '',
            `Violations: ${results.violations.length}, Incomplete: ${results.incomplete.length}, Passes: ${results.passes.length}, Inapplicable: ${results.inapplicable.length}`,
        ].join('\n'));


        results.violations.forEach((violation) => {
            const uniqueNodes = dedupeViolationNodes(violation.nodes);

            response.addResult([
                '',
                `Tags : ${violation.tags}`,
                `Violations: ${JSON.stringify(uniqueNodes, null, 2)}`,
            ].join('\n'));
        });
    },
});

const snapshot = defineTool({
    capability: 'core',
    schema: {
        name: 'browser_snapshot',
        title: 'Page snapshot',
        description: 'Capture accessibility snapshot of the current page, this is better than screenshot',
        inputSchema: z.object({}),
        type: 'readOnly',
    },

    handle: async (context, params, response) => {
        await context.ensureTab();
        response.setIncludeSnapshot();
    },
});

export const elementSchema = z.object({
    element: z.string().describe('Human-readable element description used to obtain permission to interact with the element'),
    ref: z.string().describe('Exact target element reference from the page snapshot'),
});

const clickSchema = elementSchema.extend({
    doubleClick: z.boolean().optional().describe('Whether to perform a double click instead of a single click'),
    button: z.enum(['left', 'right', 'middle']).optional().describe('Button to click, defaults to left'),
});

const click = defineTabTool({
    capability: 'core',
    schema: {
        name: 'browser_click',
        title: 'Click',
        description: 'Perform click on a web page',
        inputSchema: clickSchema,
        type: 'destructive',
    },

    handle: async (tab, params, response) => {
        response.setIncludeSnapshot();

        const locator = await tab.refLocator(params);
        const button = params.button;
        const buttonAttr = button ? `{ button: '${button}' }` : '';

        if (params.doubleClick)
            response.addCode(`await page.${await generateLocator(locator)}.dblclick(${buttonAttr});`);
        else
            response.addCode(`await page.${await generateLocator(locator)}.click(${buttonAttr});`);


        await tab.waitForCompletion(async () => {
            if (params.doubleClick)
                await locator.dblclick({button});
            else
                await locator.click({button});
        });
    },
});

const drag = defineTabTool({
    capability: 'core',
    schema: {
        name: 'browser_drag',
        title: 'Drag mouse',
        description: 'Perform drag and drop between two elements',
        inputSchema: z.object({
            startElement: z.string().describe('Human-readable source element description used to obtain the permission to interact with the element'),
            startRef: z.string().describe('Exact source element reference from the page snapshot'),
            endElement: z.string().describe('Human-readable target element description used to obtain the permission to interact with the element'),
            endRef: z.string().describe('Exact target element reference from the page snapshot'),
        }),
        type: 'destructive',
    },

    handle: async (tab, params, response) => {
        response.setIncludeSnapshot();

        const [startLocator, endLocator] = await tab.refLocators([
            {ref: params.startRef, element: params.startElement},
            {ref: params.endRef, element: params.endElement},
        ]);

        await tab.waitForCompletion(async () => {
            await startLocator.dragTo(endLocator);
        });

        response.addCode(`await page.${await generateLocator(startLocator)}.dragTo(page.${await generateLocator(endLocator)});`);
    },
});

const hover = defineTabTool({
    capability: 'core',
    schema: {
        name: 'browser_hover',
        title: 'Hover mouse',
        description: 'Hover over element on page',
        inputSchema: elementSchema,
        type: 'readOnly',
    },

    handle: async (tab, params, response) => {
        response.setIncludeSnapshot();

        const locator = await tab.refLocator(params);
        response.addCode(`await page.${await generateLocator(locator)}.hover();`);

        await tab.waitForCompletion(async () => {
            await locator.hover();
        });
    },
});

const selectOptionSchema = elementSchema.extend({
    values: z.array(z.string()).describe('Array of values to select in the dropdown. This can be a single value or multiple values.'),
});

const selectOption = defineTabTool({
    capability: 'core',
    schema: {
        name: 'browser_select_option',
        title: 'Select option',
        description: 'Select an option in a dropdown',
        inputSchema: selectOptionSchema,
        type: 'destructive',
    },

    handle: async (tab, params, response) => {
        response.setIncludeSnapshot();

        const locator = await tab.refLocator(params);
        response.addCode(`await page.${await generateLocator(locator)}.selectOption(${javascript.formatObject(params.values)});`);

        await tab.waitForCompletion(async () => {
            await locator.selectOption(params.values);
        });
    },
});

export default [
    snapshot,
    click,
    drag,
    hover,
    selectOption,
    scanPage
];
