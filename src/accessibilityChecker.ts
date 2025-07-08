import {type Browser, type BrowserContext, chromium, type Page, type Locator} from "playwright";
import {AxeBuilder} from "@axe-core/playwright";
import path from "node:path";
import os from "node:os";
import { z } from 'zod';
import { defineTool, type ToolFactory, type ToolContext } from './tool';
import * as javascript from './javascript';
import { generateLocator } from './utils';

export interface AccessibilityResult {
    index: number;
    element: string | string[];
    impactLevel: string;
    description: string;
    wcagCriteria: string;
}

export interface ScanResult {
    report: AccessibilityResult[];
    base64Screenshot: string;
}

export class AccessibilityScanner {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private page: Page | null = null;

    private readonly defaultViewport = {width: 1920, height: 1080};
    private readonly userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    async initialize(shouldRunInHeadless = true) {
        this.browser = await chromium.launch({
            headless: shouldRunInHeadless,
            args: [
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
                "--no-sandbox",
                "--disable-setuid-sandbox",
            ],
        });
    }

    async createContext(viewport = this.defaultViewport) {
        if (!this.browser) {
            throw new Error("Browser not initialized. Call initialize() first.");
        }

        this.context = await this.browser.newContext({
            viewport,
            userAgent: this.userAgent,
        });
    }

    async createPage() {
        if (!this.context) {
            throw new Error("Context not created. Call createContext() first.");
        }

        this.page = await this.context.newPage();
    }

    async navigateToUrl(url: string) {
        if (!this.page) {
            throw new Error("Page not created. Call createPage() first.");
        }

        await this.page.goto(url);
    }

    async clickElement(selector: string) {
        if (!this.page) {
            throw new Error("Page not created. Call createPage() first.");
        }

        await this.page.click(selector);

        await this.page.waitForLoadState('load')
    }

    async typeText(selector: string, text: string) {
        if (!this.page) {
            throw new Error("Page not created. Call createPage() first.");
        }

        await this.page.fill(selector, text);

        await this.page.waitForLoadState('load')
    }

    async getElementByText(text: string, elementType?: string): Promise<string | null> {
        if (!this.page) {
            throw new Error("Page not created. Call createPage() first.");
        }

        const elements = await this.page.locator(elementType || '*', { hasText: text }).all();

        if (elements.length === 0) {
            return null;
        }

        if (elements.length === 1) {
            return await elements[0].evaluate(el => {
                if (el.id) return `#${el.id}`;
                if (el.className) return `.${el.className.split(' ')[0]}`;
                return el.tagName.toLowerCase();
            });
        }

        for (let i = 0; i < elements.length; i++) {
            const element = elements[i];
            const isExactMatch = await element.evaluate((el, searchText) => {
                return el.textContent?.trim() === searchText ||
                       ('innerText' in el && (el as HTMLElement).innerText?.trim() === searchText) ||
                       (el as HTMLInputElement).value === searchText;
            }, text);

            if (isExactMatch) {
                return await element.evaluate(el => {
                    if (el.id) return `#${el.id}`;
                    if (el.className) return `.${el.className.split(' ')[0]}`;
                    return `:nth-of-type(${Array.from(el.parentElement?.children || []).indexOf(el) + 1})`;
                });
            }
        }

        return await elements[0].evaluate(el => {
            if (el.id) return `#${el.id}`;
            if (el.className) return `.${el.className.split(' ')[0]}`;
            return el.tagName.toLowerCase();
        });
    }

    async analyzePage(): Promise<{ buttons: string[], links: string[], inputs: string[] }> {
        if (!this.page) {
            throw new Error("Page not created. Call createPage() first.");
        }

        return await this.page.evaluate(() => {
            const getElementInfo = (el: Element) => {
                const text = (el.textContent || '').trim();
                const ariaLabel = el.getAttribute('aria-label');
                const title = el.getAttribute('title');
                const value = (el as HTMLInputElement).value;
                const placeholder = (el as HTMLInputElement).placeholder;

                return text || ariaLabel || title || value || placeholder || 'No text';
            };

            const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'))
                .map(el => getElementInfo(el))
                .filter(text => text !== 'No text');

            const links = Array.from(document.querySelectorAll('a[href]'))
                .map(el => getElementInfo(el))
                .filter(text => text !== 'No text');

            const inputs = Array.from(document.querySelectorAll('input:not([type="button"]):not([type="submit"]), textarea, select'))
                .map(el => {
                    const label = (el as HTMLInputElement).labels?.[0]?.textContent?.trim();
                    const placeholder = (el as HTMLInputElement).placeholder;
                    const name = el.getAttribute('name');
                    const id = el.getAttribute('id');

                    return label || placeholder || name || id || 'Unnamed input';
                });

            return {buttons, links, inputs};
        });
    }

    async clickElementByText(text: string, elementType?: string) {
        if (!this.page) {
            throw new Error("Page not created. Call createPage() first.");
        }

        const selector = await this.getElementByText(text, elementType);
        if (!selector) {
            const analysis = await this.analyzePage();
            throw new Error(`Element with text "${text}" not found. Available elements:\nButtons: ${analysis.buttons.join(', ')}\nLinks: ${analysis.links.join(', ')}`);
        }

        await this.page.click(selector);
        await this.page.waitForLoadState('load');
    }

    async typeTextByLabel(labelText: string, text: string) {
        if (!this.page) {
            throw new Error("Page not created. Call createPage() first.");
        }

        const inputSelector = await this.page.evaluate((label) => {
            const labels = Array.from(document.querySelectorAll('label'));
            const matchingLabel = labels.find(l => l.textContent?.trim().includes(label));

            if (matchingLabel) {
                const forAttr = matchingLabel.getAttribute('for');
                if (forAttr) return `#${forAttr}`;

                const input = matchingLabel.querySelector('input, textarea, select');
                if (input && input.id) return `#${input.id}`;
                if (input) return null;
            }

            const inputsWithPlaceholder = Array.from(document.querySelectorAll(`input[placeholder*="${label}"], textarea[placeholder*="${label}"]`));
            if (inputsWithPlaceholder.length > 0) {
                const input = inputsWithPlaceholder[0];
                if (input.id) return `#${input.id}`;
            }

            return null;
        }, labelText);

        if (!inputSelector) {
            const analysis = await this.analyzePage();
            throw new Error(`Input field with label "${labelText}" not found. Available inputs: ${analysis.inputs.join(', ')}`);
        }

        await this.page.fill(inputSelector, text);
        await this.page.waitForLoadState('load');
    }

    private async addViolationStyles() {
        if (!this.page) {
            throw new Error("Page not created.");
        }

        await this.page.addStyleTag({
            content: `
				.a11y-violation {
					position: relative !important;
					outline: 4px solid #FF4444 !important;
					margin: 2px !important;
				}
				.violation-number {
					position: absolute !important;
					top: -12px !important;
					left: -12px !important;
					background: #FF4444;
					color: white !important;
					width: 25px;
					height: 25px;
					border-radius: 50%;
					display: flex !important;
					align-items: center;
					justify-content: center;
					font-weight: bold;
					font-size: 14px;
					z-index: 10000;
				}
				.a11y-violation-info {
					position: absolute !important;
					background: #333333 !important;
					color: white !important;
					padding: 12px !important;
					border-radius: 4px !important;
					font-size: 14px !important;
					max-width: 300px !important;
					z-index: 9999 !important;
					box-shadow: 0 2px 10px rgba(0,0,0,0.3);
				}
			`,
        });
    }

    private async highlightViolations(violations: any[]) {
        if (!this.page) {
            throw new Error("Page not created.");
        }

        let violationCounter = 1;

        for (const violation of violations) {
            for (const node of violation.nodes) {
                try {
                    const targetSelector = node.target[0];
                    const selector = Array.isArray(targetSelector)
                        ? targetSelector.join(" ")
                        : targetSelector;

                    await this.page.evaluate(
                        ({selector, violationData, counter}) => {
                            const elements = document.querySelectorAll(selector);
                            elements.forEach((element) => {
                                const numberBadge = document.createElement("div");
                                numberBadge.className = "violation-number";
                                numberBadge.textContent = counter.toString();

                                element.classList.add("a11y-violation");
                                element.appendChild(numberBadge);

                                const listItem = document.createElement("div");
                                listItem.style.marginBottom = "15px";
                                listItem.innerHTML = `
									<div style="color: #FF4444; font-weight: bold;">
										Violation #${counter}: ${violationData.impact!.toUpperCase()}
									</div>
									<div style="margin: 5px 0; font-size: 14px;">
										${violationData.description}
									</div>
								`;

                                document.body.appendChild(listItem);
                                const rect = element.getBoundingClientRect();
                                listItem.style.left = `${rect.left + window.scrollX}px`;
                                listItem.style.top = `${rect.bottom + window.scrollY + 10}px`;
                            });
                        },
                        {
                            selector: selector,
                            violationData: {
                                impact: violation.impact,
                                description: violation.description,
                            },
                            counter: violationCounter,
                        },
                    );

                    violationCounter++;
                } catch (error) {
                    console.log(`Failed to highlight element: ${error}`);
                }
            }
        }
    }

    private generateReport(violations: any[]): AccessibilityResult[] {
        let reportCounter = 1;
        const report: AccessibilityResult[] = [];

        for (const violation of violations) {
            for (const node of violation.nodes) {
                report.push({
                    index: reportCounter++,
                    element: node.target[0],
                    impactLevel: violation.impact,
                    description: violation.description,
                    wcagCriteria: violation.tags?.join(", ") || "",
                });
            }
        }

        return report;
    }

    async takeScreenshot(): Promise<string> {
        if (!this.page) {
            throw new Error("Page not created.");
        }

        const filePath = path.join(
            path.join(os.homedir(), "Downloads"),
            `a11y-report-${Date.now()}.png`,
        );

        const screenshot = await this.page.screenshot({
            path: filePath,
        });

        return screenshot.toString("base64");
    }

    async scanViolations(violationsTags: string[]): Promise<ScanResult> {
        if (!this.page) {
            throw new Error("Page not created.");
        }

        await this.addViolationStyles();

        const axe = new AxeBuilder({page: this.page}).withTags(violationsTags);
        const results = await axe.analyze();

        await this.highlightViolations(results.violations);

        const report = this.generateReport(results.violations);
        const base64Screenshot = await this.takeScreenshot();

        return {report, base64Screenshot};
    }

    async cleanup() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.context = null;
            this.page = null;
        }
    }
}

export async function scanViolations(
    url: string,
    violationsTags: Array<string>,
    viewport = {width: 1920, height: 1080},
    shouldRunInHeadless = true,
): Promise<ScanResult> {
    const scanner = new AccessibilityScanner();

    try {
        await scanner.initialize(shouldRunInHeadless);
        await scanner.createContext(viewport);
        await scanner.createPage();
        await scanner.navigateToUrl(url);

        return await scanner.scanViolations(violationsTags);
    } finally {
        await scanner.cleanup();
    }
}

// Schemas defined from the user's provided code

const elementSchema = z.object({
  element: z.string().describe('Human-readable element description used to obtain permission to interact with the element'),
  ref: z.string().describe('Exact target element reference from the page snapshot'),
});

const typeSchema = elementSchema.extend({
  text: z.string().describe('Text to type into the element'),
  submit: z.boolean().optional().describe('Whether to submit entered text (press Enter after)'),
  slowly: z.boolean().optional().describe('Whether to type one character at a time. Useful for triggering key handlers in the page. By default entire text is filled in at once.'),
});

const selectOptionSchema = elementSchema.extend({
  values: z.array(z.string()).describe('Array of values to select in the dropdown. This can be a single value or multiple values.'),
});

// Tool Definitions from the user's provided code

const snapshot = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_snapshot',
    title: 'Page snapshot',
    description: 'Capture accessibility snapshot of the current page, this is better than screenshot',
    inputSchema: z.object({}),
    type: 'readOnly',
  },
  handle: async (page: Page | null) => {
    if (!page) throw new Error("Page not available for snapshot tool");
    return {
      code: [`// <internal code to capture accessibility snapshot>`],
      captureSnapshot: true,
      waitForNetwork: false,
    };
  },
});

const click = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_click',
    title: 'Click',
    description: 'Perform click on a web page',
    inputSchema: elementSchema,
    type: 'destructive',
  },
  handle: async (page: Page | null, params: z.infer<typeof elementSchema>) => {
    if (!page) throw new Error("Page not available for click tool");
    const locator = page.locator(params.ref);
    const code = [
      `// Click ${params.element}`,
      `await page.${await generateLocator(locator)}.click();`
    ];
    return {
      code,
      action: () => locator.click(),
      captureSnapshot: true,
      waitForNetwork: true,
    };
  },
});

const drag = defineTool({
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
  handle: async (page: Page | null, params: { startRef: string, startElement: string, endRef: string, endElement: string }) => {
    if (!page) throw new Error("Page not available for drag tool");
    const startLocator = page.locator(params.startRef);
    const endLocator = page.locator(params.endRef);
    const code = [
      `// Drag ${params.startElement} to ${params.endElement}`,
      `await page.${await generateLocator(startLocator)}.dragTo(page.${await generateLocator(endLocator)});`
    ];
    return {
      code,
      action: () => startLocator.dragTo(endLocator),
      captureSnapshot: true,
      waitForNetwork: true,
    };
  },
});

const hover = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_hover',
    title: 'Hover mouse',
    description: 'Hover over element on page',
    inputSchema: elementSchema,
    type: 'readOnly',
  },
  handle: async (page: Page | null, params: z.infer<typeof elementSchema>) => {
    if (!page) throw new Error("Page not available for hover tool");
    const locator = page.locator(params.ref);
    const code = [
      `// Hover over ${params.element}`,
      `await page.${await generateLocator(locator)}.hover();`
    ];
    return {
      code,
      action: () => locator.hover(),
      captureSnapshot: true,
      waitForNetwork: true,
    };
  },
});

const type = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_type',
    title: 'Type text',
    description: 'Type text into editable element',
    inputSchema: typeSchema,
    type: 'destructive',
  },
  handle: async (page: Page | null, params: z.infer<typeof typeSchema>) => {
    if (!page) throw new Error("Page not available for type tool");
    const locator = page.locator(params.ref);
    const code: string[] = [];
    const steps: (() => Promise<void>)[] = [];

    if (params.slowly) {
      code.push(`// Press "${params.text}" sequentially into "${params.element}"`);
      code.push(`await page.${await generateLocator(locator)}.pressSequentially(${javascript.quote(params.text)});`);
      steps.push(() => locator.pressSequentially(params.text));
    } else {
      code.push(`// Fill "${params.text}" into "${params.element}"`);
      code.push(`await page.${await generateLocator(locator)}.fill(${javascript.quote(params.text)});`);
      steps.push(() => locator.fill(params.text));
    }

    if (params.submit) {
      code.push(`// Submit text`);
      code.push(`await page.${await generateLocator(locator)}.press('Enter');`);
      steps.push(() => locator.press('Enter'));
    }

    return {
      code,
      action: () => steps.reduce((acc, step) => acc.then(step), Promise.resolve()),
      captureSnapshot: true,
      waitForNetwork: true,
    };
  },
});

const selectOption = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_select_option',
    title: 'Select option',
    description: 'Select an option in a dropdown',
    inputSchema: selectOptionSchema,
    type: 'destructive',
  },
  handle: async (page: Page | null, params: z.infer<typeof selectOptionSchema>) => {
    if (!page) throw new Error("Page not available for selectOption tool");
    const locator = page.locator(params.ref);
    const code = [
      `// Select options [${params.values.join(', ')}] in ${params.element}`,
      `await page.${await generateLocator(locator)}.selectOption(${javascript.formatObject(params.values)});`
    ];
    return {
      code,
      action: () => locator.selectOption(params.values).then(() => {}),
      captureSnapshot: true,
      waitForNetwork: true,
    };
  },
});

const pressKeyToolFactory: ToolFactory = captureSnapshot => defineTool({
  capability: 'core',
  schema: {
    name: 'browser_press_key',
    title: 'Press a key',
    description: 'Press a key on the keyboard',
    inputSchema: z.object({
      key: z.string().describe('Name of the key to press or a character to generate, such as `ArrowLeft` or `a`'),
    }),
    type: 'destructive',
  },
  handle: async (page: Page | null, params: { key: string }) => {
    if (!page) throw new Error("Page not available for pressKey tool");
    const code = [
      `// Press ${params.key}`,
      `await page.keyboard.press('${params.key}');`,
    ];
    const action = () => page.keyboard.press(params.key);
    return {
      code,
      action,
      captureSnapshot,
      waitForNetwork: true
    };
  },
});

const pressKey = pressKeyToolFactory(true);

const screenElementSchema = z.object({
  element: z.string().describe('Human-readable element description used to obtain permission to interact with the element'),
});

const screenshotTool = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_screen_capture',
    title: 'Take a screenshot',
    description: 'Take a screenshot of the current page',
    inputSchema: z.object({}),
    type: 'readOnly',
  },
  handle: async (page: Page | null) => {
    if (!page) throw new Error("Page not available for screenshotTool");
    const options = { type: 'jpeg' as 'jpeg', quality: 50, scale: 'css' as 'css' };
    const code = [
      `// Take a screenshot of the current page`,
      `await page.screenshot(${javascript.formatObject(options)});`,
    ];
    const action = () => page.screenshot(options).then(buffer => {
      return {
        content: [{ type: 'image' as 'image', data: buffer.toString('base64'), mimeType: 'image/jpeg' }],
      };
    });
    return {
      code,
      action,
      captureSnapshot: false,
      waitForNetwork: false
    };
  },
});

const moveMouse = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_screen_move_mouse',
    title: 'Move mouse',
    description: 'Move mouse to a given position',
    inputSchema: screenElementSchema.extend({
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
    }),
    type: 'readOnly',
  },
  handle: async (page: Page | null, params: { element: string, x: number, y: number }) => {
    if (!page) throw new Error("Page not available for moveMouse tool");
    const code = [
      `// Move mouse to (${params.x}, ${params.y})`,
      `await page.mouse.move(${params.x}, ${params.y});`,
    ];
    const action = () => page.mouse.move(params.x, params.y);
    return {
      code,
      action,
      captureSnapshot: false,
      waitForNetwork: false
    };
  },
});

const screenClick = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_screen_click',
    title: 'Click',
    description: 'Click left mouse button',
    inputSchema: screenElementSchema.extend({
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
    }),
    type: 'destructive',
  },
  handle: async (page: Page | null, params: {element: string, x: number, y: number }) => {
    if (!page) throw new Error("Page not available for screenClick tool");
    const code = [
      `// Click mouse at coordinates (${params.x}, ${params.y})`,
      `await page.mouse.move(${params.x}, ${params.y});`,
      `await page.mouse.down();`,
      `await page.mouse.up();`,
    ];
    const action = async () => {
      await page.mouse.move(params.x, params.y);
      await page.mouse.down();
      await page.mouse.up();
    };
    return {
      code,
      action,
      captureSnapshot: false,
      waitForNetwork: true,
    };
  },
});

const screenDrag = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_screen_drag',
    title: 'Drag mouse',
    description: 'Drag left mouse button',
    inputSchema: screenElementSchema.extend({
      startX: z.number().describe('Start X coordinate'),
      startY: z.number().describe('Start Y coordinate'),
      endX: z.number().describe('End X coordinate'),
      endY: z.number().describe('End Y coordinate'),
    }),
    type: 'destructive',
  },
  handle: async (page: Page | null, params: {element: string, startX: number, startY: number, endX: number, endY: number}) => {
    if (!page) throw new Error("Page not available for screenDrag tool");
    const code = [
      `// Drag mouse from (${params.startX}, ${params.startY}) to (${params.endX}, ${params.endY})`,
      `await page.mouse.move(${params.startX}, ${params.startY});`,
      `await page.mouse.down();`,
      `await page.mouse.move(${params.endX}, ${params.endY});`,
      `await page.mouse.up();`,
    ];
    const action = async () => {
      await page.mouse.move(params.startX, params.startY);
      await page.mouse.down();
      await page.mouse.move(params.endX, params.endY);
      await page.mouse.up();
    };
    return {
      code,
      action,
      captureSnapshot: false,
      waitForNetwork: true,
    };
  },
});

const screenType = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_screen_type',
    title: 'Type text',
    description: 'Type text',
    inputSchema: z.object({
      text: z.string().describe('Text to type into the element'),
      submit: z.boolean().optional().describe('Whether to submit entered text (press Enter after)'),
    }),
    type: 'destructive',
  },
  handle: async (page: Page | null, params: { text: string, submit?: boolean }) => {
    if (!page) throw new Error("Page not available for screenType tool");
    const code = [
      `// Type ${params.text}`,
      `await page.keyboard.type(${javascript.quote(params.text)});`,
    ];
    const action = async () => {
      await page.keyboard.type(params.text);
      if (params.submit)
        await page.keyboard.press('Enter');
    };
    if (params.submit) {
      code.push(`// Submit text`);
      code.push(`await page.keyboard.press('Enter');`);
    }
    return {
      code,
      action,
      captureSnapshot: false,
      waitForNetwork: true,
    };
  },
});

export default [
  snapshot,
  click,
  drag,
  hover,
  type,
  selectOption,
  pressKey,
  screenshotTool,
  moveMouse,
  screenClick,
  screenDrag,
  screenType,
];
