"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const accessibilityChecker_1 = require("./accessibilityChecker");
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const server = new mcp_js_1.McpServer({
    name: "Accessibility Information",
    version: "1.0.0"
});
server.tool("scan_accessibility", {
    url: zod_1.z.string().url(),
    violationsTag: zod_1.z.array(zod_1.z.string())
}, (_a) => __awaiter(void 0, [_a], void 0, function* ({ url, violationsTag }) {
    const { report, base64Screenshot } = yield (0, accessibilityChecker_1.scanViolations)(url, violationsTag);
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(Object.assign({ message: 'The image has been saved to your downloads.' }, report), null, 2)
            },
            {
                type: "image",
                data: base64Screenshot,
                mimeType: "image/png"
            }
        ],
        isError: false
    };
}));
exports.default = server;
