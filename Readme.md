# MCP Accessibility Scanner

A Model Context Protocol (MCP) server for performing automated accessibility scans of web pages using Playwright and Axe-core.

## Features

✅ Full WCAG 2.1/2.2 compliance checking  
🖼️ Automatic screenshot capture with violation highlighting  
📄 Detailed JSON reports with remediation guidance

## Installation

```bash
# Clone repository
git clone https://github.com/JustasMonkev/mcp-accessibility-scanner.git
cd mcp-accessibility-scanner

# Install dependencies
npm install

# Build project (compiles TypeScript and installs Playwright browsers)
npm run prepare
```

## Claude Desktop Configuration

Add the following to your Claude Desktop settings to enable the Accessibility Scanner server:

```json
{
  "mcpServers": {
    "accessibility-checker": {
      "command": "node",
      "args": [
        "path/build/server.js"
      ]
    }
  }
}
```

## Usage

The scanner exposes a single tool `scan_accessibility` that accepts:

- `url`: The webpage URL to scan
- `violationsTag`: Array of accessibility violation tags to check

Example usage in Claude:
```
Could you scan example.com for accessibility issues related to color contrast?
```

## Development

Start the TypeScript compiler in watch mode:
```bash
npm run watch
```

Test the MCP server locally:
```bash
npm run inspector
```

## Project Structure

- `src/`: Source code
    - `index.ts`: MCP server setup and tool definitions
    - `accessibilityChecker.ts`: Core scanning functionality
- `dist/`: Compiled JavaScript output
- `package.json`: Project dependencies and scripts
- `tsconfig.json`: TypeScript configuration

## Output

The scanner provides:
1. A visual report with numbered violations highlighted on the page
2. A detailed JSON report of all found violations
3. A full-page screenshot saved to Downloads

