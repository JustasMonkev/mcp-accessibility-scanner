#!/usr/bin/env node
import server from "./index";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main() {
	const transport = new StdioServerTransport();

	await server.connect(transport);

	try {
		console.error("Starting MCP Accessibility checker server...");
		console.error("MCP server connected successfully");
	} catch (error) {
		console.error("Error starting server:", error);
		if (error instanceof Error) {
			console.error("Error stack:", error.stack);
		}
		process.exit(1);
	}

	// Handle process events
	process.on("disconnect", () => {
		console.error("Process disconnected");
		process.exit(0);
	});

	process.on("uncaughtException", (error) => {
		console.error("Uncaught exception:", error);
		process.exit(1);
	});

	// Keep the process running
	process.stdin.resume();
}

// Start the server
main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
