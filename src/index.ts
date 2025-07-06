import { z } from "zod";
import { scanViolations, AccessibilityScanner } from "./accessibilityChecker";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Create an MCP server instance
const server = new McpServer({
    name: "AccessibilityTools",
    version: "1.0.0",
});

class SessionManager {
    private sessions = new Map<string, AccessibilityScanner>();
    private sessionTimeouts = new Map<string, NodeJS.Timeout>();
    private readonly SESSION_TIMEOUT = 3 * 60 * 1000; // 3 minutes

    async createSession(sessionId: string, viewport?: { width: number; height: number }, shouldRunInHeadless = true): Promise<AccessibilityScanner> {
        if (this.sessions.has(sessionId)) {
            throw new Error(`Session ${sessionId} already exists`);
        }

        const scanner = new AccessibilityScanner();
        await scanner.initialize(shouldRunInHeadless);
        await scanner.createContext(viewport);
        await scanner.createPage();

        this.sessions.set(sessionId, scanner);
        this.resetSessionTimeout(sessionId);

        return scanner;
    }

    getSession(sessionId: string): AccessibilityScanner | undefined {
        const session = this.sessions.get(sessionId);
        if (session) {
            this.resetSessionTimeout(sessionId);
        }
        return session;
    }

    async closeSession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            await session.cleanup();
            this.sessions.delete(sessionId);

            const timeout = this.sessionTimeouts.get(sessionId);
            if (timeout) {
                clearTimeout(timeout);
                this.sessionTimeouts.delete(sessionId);
            }
        }
    }

    listSessions(): string[] {
        return Array.from(this.sessions.keys());
    }

    private resetSessionTimeout(sessionId: string): void {
        const existingTimeout = this.sessionTimeouts.get(sessionId);
        if (existingTimeout) {
            clearTimeout(existingTimeout);
        }

        const timeout = setTimeout(() => {
            this.closeSession(sessionId);
        }, this.SESSION_TIMEOUT);

        this.sessionTimeouts.set(sessionId, timeout);
    }
}

const sessionManager = new SessionManager();

const tagValues = [
    "wcag2a", "wcag2aa", "wcag2aaa", "wcag21a", "wcag21aa", "wcag21aaa",
    "wcag22a", "wcag22aa", "wcag22aaa", "section508", "cat.aria", "cat.color",
    "cat.forms", "cat.keyboard", "cat.language", "cat.name-role-value",
    "cat.parsing", "cat.semantics", "cat.sensory-and-visual-cues",
    "cat.structure", "cat.tables", "cat.text-alternatives", "cat.time-and-media",
] as const;

server.registerTool(
    "accessibility-scan",
    {
        title: "Accessibility Scan",
        description: "Runs an accessibility scan on a URL and returns a JSON report and a screenshot.",
        inputSchema: z.object({
            url: z.string().url().describe("The public URL to scan for accessibility violations"),
            violationsTag: z
                .array(z.enum(tagValues))
                .min(1)
                .describe("An array of tags for violation types to check"),
            viewport: z
                .object({
                    width: z.number().default(1920),
                    height: z.number().default(1080),
                })
                .optional()
                .describe("Optional viewport dimensions for the scan"),
            shouldRunInHeadless: z.boolean().default(true).describe("Whether to run the browser in headless mode"),
        }).shape,
    },
    async (args) => {
        const { url, violationsTag, viewport, shouldRunInHeadless } = args as {
            url: string;
            violationsTag: string[];
            viewport?: { width: number; height: number };
            shouldRunInHeadless: boolean;
        };

        const { report, base64Screenshot } = await scanViolations(
            url,
            violationsTag,
            viewport,
            shouldRunInHeadless,
        );

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{
							message: "The image has been saved to your downloads.",
							...report,
						},
						null,
						2,
					),
				},
				{
					type: "image",
					data: base64Screenshot,
					mimeType: "image/png",
				},
			],
			isError: false,
		};
    },
);

server.registerTool(
    "click-element",
    {
        title: "Click Element",
        description: "Clicks on an element specified by a CSS selector on the current page.",
        inputSchema: z.object({
            url: z.string().url().describe("The public URL to navigate to"),
            selector: z.string().describe("CSS selector for the element to click"),
            viewport: z
                .object({
                    width: z.number().default(1920),
                    height: z.number().default(1080),
                })
                .optional()
                .describe("Optional viewport dimensions"),
            shouldRunInHeadless: z.boolean().default(true).describe("Whether to run the browser in headless mode"),
        }).shape,
    },
    async (args) => {
        const { url, selector, viewport, shouldRunInHeadless } = args as {
            url: string;
            selector: string;
            viewport?: { width: number; height: number };
            shouldRunInHeadless: boolean;
        };

        const scanner = new AccessibilityScanner();

        try {
            await scanner.initialize(shouldRunInHeadless);
            await scanner.createContext(viewport);
            await scanner.createPage();
            await scanner.navigateToUrl(url);
            await scanner.clickElement(selector);

            const base64Screenshot = await scanner.takeScreenshot();

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Successfully clicked element: ${selector}`,
                                url,
                                selector,
                            },
                            null,
                            2,
                        ),
                    },
                    {
                        type: "image",
                        data: base64Screenshot,
                        mimeType: "image/png",
                    },
                ],
                isError: false,
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Failed to click element: ${selector}`,
                                error: error instanceof Error ? error.message : "Unknown error",
                                url,
                                selector,
                            },
                            null,
                            2,
                        ),
                    },
                ],
                isError: true,
            };
        } finally {
            await scanner.cleanup();
        }
    },
);

server.registerTool(
    "type-text",
    {
        title: "Type Text",
        description: "Types text into an input field specified by a CSS selector.",
        inputSchema: z.object({
            url: z.string().url().describe("The public URL to navigate to"),
            selector: z.string().describe("CSS selector for the input field"),
            text: z.string().describe("Text to type into the input field"),
            viewport: z
                .object({
                    width: z.number().default(1920),
                    height: z.number().default(1080),
                })
                .optional()
                .describe("Optional viewport dimensions"),
            shouldRunInHeadless: z.boolean().default(true).describe("Whether to run the browser in headless mode"),
        }).shape,
    },
    async (args) => {
        const { url, selector, text, viewport, shouldRunInHeadless } = args as {
            url: string;
            selector: string;
            text: string;
            viewport?: { width: number; height: number };
            shouldRunInHeadless: boolean;
        };

        const scanner = new AccessibilityScanner();

        try {
            await scanner.initialize(shouldRunInHeadless);
            await scanner.createContext(viewport);
            await scanner.createPage();
            await scanner.navigateToUrl(url);
            await scanner.typeText(selector, text);

            const base64Screenshot = await scanner.takeScreenshot();

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Successfully typed text into element: ${selector}`,
                                url,
                                selector,
                                text,
                            },
                            null,
                            2,
                        ),
                    },
                    {
                        type: "image",
                        data: base64Screenshot,
                        mimeType: "image/png",
                    },
                ],
                isError: false,
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Failed to type text into element: ${selector}`,
                                error: error instanceof Error ? error.message : "Unknown error",
                                url,
                                selector,
                                text,
                            },
                            null,
                            2,
                        ),
                    },
                ],
                isError: true,
            };
        } finally {
            await scanner.cleanup();
        }
    },
);

server.registerTool(
    "create-session",
    {
        title: "Create Browser Session",
        description: "Creates a new persistent browser session that can be used for multiple operations.",
        inputSchema: z.object({
            sessionId: z.string().describe("Unique identifier for the session"),
            viewport: z
                .object({
                    width: z.number().default(1920),
                    height: z.number().default(1080),
                })
                .optional()
                .describe("Optional viewport dimensions"),
            shouldRunInHeadless: z.boolean().default(true).describe("Whether to run the browser in headless mode"),
        }).shape,
    },
    async (args) => {
        const { sessionId, viewport, shouldRunInHeadless } = args as {
            sessionId: string;
            viewport?: { width: number; height: number };
            shouldRunInHeadless: boolean;
        };

        try {
            await sessionManager.createSession(sessionId, viewport, shouldRunInHeadless);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Session ${sessionId} created successfully`,
                                sessionId,
                                viewport: viewport || { width: 1920, height: 1080 },
                                headless: shouldRunInHeadless,
                            },
                            null,
                            2,
                        ),
                    },
                ],
                isError: false,
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Failed to create session: ${sessionId}`,
                                error: error instanceof Error ? error.message : "Unknown error",
                                sessionId,
                            },
                            null,
                            2,
                        ),
                    },
                ],
                isError: true,
            };
        }
    },
);

server.registerTool(
    "navigate-session",
    {
        title: "Navigate Session",
        description: "Navigates to a URL in an existing browser session.",
        inputSchema: z.object({
            sessionId: z.string().describe("Session identifier"),
            url: z.string().url().describe("The URL to navigate to"),
        }).shape,
    },
    async (args) => {
        const { sessionId, url } = args as {
            sessionId: string;
            url: string;
        };

        try {
            const session = sessionManager.getSession(sessionId);
            if (!session) {
                throw new Error(`Session ${sessionId} not found`);
            }

            await session.navigateToUrl(url);
            const base64Screenshot = await session.takeScreenshot();

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Successfully navigated to ${url}`,
                                sessionId,
                                url,
                            },
                            null,
                            2,
                        ),
                    },
                    {
                        type: "image",
                        data: base64Screenshot,
                        mimeType: "image/png",
                    },
                ],
                isError: false,
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Failed to navigate in session: ${sessionId}`,
                                error: error instanceof Error ? error.message : "Unknown error",
                                sessionId,
                                url,
                            },
                            null,
                            2,
                        ),
                    },
                ],
                isError: true,
            };
        }
    },
);

server.registerTool(
    "click-session",
    {
        title: "Click Element in Session",
        description: "Clicks on an element in an existing browser session.",
        inputSchema: z.object({
            sessionId: z.string().describe("Session identifier"),
            selector: z.string().describe("CSS selector for the element to click"),
        }).shape,
    },
    async (args) => {
        const { sessionId, selector } = args as {
            sessionId: string;
            selector: string;
        };

        try {
            const session = sessionManager.getSession(sessionId);
            if (!session) {
                throw new Error(`Session ${sessionId} not found`);
            }

            await session.clickElement(selector);
            const base64Screenshot = await session.takeScreenshot();

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Successfully clicked element: ${selector}`,
                                sessionId,
                                selector,
                            },
                            null,
                            2,
                        ),
                    },
                    {
                        type: "image",
                        data: base64Screenshot,
                        mimeType: "image/png",
                    },
                ],
                isError: false,
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Failed to click element in session: ${sessionId}`,
                                error: error instanceof Error ? error.message : "Unknown error",
                                sessionId,
                                selector,
                            },
                            null,
                            2,
                        ),
                    },
                ],
                isError: true,
            };
        }
    },
);

server.registerTool(
    "type-session",
    {
        title: "Type Text in Session",
        description: "Types text into an input field in an existing browser session.",
        inputSchema: z.object({
            sessionId: z.string().describe("Session identifier"),
            selector: z.string().describe("CSS selector for the input field"),
            text: z.string().describe("Text to type into the input field"),
        }).shape,
    },
    async (args) => {
        const { sessionId, selector, text } = args as {
            sessionId: string;
            selector: string;
            text: string;
        };

        try {
            const session = sessionManager.getSession(sessionId);
            if (!session) {
                throw new Error(`Session ${sessionId} not found`);
            }

            await session.typeText(selector, text);
            const base64Screenshot = await session.takeScreenshot();

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Successfully typed text into element: ${selector}`,
                                sessionId,
                                selector,
                                text,
                            },
                            null,
                            2,
                        ),
                    },
                    {
                        type: "image",
                        data: base64Screenshot,
                        mimeType: "image/png",
                    },
                ],
                isError: false,
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Failed to type text in session: ${sessionId}`,
                                error: error instanceof Error ? error.message : "Unknown error",
                                sessionId,
                                selector,
                                text,
                            },
                            null,
                            2,
                        ),
                    },
                ],
                isError: true,
            };
        }
    },
);

server.registerTool(
    "scan-session",
    {
        title: "Scan Session for Accessibility",
        description: "Runs an accessibility scan on the current page in an existing browser session.",
        inputSchema: z.object({
            sessionId: z.string().describe("Session identifier"),
            violationsTag: z
                .array(z.enum(tagValues))
                .min(1)
                .describe("An array of tags for violation types to check"),
        }).shape,
    },
    async (args) => {
        const { sessionId, violationsTag } = args as {
            sessionId: string;
            violationsTag: string[];
        };

        try {
            const session = sessionManager.getSession(sessionId);
            if (!session) {
                throw new Error(`Session ${sessionId} not found`);
            }

            const { report, base64Screenshot } = await session.scanViolations(violationsTag);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: "Accessibility scan completed",
                                sessionId,
                                report,
                            },
                            null,
                            2,
                        ),
                    },
                    {
                        type: "image",
                        data: base64Screenshot,
                        mimeType: "image/png",
                    },
                ],
                isError: false,
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Failed to scan session: ${sessionId}`,
                                error: error instanceof Error ? error.message : "Unknown error",
                                sessionId,
                            },
                            null,
                            2,
                        ),
                    },
                ],
                isError: true,
            };
        }
    },
);

server.registerTool(
    "close-session",
    {
        title: "Close Browser Session",
        description: "Closes an existing browser session.",
        inputSchema: z.object({
            sessionId: z.string().describe("Session identifier"),
        }).shape,
    },
    async (args) => {
        const { sessionId } = args as {
            sessionId: string;
        };

        try {
            await sessionManager.closeSession(sessionId);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Session ${sessionId} closed successfully`,
                                sessionId,
                            },
                            null,
                            2,
                        ),
                    },
                ],
                isError: false,
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Failed to close session: ${sessionId}`,
                                error: error instanceof Error ? error.message : "Unknown error",
                                sessionId,
                            },
                            null,
                            2,
                        ),
                    },
                ],
                isError: true,
            };
        }
    },
);

server.registerTool(
    "list-sessions",
    {
        title: "List Browser Sessions",
        description: "Lists all active browser sessions.",
        inputSchema: z.object({}).shape,
    },
    async () => {
        try {
            const sessions = sessionManager.listSessions();

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: "Active browser sessions",
                                sessions,
                                count: sessions.length,
                            },
                            null,
                            2,
                        ),
                    },
                ],
                isError: false,
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: "Failed to list sessions",
                                error: error instanceof Error ? error.message : "Unknown error",
                            },
                            null,
                            2,
                        ),
                    },
                ],
                isError: true,
            };
        }
    },
);

server.registerTool(
    "click-element-by-text",
    {
        title: "Click Element by Text",
        description: "Clicks on an element by its visible text content. More reliable than CSS selectors for dynamic content.",
        inputSchema: z.object({
            url: z.string().url().describe("The public URL to navigate to"),
            text: z.string().describe("The visible text of the element to click"),
            elementType: z.string().optional().describe("Optional element type (e.g., 'button', 'a', 'div')"),
            viewport: z
                .object({
                    width: z.number().default(1920),
                    height: z.number().default(1080),
                })
                .optional()
                .describe("Optional viewport dimensions"),
            shouldRunInHeadless: z.boolean().default(true).describe("Whether to run the browser in headless mode"),
        }).shape,
    },
    async (args) => {
        const { url, text, elementType, viewport, shouldRunInHeadless } = args as {
            url: string;
            text: string;
            elementType?: string;
            viewport?: { width: number; height: number };
            shouldRunInHeadless: boolean;
        };

        const scanner = new AccessibilityScanner();

        try {
            await scanner.initialize(shouldRunInHeadless);
            await scanner.createContext(viewport);
            await scanner.createPage();
            await scanner.navigateToUrl(url);
            await scanner.clickElementByText(text, elementType);

            const base64Screenshot = await scanner.takeScreenshot();

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Successfully clicked element with text: "${text}"`,
                                url,
                                text,
                                elementType,
                            },
                            null,
                            2,
                        ),
                    },
                    {
                        type: "image",
                        data: base64Screenshot,
                        mimeType: "image/png",
                    },
                ],
                isError: false,
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Failed to click element with text: "${text}"`,
                                error: error instanceof Error ? error.message : "Unknown error",
                                url,
                                text,
                            },
                            null,
                            2,
                        ),
                    },
                ],
                isError: true,
            };
        } finally {
            await scanner.cleanup();
        }
    },
);

server.registerTool(
    "type-text-by-label",
    {
        title: "Type Text by Label",
        description: "Types text into an input field identified by its label text. More intuitive than CSS selectors.",
        inputSchema: z.object({
            url: z.string().url().describe("The public URL to navigate to"),
            labelText: z.string().describe("The label text of the input field"),
            text: z.string().describe("Text to type into the input field"),
            viewport: z
                .object({
                    width: z.number().default(1920),
                    height: z.number().default(1080),
                })
                .optional()
                .describe("Optional viewport dimensions"),
            shouldRunInHeadless: z.boolean().default(true).describe("Whether to run the browser in headless mode"),
        }).shape,
    },
    async (args) => {
        const { url, labelText, text, viewport, shouldRunInHeadless } = args as {
            url: string;
            labelText: string;
            text: string;
            viewport?: { width: number; height: number };
            shouldRunInHeadless: boolean;
        };

        const scanner = new AccessibilityScanner();

        try {
            await scanner.initialize(shouldRunInHeadless);
            await scanner.createContext(viewport);
            await scanner.createPage();
            await scanner.navigateToUrl(url);
            await scanner.typeTextByLabel(labelText, text);

            const base64Screenshot = await scanner.takeScreenshot();

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Successfully typed text into field with label: "${labelText}"`,
                                url,
                                labelText,
                                text,
                            },
                            null,
                            2,
                        ),
                    },
                    {
                        type: "image",
                        data: base64Screenshot,
                        mimeType: "image/png",
                    },
                ],
                isError: false,
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Failed to type text into field with label: "${labelText}"`,
                                error: error instanceof Error ? error.message : "Unknown error",
                                url,
                                labelText,
                                text,
                            },
                            null,
                            2,
                        ),
                    },
                ],
                isError: true,
            };
        } finally {
            await scanner.cleanup();
        }
    },
);

server.registerTool(
    "analyze-page",
    {
        title: "Analyze Page",
        description: "Analyzes the current page and returns all interactive elements (buttons, links, inputs) to prevent guessing.",
        inputSchema: z.object({
            url: z.string().url().describe("The public URL to analyze"),
            viewport: z
                .object({
                    width: z.number().default(1920),
                    height: z.number().default(1080),
                })
                .optional()
                .describe("Optional viewport dimensions"),
            shouldRunInHeadless: z.boolean().default(true).describe("Whether to run the browser in headless mode"),
        }).shape,
    },
    async (args) => {
        const { url, viewport, shouldRunInHeadless } = args as {
            url: string;
            viewport?: { width: number; height: number };
            shouldRunInHeadless: boolean;
        };

        const scanner = new AccessibilityScanner();

        try {
            await scanner.initialize(shouldRunInHeadless);
            await scanner.createContext(viewport);
            await scanner.createPage();
            await scanner.navigateToUrl(url);
            
            const analysis = await scanner.analyzePage();
            const base64Screenshot = await scanner.takeScreenshot();

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: "Page analysis completed",
                                url,
                                elements: {
                                    buttons: analysis.buttons,
                                    links: analysis.links,
                                    inputs: analysis.inputs,
                                    totals: {
                                        buttons: analysis.buttons.length,
                                        links: analysis.links.length,
                                        inputs: analysis.inputs.length,
                                    },
                                },
                            },
                            null,
                            2,
                        ),
                    },
                    {
                        type: "image",
                        data: base64Screenshot,
                        mimeType: "image/png",
                    },
                ],
                isError: false,
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: "Failed to analyze page",
                                error: error instanceof Error ? error.message : "Unknown error",
                                url,
                            },
                            null,
                            2,
                        ),
                    },
                ],
                isError: true,
            };
        } finally {
            await scanner.cleanup();
        }
    },
);

server.registerTool(
    "click-session-by-text",
    {
        title: "Click Element by Text in Session",
        description: "Clicks on an element by its visible text in an existing browser session.",
        inputSchema: z.object({
            sessionId: z.string().describe("Session identifier"),
            text: z.string().describe("The visible text of the element to click"),
            elementType: z.string().optional().describe("Optional element type (e.g., 'button', 'a', 'div')"),
        }).shape,
    },
    async (args) => {
        const { sessionId, text, elementType } = args as {
            sessionId: string;
            text: string;
            elementType?: string;
        };

        try {
            const session = sessionManager.getSession(sessionId);
            if (!session) {
                throw new Error(`Session ${sessionId} not found`);
            }

            await session.clickElementByText(text, elementType);
            const base64Screenshot = await session.takeScreenshot();

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Successfully clicked element with text: "${text}"`,
                                sessionId,
                                text,
                                elementType,
                            },
                            null,
                            2,
                        ),
                    },
                    {
                        type: "image",
                        data: base64Screenshot,
                        mimeType: "image/png",
                    },
                ],
                isError: false,
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Failed to click element with text in session: ${sessionId}`,
                                error: error instanceof Error ? error.message : "Unknown error",
                                sessionId,
                                text,
                            },
                            null,
                            2,
                        ),
                    },
                ],
                isError: true,
            };
        }
    },
);

server.registerTool(
    "type-session-by-label",
    {
        title: "Type Text by Label in Session",
        description: "Types text into an input field identified by its label in an existing browser session.",
        inputSchema: z.object({
            sessionId: z.string().describe("Session identifier"),
            labelText: z.string().describe("The label text of the input field"),
            text: z.string().describe("Text to type into the input field"),
        }).shape,
    },
    async (args) => {
        const { sessionId, labelText, text } = args as {
            sessionId: string;
            labelText: string;
            text: string;
        };

        try {
            const session = sessionManager.getSession(sessionId);
            if (!session) {
                throw new Error(`Session ${sessionId} not found`);
            }

            await session.typeTextByLabel(labelText, text);
            const base64Screenshot = await session.takeScreenshot();

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Successfully typed text into field with label: "${labelText}"`,
                                sessionId,
                                labelText,
                                text,
                            },
                            null,
                            2,
                        ),
                    },
                    {
                        type: "image",
                        data: base64Screenshot,
                        mimeType: "image/png",
                    },
                ],
                isError: false,
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Failed to type text by label in session: ${sessionId}`,
                                error: error instanceof Error ? error.message : "Unknown error",
                                sessionId,
                                labelText,
                                text,
                            },
                            null,
                            2,
                        ),
                    },
                ],
                isError: true,
            };
        }
    },
);

server.registerTool(
    "analyze-session",
    {
        title: "Analyze Page in Session",
        description: "Analyzes the current page in an existing browser session.",
        inputSchema: z.object({
            sessionId: z.string().describe("Session identifier"),
        }).shape,
    },
    async (args) => {
        const { sessionId } = args as {
            sessionId: string;
        };

        try {
            const session = sessionManager.getSession(sessionId);
            if (!session) {
                throw new Error(`Session ${sessionId} not found`);
            }

            const analysis = await session.analyzePage();
            const base64Screenshot = await session.takeScreenshot();

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: "Page analysis completed",
                                sessionId,
                                elements: {
                                    buttons: analysis.buttons,
                                    links: analysis.links,
                                    inputs: analysis.inputs,
                                    totals: {
                                        buttons: analysis.buttons.length,
                                        links: analysis.links.length,
                                        inputs: analysis.inputs.length,
                                    },
                                },
                            },
                            null,
                            2,
                        ),
                    },
                    {
                        type: "image",
                        data: base64Screenshot,
                        mimeType: "image/png",
                    },
                ],
                isError: false,
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                message: `Failed to analyze page in session: ${sessionId}`,
                                error: error instanceof Error ? error.message : "Unknown error",
                                sessionId,
                            },
                            null,
                            2,
                        ),
                    },
                ],
                isError: true,
            };
        }
    },
);

export default server;
