import { z } from "zod";
import { scanViolations } from "./accessibilityChecker";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Create an MCP server instance
const server = new McpServer({
    name: "AccessibilityTools",
    version: "1.0.0",
});

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
                .min(1) // Ensure the array is not empty
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

export default server;