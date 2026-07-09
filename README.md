
# MCP Accessibility Scanner 🔍

## Star History
[![Star History Chart](https://api.star-history.com/svg?repos=justasmonkev%2Fmcp-accessibility-scanner&type=Date)](https://api.star-history.com/svg?repos=justasmonkev%2Fmcp-accessibility-scanner&type=Date)

[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/justasmonkev-mcp-accessibility-scanner-badge.png)](https://mseep.ai/app/justasmonkev-mcp-accessibility-scanner)

A powerful Model Context Protocol (MCP) server that provides automated web accessibility scanning and browser automation using Playwright and Axe-core. This server enables LLMs to perform WCAG compliance checks, interact with web pages, manage persistent browser sessions, and generate detailed accessibility reports with visual annotations.

## Features

### Accessibility Scanning
✅ Full WCAG 2.0/2.1/2.2 compliance checking (A, AA, AAA levels)  
📄 Detailed JSON reports with remediation guidance  
🎯 Support for specific violation categories (color contrast, ARIA, forms, keyboard navigation, etc.)  

### Browser Automation
🖱️ Click, hover, and drag elements using accessibility snapshots  
⌨️ Type text and handle keyboard inputs  
🔍 Capture page snapshots to discover all interactive elements  
📸 Take screenshots and save PDFs  
🎯 Support for both element-based and coordinate-based interactions  

### Advanced Features
📑 Tab management for multi-page workflows  
🌐 Monitor console messages and network requests  
⏱️ Wait for dynamic content to load  
📁 Handle file uploads and browser dialogs  
🔄 Navigate through browser history

## Installation

You can install the package using any of these methods:

Using npm:
```bash
npm install -g mcp-accessibility-scanner
```

### Installation with Docker

A pre-built image is available on Docker Hub. The image includes Chromium and is pre-configured for containerized use — no extra flags needed.

**Pull from Docker Hub:**
```bash
docker pull justasmonkev/mcp-accessibility-scanner
```

#### Claude Code

```bash
 claude mcp add mcp-accessibility-scanner -s user -- docker run -i --rm justasmonkev/mcp-accessibility-scanner
```

To persist screenshots and reports on your host, add a volume mount:

```bash
claude mcp add mcp-accessibility-scanner -s user \
  -- docker run -i --rm -v /tmp/mcp-output:/app/output justasmonkev/mcp-accessibility-scanner
```

Without the `-v` mount, output files only exist inside the container and are lost when it exits.

#### Docker Compose

```bash
docker compose up -d
```

The Compose configuration publishes the unauthenticated MCP HTTP transport on `127.0.0.1:8931` only. Do not expose this port to untrusted networks.

#### Build from source

```bash
docker build -t mcp-accessibility-scanner .
```

#### Docker smoke test

```bash
npm run test:docker
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

## CLI Modes

The scanner can run in two modes depending on how you use it.

### MCP server (default, no subcommand)

When launched without a subcommand, the process starts an MCP server that communicates over stdio. This is the mode used by MCP clients such as Claude Desktop, VS Code, and Claude Code -- you should never need to run it by hand.

```bash
npx mcp-accessibility-scanner            # starts the MCP server (stdio)
```

All of the MCP client configuration examples in this README already use this default mode.

### Interactive REPL (`interactive` subcommand)

For manual terminal use, the `interactive` subcommand starts a readline REPL where you can call any tool directly:

```bash
$ npx mcp-accessibility-scanner interactive
Interactive mode. Type "<tool-name> <json>" to call a tool. Ctrl+D to exit.
> browser_navigate {"url": "https://example.com"}
> scan_page {"violationsTag": ["wcag21aa"]}
> audit_keyboard {"maxTabs": 30}
```

Each line is `<tool-name> <json-arguments>`. Omit the JSON to pass `{}`.
Global browser connection flags still apply here, for example `npx mcp-accessibility-scanner --headless interactive`.
Use `--mobile` or `PLAYWRIGHT_MCP_MOBILE=1` to emulate a generic mobile device (`Pixel 10` for Chromium, `iPhone 17` for WebKit). It cannot be combined with `--device`, CDP attach/launch modes, remote browser endpoints, or `--extension`.

### Discovering available tools (`list-tools` subcommand)

To print every tool name and its description:

```bash
npx mcp-accessibility-scanner list-tools
```

> **Note:** Tool names like `browser_navigate` and `scan_page` are MCP tool identifiers (and REPL commands in interactive mode). They are not shell subcommands -- you cannot run `npx mcp-accessibility-scanner browser_navigate`.

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

### Advanced Configuration

You can pass a configuration file to customize Playwright behavior:

```json
{
  "mcpServers": {
    "accessibility-scanner": {
      "command": "npx",
      "args": ["-y", "mcp-accessibility-scanner", "--config", "/path/to/config.json"]
    }
  }
}
```

#### Configuration Options

Create a `config.json` file with the following options:

```json
{
  "browser": {
    "browserName": "chromium",
    "launchOptions": {
      "headless": true,
      "channel": "chrome"
    },
    "cdpLaunch": {
      "command": "open",
      "args": ["-a", "Slack", "--args", "--remote-debugging-port={port}"],
      "startupTimeoutMs": 30000
    }
  },
  "timeouts": {
    "navigationTimeout": 60000,
    "defaultTimeout": 5000
  },
  "network": {
    "allowedOrigins": ["example.com", "trusted-site.com"],
    "blockedOrigins": ["ads.example.com"]
  }
}
```

**Available Options:**

- `browser.browserName`: Browser to use (`chromium`, `firefox`, `webkit`)
- `browser.launchOptions.headless`: Run browser in headless mode (default: `true` on Linux without display, `false` otherwise)
- `browser.launchOptions.channel`: Browser channel (`chrome`, `chrome-beta`, `msedge`, etc.)
- `browser.cdpEndpoint`: Attach to an already-running Chromium-family app with CDP enabled
- `browser.cdpHeaders`: Map of HTTP headers to send with the CDP connect request, e.g. `{ "Authorization": "Bearer <token>" }`, for endpoints that require header-based authentication
- `browser.cdpTimeout`: Maximum time in milliseconds to wait when connecting to the CDP endpoint (default: `30000`)
- `browser.cdpLaunch`: Launch a Chromium-family desktop app with CDP enabled, wait for the endpoint, and manage the child process lifecycle
- `timeouts.navigationTimeout`: Maximum time for page navigation in milliseconds (default: `60000`)
- `timeouts.defaultTimeout`: Default timeout for Playwright operations in milliseconds (default: `5000`)
- `network.allowedOrigins`: List of origins to allow (blocks all others if specified)
- `network.blockedOrigins`: List of origins to block

CLI equivalents are also available: `--cdp-launch-command`, `--cdp-launch-args`, `--cdp-launch-cwd`, `--cdp-launch-port`, `--cdp-launch-startup-timeout`, `--cdp-endpoint`, `--cdp-header` (repeat for multiple headers, e.g. `--cdp-header "Authorization: Bearer <token>"`), and `--cdp-timeout`. The CDP headers and timeout can also be set via the `PLAYWRIGHT_MCP_CDP_HEADERS` (one `Name: Value` entry per line) and `PLAYWRIGHT_MCP_CDP_TIMEOUT` environment variables.

#### HTTP Heartbeat

When the server runs with `--port`, it sends MCP heartbeat pings for Streamable HTTP sessions. Set `PLAYWRIGHT_MCP_PING_TIMEOUT_MS` to override the default `5000` ms timeout. Set it to `0` or any negative value to disable heartbeat pings for clients or proxies that do not answer server-initiated pings.

## Available Tools

The MCP server provides comprehensive browser automation and accessibility scanning tools:

### Core Accessibility Tool

#### `scan_page`
Performs a comprehensive accessibility scan on the current page using Axe-core.

**Parameters:**
- `violationsTag`: Array of WCAG/violation tags to check

**Supported Violation Tags:**
- WCAG standards: `wcag2a`, `wcag2aa`, `wcag2aaa`, `wcag21a`, `wcag21aa`, `wcag21aaa`, `wcag22a`, `wcag22aa`, `wcag22aaa`
- Section 508: `section508`
- Categories: `cat.aria`, `cat.color`, `cat.forms`, `cat.keyboard`, `cat.language`, `cat.name-role-value`, `cat.parsing`, `cat.semantics`, `cat.sensory-and-visual-cues`, `cat.structure`, `cat.tables`, `cat.text-alternatives`, `cat.time-and-media`

### Audit Tools

#### `audit_site`
Crawls and scans multiple internal pages, then aggregates violations across the site.
- Default strategy: link-based BFS from the current URL
- Supports `links`, `nav`, `sitemap`, and `provided` URL strategies
- Always writes a JSON report (default filename: `audit-site-{timestamp}.json`)

**Example flow:**
```text
1. Navigate to your site homepage with browser_navigate
2. Run audit_site with maxPages: 25 and maxDepth: 2
3. Review the report path returned by the tool (written to the MCP output directory)
```

#### `scan_page_matrix`
Runs Axe scans on the same page across viewport/media/zoom variants and compares deltas against baseline.
- Default variants: baseline, mobile, desktop, forced-colors, reduced-motion, zoom-200
- Supports custom variants and optional reload between variants
- Always writes a JSON report (default filename: `scan-matrix-{timestamp}.json`)

**Example flow:**
```text
1. Navigate to a page state you want to validate
2. Run scan_page_matrix with defaults (or provide custom variants)
3. Review per-variant deltas and open the generated JSON report path
```

#### `audit_keyboard`
Audits real keyboard focus behavior by pressing Tab (and optional Shift+Tab) with practical heuristics.
- Checks skip links, focus visibility, focus jumps, and possible focus traps
- Optional issue screenshots (`screenshotOnIssue`)
- Always writes a JSON report (default filename: `audit-keyboard-{timestamp}.json`)

**Example flow:**
```text
1. Navigate to the target page and let it fully load
2. Run audit_keyboard with maxTabs: 50
3. Review focus findings and open the generated JSON report path
```

### Navigation Tools

#### `browser_navigate`
Navigate to a URL.
- Parameters: `url` (string)
- Non-2xx main-document responses are shown as an `HTTP status` line in page state.

#### `browser_navigate_back`
Go back to the previous page.

#### `browser_navigation_timeout`
Set default navigation timeout for existing tabs.
- Parameters: `timeout` (in ms; 30000-300000)

#### `browser_default_timeout`
Set default operation timeout for existing tabs.
- Parameters: `timeout` (in ms; 30000-300000)

### Page Interaction Tools

#### `browser_snapshot`
Capture accessibility snapshot of the current page (better than screenshot for analysis).
Large `data:` URL payloads in snapshot output are truncated to their media type prefix.
- Parameters: `compress` (optional boolean, default false)
  - When true, repeated non-interactive ARIA snapshot nodes are collapsed in the rendered response when a repeated structural pattern appears more than 100 times. The first 10 examples of each collapsed pattern are kept.
  - Use `browser_evaluate()` to retrieve the full uncompressed list when needed.

#### `browser_find`
Search the current page accessibility snapshot without returning the full snapshot.
- Parameters: `text` (case-insensitive substring) or `regex` (regular expression, supports `/pattern/flags`)
- Returns matching snapshot lines with surrounding context, shown under their path from the root of the tree; `...` marks truncated off-path context.

#### `browser_click`
Perform click on a web page element.
- Parameters: `element` (description), `ref` (element reference), `doubleClick` (optional)

#### `browser_type`
Type text into editable element.
- Parameters: `element`, `ref`, `text`, `submit` (optional), `slowly` (optional)

#### `browser_hover`
Hover over element on page.
- Parameters: `element`, `ref`

#### `browser_drag`
Perform drag and drop between two elements.
- Parameters: `startElement`, `startRef`, `endElement`, `endRef`

#### `browser_drop`
Drop files or MIME-typed data onto one element, as if dragged from outside the page.
- Parameters: `element`, `ref`, `paths` (optional array of absolute file paths), `data` (optional map of MIME type to string value)
- At least one non-empty `paths` or `data` value is required.
- File paths must resolve inside the MCP client's filesystem root or the configured output directory.

#### `browser_select_option`
Select an option in a dropdown.
- Parameters: `element`, `ref`, `values` (array)

#### `browser_fill_form`
Fill multiple fields with one call.
- Parameters: `fields` (array of objects with `name`, `type`, `ref`, and `value`)

#### `browser_press_key`
Press a key on the keyboard.
- Parameters: `key` (e.g., 'ArrowLeft' or 'a')

#### `browser_evaluate`
Evaluate JavaScript on the page, or on a specific element when a `ref` is provided. The input may be a function or a plain expression, and promises are awaited.
- Parameters: `function` (e.g., `() => document.title`, `(element) => element.textContent`, or `document.title`), `element` (optional), `ref` (optional)

### Screenshot & Visual Tools

#### `browser_take_screenshot`
Take a screenshot of the current page.
- Parameters: `filename` (optional), `type` (`png` or `jpeg`), `scale` (`css` or `device`, default `css`), `fullPage` (optional), `element`/`ref` pair (for element screenshots)
- `scale: device` captures a high-resolution screenshot using device pixels (accounts for the device pixel ratio); `scale: css` keeps the image sized in CSS pixels.

#### `browser_pdf_save`
Save page as PDF.
- Parameters: `filename` (optional, defaults to `page-{timestamp}.pdf`)

This tool requires `--caps pdf` in the CLI.

#### `browser_install`
Install the configured browser engine (use when browser executable is missing).
- Parameters: none

### Browser Management

#### `browser_close`
Close the page.

#### `browser_resize`
Resize the browser window.
- Parameters: `width`, `height`

### Tab Management

#### `browser_tabs`
Manage browser tabs in one tool.
- Parameters: `action` (`list`, `new`, `close`, `select`) and optional `index` (for `close` and `select`).

### Information & Monitoring Tools

#### `browser_console_messages`
Returns all console messages from the page.
Large `data:` URL payloads in console messages are truncated to their media type prefix.

#### `browser_network_requests`
Returns a numbered list of network requests since loading the page. Successful static resources are hidden by default; failed resources and fetch/XHR requests remain visible. The displayed numbers are stable indexes for `browser_network_request`.
- Parameters: `static` (optional boolean, default `false`), `filter` (optional URL regular expression), `filename` (optional output filename)
Large `data:` URL payloads in request URLs are truncated to their media type prefix.

#### `browser_network_request`
Returns metadata and headers for one request, or one specific request/response part. Bodies are read only when a body part is requested.
- Parameters: `index` (1-based index from `browser_network_requests`), `part` (optional: `request-headers`, `request-body`, `response-headers`, or `response-body`), `filename` (optional output filename), `includeSensitiveHeaders` (optional boolean, default `false`), `allowCompressedBody` (optional boolean, default `false`)
- Authorization, cookie, API-key, token, and secret header values are redacted by default.
- Text request/response bodies are returned inline unless `filename` is provided. Binary bodies are saved byte-for-byte to an output file and returned as a file resource link.
- Inline text bodies are limited to 1 MiB; provide `filename` for larger text. Body reads are capped at 25 MiB, and response reads fail closed when Playwright cannot report their size.
- Compressed response bodies require explicit `allowCompressedBody: true` because their decoded size cannot be bounded before Playwright materializes them.

### Utility Tools

#### `browser_wait_for`
Wait for text to appear/disappear or time to pass.
- Parameters: `time` (optional), `text` (optional), `textGone` (optional)

#### `browser_handle_dialog`
Handle browser dialogs (alerts, confirms, prompts).
- Parameters: `accept` (boolean), `promptText` (optional)

#### `browser_file_upload`
Upload files to the page.
- Parameters: `paths` (array of absolute file paths)

#### `browser_verify_element_visible`
Verify an element by ARIA role/name.
- Parameters: `role`, `accessibleName`

#### `browser_verify_text_visible`
Verify text visibility.
- Parameters: `text`

#### `browser_verify_list_visible`
Verify list items at a snapshot reference.
- Parameters: `element`, `ref`, `items` (array)

#### `browser_verify_value`
Verify an element value or checked state.
- Parameters: `type`, `element`, `ref`, `value`

These verification tools require `--caps verify`:

### Vision Mode Tools (Coordinate-based Interaction)

These tools require `--caps vision`:

#### `browser_mouse_move_xy`
Move mouse to specific coordinates.
- Parameters: `element`, `x`, `y`

#### `browser_mouse_click_xy`
Click at specific coordinates.
- Parameters: `element`, `x`, `y`, `button` (optional: `left`/`right`/`middle`), `clickCount` (optional), `delay` (optional, ms between mouse down and up)

#### `browser_mouse_drag_xy`
Drag from one coordinate to another.
- Parameters: `element`, `startX`, `startY`, `endX`, `endY`

#### Note
Coordinate-based tools require `element` descriptions for permission checks, but the coordinates themselves are used for action targeting.

## Usage Examples

### Basic Accessibility Scan
```
1. Navigate to example.com using browser_navigate
2. Run scan_page with violationsTag: ["wcag21aa"]
```

### Color Contrast Check
```
1. Use browser_navigate to go to example.com
2. Run scan_page with violationsTag: ["cat.color"]
```

### Multi-step Workflow
```
1. Navigate to example.com with browser_navigate
2. Take a browser_snapshot to see available elements
3. Click the "Sign In" button using browser_click
4. Type "user@example.com" using browser_type
5. Run scan_page on the login page
6. Take a browser_take_screenshot to capture the final state
```

### Page Analysis
```
1. Navigate to example.com
2. Use browser_snapshot to capture all interactive elements
3. Review console messages with browser_console_messages
4. Check network activity with browser_network_requests
```

### Tab Management
```
1. Open a new tab with `browser_tabs` and `{"action":"new"}`
2. Navigate to different pages in each tab
3. Switch to a tab with `browser_tabs` and `{"action":"select", "index": 1}`
4. List all tabs with `browser_tabs` and `{"action":"list"}`
```

### Waiting for Dynamic Content
```
1. Navigate to a page
2. Use browser_wait_for to wait for specific text to appear
3. Interact with the dynamically loaded content
```

**Note:** Most interaction tools require element references from browser_snapshot. Always capture a snapshot before attempting to interact with page elements.

## Development

Clone and set up the project:
```bash
git clone https://github.com/JustasMonkev/mcp-accessibility-scanner.git
cd mcp-accessibility-scanner
npm install
```

## License

MIT
