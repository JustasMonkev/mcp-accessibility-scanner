
# MCP Accessibility Scanner 🔍

[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/justasmonkev-mcp-accessibility-scanner-badge.png)](https://mseep.ai/app/justasmonkev-mcp-accessibility-scanner)

A Model Context Protocol (MCP) server that provides automated web accessibility scanning using Playwright and Axe-core. This server enables LLMs to perform WCAG compliance checks, capture annotated screenshots, and generate detailed accessibility reports.
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
- `timeouts.navigationTimeout`: Maximum time for page navigation in milliseconds (default: `60000`)
- `timeouts.defaultTimeout`: Default timeout for Playwright operations in milliseconds (default: `5000`)
- `network.allowedOrigins`: List of origins to allow (blocks all others if specified)
- `network.blockedOrigins`: List of origins to block

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
```
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
```
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
```
1. Navigate to the target page and let it fully load
2. Run audit_keyboard with maxTabs: 50
3. Review focus findings and open the generated JSON report path
```

### Navigation Tools

#### `browser_navigate`
Navigate to a URL.
- Parameters: `url` (string)

#### `browser_navigate_back`
Go back to the previous page.

#### `browser_navigate_forward`
Go forward to the next page.

### Page Interaction Tools

#### `browser_snapshot`
Capture accessibility snapshot of the current page (better than screenshot for analysis).

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

#### `browser_select_option`
Select an option in a dropdown.
- Parameters: `element`, `ref`, `values` (array)

#### `browser_press_key`
Press a key on the keyboard.
- Parameters: `key` (e.g., 'ArrowLeft' or 'a')

### Screenshot & Visual Tools

#### `browser_take_screenshot`
Take a screenshot of the current page.
- Parameters: `raw` (optional), `filename` (optional), `element` (optional), `ref` (optional)

#### `browser_pdf_save`
Save page as PDF.
- Parameters: `filename` (optional, defaults to `page-{timestamp}.pdf`)

### Browser Management

#### `browser_close`
Close the page.

#### `browser_resize`
Resize the browser window.
- Parameters: `width`, `height`

### Tab Management

#### `browser_tab_list`
List all open browser tabs.

#### `browser_tab_new`
Open a new tab.
- Parameters: `url` (optional)

#### `browser_tab_select`
Select a tab by index.
- Parameters: `index`

#### `browser_tab_close`
Close a tab.
- Parameters: `index` (optional, closes current tab if not provided)

### Information & Monitoring Tools

#### `browser_console_messages`
Returns all console messages from the page.

#### `browser_network_requests`
Returns all network requests since loading the page.

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

### Vision Mode Tools (Coordinate-based Interaction)

#### `browser_screen_capture`
Take a screenshot for coordinate-based interaction.

#### `browser_screen_move_mouse`
Move mouse to specific coordinates.
- Parameters: `element`, `x`, `y`

#### `browser_screen_click`
Click at specific coordinates.
- Parameters: `element`, `x`, `y`

#### `browser_screen_drag`
Drag from one coordinate to another.
- Parameters: `element`, `startX`, `startY`, `endX`, `endY`

#### `browser_screen_type`
Type text (coordinate-independent).
- Parameters: `text`, `submit` (optional)

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
1. Open a new tab with browser_tab_new
2. Navigate to different pages in each tab
3. Switch between tabs using browser_tab_select
4. List all tabs with browser_tab_list
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
