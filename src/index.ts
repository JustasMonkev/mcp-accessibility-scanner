import { z } from "zod";
import { scanViolations } from "./accessibilityChecker";
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
        shouldRunInHeadless: z.boolean().default(true),
        actions: z.array(z.union([
            z.object({
                type: z.literal("click"),
                selector: z.string()
            }),
            z.object({
                type: z.literal("type"),
                selector: z.string(),
                text: z.string()
            })
        ])).optional()
    },
    async ({url, violationsTag, viewport, shouldRunInHeadless, actions}) => {
        const {report, base64Screenshot} = await scanViolations(url, violationsTag, viewport, shouldRunInHeadless, actions);

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

export default server;
