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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const index_1 = __importDefault(require("./index"));
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        const transport = new stdio_js_1.StdioServerTransport();
        yield index_1.default.connect(transport);
        try {
            console.error('Starting MCP Accessibility checker server...');
            console.error('MCP server connected successfully');
        }
        catch (error) {
            console.error('Error starting server:', error);
            if (error instanceof Error) {
                console.error('Error stack:', error.stack);
            }
            process.exit(1);
        }
        // Handle process events
        process.on('disconnect', () => {
            console.error('Process disconnected');
            process.exit(0);
        });
        process.on('uncaughtException', (error) => {
            console.error('Uncaught exception:', error);
            process.exit(1);
        });
        // Keep the process running
        process.stdin.resume();
    });
}
// Start the server
main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
