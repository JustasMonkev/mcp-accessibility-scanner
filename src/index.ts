import { z } from "zod";
import { scanViolations, executeClick, executeType } from "./accessibilityChecker";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";


const server = new McpServer({
    name: "Accessibility Information",
    version: "1.0.0"
});

server.tool(
    "scan_accessibility",
    {
        url: z.string().url(),
        violationsTag: z.array(z.string()),
        viewport: z.object({
            width: z.number().default(1920),
            height: z.number().default(1080)
        }).optional(),
        shouldRunInHeadless: z.boolean().default(true)
    },
    async ({url, violationsTag, viewport, shouldRunInHeadless}) => {
        const {report, base64Screenshot} = await scanViolations(url, violationsTag, viewport, shouldRunInHeadless);

        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        message: 'The image has been saved to your downloads.',
                        ...report,
                    }, null, 2)
                },
                {
                    type: "image",
                    data: base64Screenshot,
                    mimeType: "image/png"
                }
            ],
            isError: false
        };
    }
);

server.tool(
    "perform_type",
    {
        url: z.string().url(),
        selector: z.string(),
        text: z.string(),
        viewport: z.object({
            width: z.number().default(1920),
            height: z.number().default(1080)
        }).optional(),
        shouldRunInHeadless: z.boolean().default(true)
    },
    async ({ url, selector, text, viewport, shouldRunInHeadless }) => {
        try {
            const result = await executeType(url, selector, text, viewport, shouldRunInHeadless);
            return {
                content: [
                    { type: "text", text: result.message },
                    { type: "image", data: result.base64Screenshot, mimeType: "image/png" }
                ],
                isError: false
            };
        } catch (error: any) {
            return {
                content: [
                    { type: "text", text: `Error performing type: ${error.message}` }
                ],
                isError: true
            };
        }
    }
);

server.tool(
    "perform_click",
    {
        url: z.string().url(),
        selector: z.string(),
        viewport: z.object({
            width: z.number().default(1920),
            height: z.number().default(1080)
        }).optional(),
        shouldRunInHeadless: z.boolean().default(true)
    },
    async ({ url, selector, viewport, shouldRunInHeadless }) => {
        try {
            const result = await executeClick(url, selector, viewport, shouldRunInHeadless);
            return {
                content: [
                    { type: "text", text: result.message },
                    { type: "image", data: result.base64Screenshot, mimeType: "image/png" }
                ],
                isError: false
            };
        } catch (error: any) {
            return {
                content: [
                    { type: "text", text: `Error performing click: ${error.message}` }
                ],
                isError: true
            };
        }
    }
);

export default server;
