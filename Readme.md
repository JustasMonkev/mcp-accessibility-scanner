# MCP Accessibility Scanner 🔍

A Model Context Protocol (MCP) server that provides automated web accessibility scanning using Playwright and Axe-core. This server enables LLMs to perform WCAG compliance checks, capture annotated screenshots, and generate detailed accessibility reports.

## Features

✅ Full WCAG 2.1/2.2 compliance checking  
🖼️ Automatic screenshot capture with violation highlighting  
📄 Detailed JSON reports with remediation guidance

## Installation

You can install the package using any of these methods:

Using npm:
```bash
npm install -g mcp-accessibility-scanner
```

Using mcp-get:
```bash
npx @michaellatman/mcp-get@latest install mcp-accessibility-scanner
```

Using Smithery (for Claude Desktop):
```bash
npx -y @smithery/cli install mcp-accessibility-scanner --client claude
```

### Installation in VS Code

Install the Accessibility Scanner in VS Code using the VS Code CLI:

For VS Code:
```bash
code --add-mcp '{"name":"accessibility-scanner","command":"npx","args":["mcp-accessibility-scanner"]}'
```

For VS Code Insiders:
```bash
code-insiders --add-mcp '{"name":"accessibility-scanner","command":"npx","args":["mcp-accessibility-scanner"]}'
```

## Configuration

Here's the Claude Desktop configuration:

```json
{
  "mcpServers": {
    "accessibility-scanner": {
      "command": "npx",
      "args": ["-y", "mcp-accessibility-scanner"]
    }
  }
}
```

## Usage

The scanner exposes a single tool `scan_accessibility` that accepts:

- `url`: The webpage URL to scan
- `violationsTag`: Array of accessibility violation tags to check (optional)

Example usage in Claude:
```
Could you scan example.com for accessibility issues related to color contrast?
```

## Development

Clone and set up the project:
```bash
git clone https://github.com/JustasMonkev/mcp-accessibility-scanner.git
cd mcp-accessibility-scanner
npm install
```

Start the TypeScript compiler in watch mode:
```bash
npm run watch
```

Test the MCP server locally:
```bash
npm run inspector
```

## Project Structure

```
├── src/              # Source code
│   ├── index.ts     # MCP server setup and tool definitions
│   └── scanner.ts   # Core scanning functionality
├── build/           # Compiled JavaScript output
├── package.json     # Project configuration and dependencies
└── tsconfig.json    # TypeScript configuration
```

## License

MIT

