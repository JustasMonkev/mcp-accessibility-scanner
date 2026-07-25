
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

### Browser extension mode

Use `--extension` to connect through the current [Playwright Extension](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md), which must support extension protocol v2.

```bash
npx mcp-accessibility-scanner --extension
```

Set `PLAYWRIGHT_MCP_EXTENSION_TOKEN` to the token shown by the extension to bypass the connection approval dialog.
When `--user-data-dir` contains multiple Chrome profiles, the profile with the extension installed is selected automatically, preferring Chrome's last-used profile.

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
    "defaultTimeout": 5000,
    "settle": 500
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
- CDP attach modes preserve the target browser's existing default-context settings instead of applying Playwright's defaults.
- `browser.contextOptions.storageState`: Start each session from a recorded Playwright storage state; needs a mode that creates its own context (`browser.isolated`, `browser.remoteEndpoint`, or a CDP mode with `browser.isolated`) — see [Auditing pages behind a login](#auditing-pages-behind-a-login)
- `timeouts.navigationTimeout`: Maximum time for page navigation in milliseconds (default: `60000`)
- `timeouts.defaultTimeout`: Default timeout for Playwright operations in milliseconds (default: `5000`)
- `timeouts.settle`: How long to wait after each action for triggered work to settle before responding (default: `500`)
- `network.allowedOrigins`: List of origins to allow (blocks all others if specified)
- `network.blockedOrigins`: List of origins to block

CLI equivalents are also available: `--cdp-launch-command`, `--cdp-launch-args`, `--cdp-launch-cwd`, `--cdp-launch-port`, `--cdp-launch-startup-timeout`, `--cdp-endpoint`, `--cdp-header` (repeat for multiple headers, e.g. `--cdp-header "Authorization: Bearer <token>"`), and `--cdp-timeout`. The CDP headers and timeout can also be set via the `PLAYWRIGHT_MCP_CDP_HEADERS` (one `Name: Value` entry per line) and `PLAYWRIGHT_MCP_CDP_TIMEOUT` environment variables.

Use `--timeout-settle` or `PLAYWRIGHT_MCP_TIMEOUT_SETTLE` to override the post-action settle delay.

#### HTTP Heartbeat

When the server runs with `--port`, it sends MCP heartbeat pings for Streamable HTTP sessions. Set `PLAYWRIGHT_MCP_PING_TIMEOUT_MS` to override the default `5000` ms timeout. Set it to `0` or any negative value to disable heartbeat pings for clients or proxies that do not answer server-initiated pings.

## Auditing pages behind a login

Most real audits target pages that only exist for a signed-in user. There are two ways to get there.

### Interactive route (no setup)

Every tool shares one browser context, and `audit_site` crawls in a temporary tab of that same context, so cookies and local storage created while you drive the browser are already available to the crawl:

```text
1. browser_navigate to the login page
2. browser_fill_form / browser_click to sign in
3. browser_navigate to the first page you want audited
4. audit_site — the crawl inherits the session you just created
```

This works out of the box in every mode, including the default persistent-profile mode. With the default profile the session also survives across server restarts, so you usually only sign in once.

### Storage state route (repeatable, CI-friendly)

Record a session once with Playwright's codegen, then hand the file to the server:

```bash
npx playwright codegen --save-storage=auth.json https://example.com/login
```

Sign in in the opened browser, then close it — `auth.json` now holds the cookies and local storage.

Pass it to the server with the CLI flag, the environment variable, or the config file:

```bash
npx mcp-accessibility-scanner --isolated --storage-state ./auth.json
```

```bash
PLAYWRIGHT_MCP_ISOLATED=true PLAYWRIGHT_MCP_STORAGE_STATE=./auth.json npx mcp-accessibility-scanner
```

```json
{
  "browser": {
    "isolated": true,
    "contextOptions": {
      "storageState": "./auth.json"
    }
  }
}
```

> **A fresh browser context is required.** Playwright only applies a storage state to a context it creates. That means `--isolated`, the remote-endpoint mode, or either CDP mode combined with `--isolated`. The default persistent-profile mode has no storage-state option at all, and the CDP modes without `--isolated` attach to the browser's existing context, so the server refuses to start with a storage state in those modes rather than silently auditing your site as an anonymous user. There, sign in interactively instead — the persistent profile also keeps the session across restarts.

### Keep the crawl from destroying its own session

`audit_site` excludes `logout|signout` by default, which is not enough for most applications. Add anything else that ends or changes the session before you start the crawl:

```json
{
  "excludePathPatterns": ["logout|signout", "account/(close|delete)", "sessions/revoke", "/switch-(locale|account|org)"]
}
```

Note that `excludePathPatterns` replaces the default rather than extending it, so repeat `logout|signout` in your list.

If a session cookie disappears anyway, `audit_site` says so instead of reporting a confident, wrong audit: the result starts with a `WARNING: session cookie(s) … disappeared while loading <url>` line, and both the JSON report and the structured content carry a `sessionLoss` object naming the page that dropped the cookies. Every page scanned after that point was audited as a signed-out user — exclude the offending URL, sign in again, and re-run.

## Available Tools

The MCP server provides comprehensive browser automation and accessibility scanning tools:

### Core Accessibility Tool

#### `scan_page`
Performs a comprehensive accessibility scan on the current page using Axe-core.

**Parameters:**
- `violationsTag`: Array of WCAG/violation tags to check
- `includeIncomplete` (default `true`): also report Axe "incomplete" results
- `maxNodesPerViolation` (default `10`): cap on nodes reported per rule
- `includeSelectors` / `excludeSelectors`: CSS selectors that scope the scan
- `annotateScreenshot` (default `false`): capture an annotated screenshot of the violations

**Annotated screenshots:**
When `annotateScreenshot` is `true`, each violating element is outlined and labelled with the rule ids it failed, a full-page PNG is written to the MCP output directory (`scan-page-annotated-{timestamp}.png`) and returned as a resource link, and the markers are then removed so the page is left exactly as it was. The markers are drawn in an out-of-flow overlay clipped to each element's own box, so they never reflow the page. The overlay uses a fresh id per scan, is placed in the browser's top layer so it stays visible over an open dialog, popover or fullscreen element, and compensates for a CSS `zoom` or a scaled ancestor so markers line up with what is rendered.
An element that fails several rules gets one box listing every rule id, and elements inside open shadow roots are marked by walking the shadow path Axe reports.
At most 50 elements are annotated per scan. The result text always reports how many nodes were marked out of the total, plus how many were left out because they exceeded the limit, were hidden or zero-size, or were inside an iframe (cross-frame selectors cannot be resolved from the top document).

**Supported Violation Tags:**
- WCAG standards (in the default set): `wcag2a`, `wcag2aa`, `wcag2aaa`, `wcag21a`, `wcag21aa`, `wcag21aaa`, `wcag22a`, `wcag22aa`, `wcag22aaa`
- Section 508 (in the default set): `section508`
- Categories (opt-in): `cat.aria`, `cat.color`, `cat.forms`, `cat.keyboard`, `cat.language`, `cat.name-role-value`, `cat.parsing`, `cat.semantics`, `cat.sensory-and-visual-cues`, `cat.structure`, `cat.tables`, `cat.text-alternatives`, `cat.time-and-media`
- Non-conformance tags (opt-in): `best-practice`, `experimental`

The default set is the WCAG and Section 508 tags only, so a default report means "this fails a conformance criterion". Category tags are opt-in for that reason: Axe matches requested tags with OR, so asking for `cat.keyboard` also pulls in best-practice rules such as `region` and `skip-link` that carry both tags. No live conformance rule is lost by leaving them out: the only rules reachable *only* through a `cat.*` tag are `duplicate-id` and `duplicate-id-active`, which Axe marks deprecated because WCAG removed SC 4.1.1. Add `best-practice` (landmark structure, heading order, `tabindex` hygiene) or a `cat.*` tag when you want that broader review.

**Scan scoping:**
`scan_page`, `audit_site`, and `scan_page_matrix` accept `includeSelectors` and `excludeSelectors` to limit what Axe looks at. Use `includeSelectors` to audit one component (`["#checkout-form"]`) and `excludeSelectors` to drop third-party noise that pollutes every report (`["#cookie-banner", "iframe.intercom-frame"]`). Exclusions are applied after inclusions, so you can carve a widget out of an included subtree.

Selectors are resolved before the scan runs:
- Syntactically invalid CSS fails the scan, naming the selector.
- An `includeSelectors` entry that matches nothing fails the scan. Axe on its own would accept a partly-matching include set and quietly scan less than you asked for, so the scanner refuses rather than returning a clean-looking report with half the scope missing.
- An `excludeSelectors` entry that matches nothing is a no-op, not an error -- a crawl legitimately visits pages that lack the excluded widget.

In `audit_site`, selectors apply to every crawled page, so an `includeSelectors` value that is absent from a given page marks *that page* as errored in the report while the crawl continues. Link discovery runs before the scan, so pages reachable only through an errored page are still crawled.

**Incomplete ("needs review") results:**
Axe returns `incomplete` for checks it cannot decide on its own -- contrast over a background image or gradient, ambiguous labels, elements it could not fully evaluate. `scan_page`, `audit_site`, and `scan_page_matrix` report these in a section separate from violations so you can resolve them by inspecting the page (screenshot, snapshot, `browser_evaluate`). Set `includeIncomplete: false` to suppress them.

### Audit Tools

#### `audit_site`
Crawls and scans multiple internal pages, then aggregates violations across the site.
- Default strategy: link-based BFS from the current URL
- Supports `links`, `nav`, `sitemap`, and `provided` URL strategies
- Always writes a JSON report (default filename: `audit-site-{timestamp}.json`)
- Warns and records `sessionLoss` if the crawl loses the cookies it started with — see [Auditing pages behind a login](#auditing-pages-behind-a-login)

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
- Checks target size against WCAG 2.2 SC 2.5.8 (`checkTargetSize`, default on)
- Checks that focus is not entirely obscured, WCAG 2.2 SC 2.4.11 (`checkFocusObscured`, default on)
- Optional issue screenshots (`screenshotOnIssue`)
- Always writes a JSON report (default filename: `audit-keyboard-{timestamp}.json`)

**Limits of the WCAG 2.2 checks** — these are heuristics, not a conformance verdict:
- Target size only inspects elements the tab order actually reaches, so pointer-only targets are never measured.
- Of the SC 2.5.8 exceptions, only *spacing* (a 24px-diameter circle centered on the target must not reach another
  target or another undersized target's circle) and *inline* (an inline-level target — `inline`, `inline-block`,
  `inline-flex`, … — inside surrounding sentence text) are evaluated. The *user agent control*, *essential*, and
  *equivalent* exceptions cannot be detected from the DOM, so a target relying on one of them is still reported and
  needs manual triage.
- Spacing neighbours use the same pointer-target rule as the focused element, so rendered `:disabled` controls are not
  counted as neighbours.
- Target size uses the element's bounding box, so an inline target wrapped over several lines is measured as one
  union box rather than per line.
- SC 2.4.11 is the Minimum (AA) level: a focused element is only reported when *every* sampled point of its box is
  covered by other content. Partially covered focus passes here, and the stricter SC 2.4.12 (AAA) is not checked.
  It applies to every focus stop with a rendered box, including elements that are not pointer targets such as
  `contenteditable` regions and iframes.
- Coverage is measured by hit-testing sample points and then checking that the element hit actually paints (visible,
  non-zero opacity, non-transparent background or background image). A transparent click-catching overlay therefore
  does *not* count as obscuration, but a covering layer with `pointer-events: none` is never returned by hit testing
  and is missed. Semi-transparent overlays that still leave content legible are reported.

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
Evaluate a JavaScript expression on the page, or on a specific element when a `ref` is provided. The function's return value is serialized back as the result.
- Parameters: `function` (e.g., `() => document.title` or `(element) => element.textContent`), `element` (optional), `ref` (optional)

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
Returns all network requests since loading the page.
Large `data:` URL payloads in request URLs are truncated to their media type prefix.

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
