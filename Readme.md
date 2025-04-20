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

### Docker Installation

The project includes a Dockerfile that sets up all necessary dependencies including Node.js v22 and Python 3.13.

1. Build the Docker image:
```bash
docker build -t mcp-server .
```

2. Run the container:
```bash
docker run -it -e MCP_PROXY_DEBUG=true mcp-server
```

You can also run it in the background:
```bash
docker run -d -p 3000:3000 mcp-server
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

- `url`: The webpage URL to scan (required)
- `violationsTag`: Array of accessibility violation tags to check (required)
- `viewport`: Optional object to customize the viewport size
  - `width`: number (default: 1920)
  - `height`: number (default: 1080)
- `shouldRunInHeadless`: Optional boolean to control headless mode (default: true)

Example usage in Claude:
```
Could you scan example.com for accessibility issues related to color contrast?
```

Advanced example with custom options:
```
Could you scan example.com for accessibility issues with a viewport of 1280x720 and show the browser window?
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

### Docker Development

For development using Docker:

1. Build the development image:
```bash
docker build -t mcp-server-dev .
```

2. Run with volume mounting for live code changes:
```bash
docker run -it -v $(pwd):/app -p 3000:3000 -e MCP_PROXY_DEBUG=true mcp-server-dev
```

## Project Structure

```
├── src/              # Source code
│   ├── index.ts     # MCP server setup and tool definitions
│   └── scanner.ts   # Core scanning functionality
├── build/           # Compiled JavaScript output
├── Dockerfile       # Docker configuration for containerized setup
├── package.json     # Project configuration and dependencies
└── tsconfig.json    # TypeScript configuration
```

## License

MIT

