[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/justasmonkev-mcp-accessibility-scanner-badge.png)](https://mseep.ai/app/justasmonkev-mcp-accessibility-scanner)

# MCP Accessibility Scanner 🔍

A powerful Model Context Protocol (MCP) server that provides automated web accessibility scanning and browser automation using Playwright and Axe-core. This server enables LLMs to perform WCAG compliance checks, interact with web pages, manage persistent browser sessions, and generate detailed accessibility reports with visual annotations.

## Features

### Accessibility Scanning
✅ Full WCAG 2.0/2.1/2.2 compliance checking (A, AA, AAA levels)  
🖼️ Automatic screenshot capture with violation highlighting  
📄 Detailed JSON reports with remediation guidance  
🎯 Support for specific violation categories (color contrast, ARIA, forms, keyboard navigation, etc.)  

### Browser Automation
🖱️ Click elements by CSS selector or visible text  
⌨️ Type text into inputs by selector or label  
🔍 Analyze pages to discover all interactive elements  
📸 Capture screenshots after each interaction  

### Session Management
🔄 Create persistent browser sessions for multi-step workflows  
⏱️ Automatic session cleanup after 3 minutes of inactivity  
🌐 Navigate between pages while maintaining session state  
📊 Run accessibility scans within active sessions

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

## Available Tools

The MCP server exposes 18 tools for accessibility scanning and browser automation:

### Accessibility Scanning

#### `accessibility-scan`
Performs a comprehensive accessibility scan on a webpage.

**Parameters:**
- `url`: The webpage URL to scan (required)
- `violationsTag`: Array of WCAG/violation tags to check (required)
- `viewport`: Optional viewport size (default: 1920x1080)
- `shouldRunInHeadless`: Optional headless mode control (default: true)

**Supported Violation Tags:**
- WCAG levels: `wcag2a`, `wcag2aa`, `wcag2aaa`, `wcag21a`, `wcag21aa`, `wcag21aaa`, `wcag22a`, `wcag22aa`, `wcag22aaa`
- Section 508: `section508`
- Categories: `cat.color` (contrast), `cat.aria`, `cat.forms`, `cat.keyboard`, `cat.language`, `cat.structure`, etc.

### Browser Automation

#### `click-element`
Clicks an element by CSS selector.
- Parameters: `url`, `selector`, `viewport`, `shouldRunInHeadless`

#### `click-element-by-text`
Clicks elements by their visible text content.
- Parameters: `url`, `text`, `elementType` (optional), `viewport`, `shouldRunInHeadless`

#### `type-text`
Types text into an input field by CSS selector.
- Parameters: `url`, `selector`, `text`, `viewport`, `shouldRunInHeadless`

#### `type-text-by-label`
Types text into input fields by their label text.
- Parameters: `url`, `labelText`, `text`, `viewport`, `shouldRunInHeadless`

#### `analyze-page`
Analyzes page to identify all interactive elements.
- Parameters: `url`, `viewport`, `shouldRunInHeadless`
- Returns: Lists of all buttons, links, and inputs on the page

### Session Management

#### `create-session`
Creates a persistent browser session for multiple operations.
- Parameters: `sessionId`, `viewport`, `shouldRunInHeadless`
- Sessions auto-expire after 3 minutes of inactivity

#### `navigate-session`
Navigates to a URL in an existing session.
- Parameters: `sessionId`, `url`

#### `click-session` / `click-session-by-text`
Click elements within a session.

#### `type-session` / `type-session-by-label`
Type text within a session.

#### `scan-session`
Run accessibility scan on current page in session.

#### `analyze-session`
Analyze current page in session.

#### `close-session`
Close a browser session.

#### `list-sessions`
List all active browser sessions.

## Usage Examples

### Basic Accessibility Scan
```
Could you scan example.com for WCAG 2.1 AA compliance issues?
```

### Color Contrast Check
```
Please check example.com for color contrast accessibility issues (cat.color).
```

### Multi-step Workflow with Sessions
```
1. Create a session and navigate to example.com
2. Click the "Sign In" button
3. Type "user@example.com" into the email field
4. Run an accessibility scan on the login page
5. Close the session
```

### Page Analysis
```
Can you analyze example.com and tell me what interactive elements are available?
```

### Smart Element Interaction
```
Navigate to example.com and click the button that says "Get Started"
```

**Note:** All tools automatically save annotated screenshots to your downloads folder, with accessibility violations highlighted in red and numbered badges.

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

