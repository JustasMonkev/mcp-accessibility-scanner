# Accessibility Scanner CLI Skill

Use the local CLI when you want direct automation without attaching an MCP client.

For AI agents using this skill: always launch the interactive REPL with `npx mcp-accessibility-scanner interactive` and send tool calls there. Do not use the default MCP server mode from this skill.

For Electron apps, prefer launching them through this CLI with `--cdp-launch-command` instead of using a separate automation layer.

## CLI Modes

### Interactive REPL

Start a readline prompt for tool execution. This is the required mode for AI agents using this skill. Type `<tool-name> <json>` to call tools.

```bash
npx mcp-accessibility-scanner interactive
npx mcp-accessibility-scanner --headless interactive
```

REPL example session:

```
> browser_navigate {"url":"https://example.com"}
> scan_page {"violationsTag":["wcag2aa"]}
> audit_keyboard {}
> browser_close {}
```

### List Tools

Print all available tools and their descriptions.

```bash
npx mcp-accessibility-scanner list-tools
npx mcp-accessibility-scanner --caps vision,pdf list-tools
```

### MCP Server (do not use from this skill)

Running the CLI without a subcommand starts the MCP server over stdio for MCP clients. This skill does not use that mode.

```bash
npx mcp-accessibility-scanner
npx mcp-accessibility-scanner --headless --browser chrome
```

## Global CLI Options

| Option | Description |
|--------|-------------|
| `--browser <browser>` | Browser to use: `chrome`, `firefox`, `webkit`, `msedge` |
| `--headless` | Run browser in headless mode (headed by default) |
| `--caps <caps>` | Comma-separated extra capabilities: `vision`, `pdf`, `verify` |
| `--viewport-size <size>` | Browser viewport, e.g. `"1280, 720"` |
| `--device <device>` | Device emulation, e.g. `"iPhone 15"` |
| `--output-dir <path>` | Directory for output files (reports, screenshots) |
| `--config <path>` | Path to configuration file |
| `--user-data-dir <path>` | Browser profile directory |
| `--isolated` | Keep browser profile in memory only |
| `--storage-state <path>` | Storage state file for isolated sessions |
| `--executable-path <path>` | Custom browser executable |
| `--cdp-endpoint <endpoint>` | Connect to existing CDP endpoint |
| `--cdp-launch-command <command>` | Launch a Chromium-family desktop app with CDP enabled |
| `--cdp-launch-args <args>` | Comma-separated launch arguments. Use `{port}` placeholder for the debug port |
| `--cdp-launch-cwd <path>` | Working directory for the launched app |
| `--cdp-launch-port <port>` | Fixed CDP port for the launched app |
| `--cdp-launch-startup-timeout <ms>` | How long to wait for the launched app CDP endpoint |
| `--proxy-server <proxy>` | Proxy server, e.g. `"http://myproxy:3128"` |
| `--proxy-bypass <bypass>` | Comma-separated domains to bypass proxy |
| `--allowed-origins <origins>` | Semicolon-separated allowed origins |
| `--blocked-origins <origins>` | Semicolon-separated blocked origins |
| `--block-service-workers` | Block service workers |
| `--ignore-https-errors` | Ignore HTTPS certificate errors |
| `--user-agent <ua>` | Custom user agent string |
| `--host <host>` | Server bind host (default: localhost) |
| `--port <port>` | Port for MCP Streamable HTTP transport |
| `--navigation-timeout <ms>` | Page navigation timeout (default: 60000) |
| `--default-timeout <ms>` | Default Playwright operation timeout (default: 5000) |
| `--save-session` | Save session to output directory |
| `--save-trace` | Save Playwright trace to output directory |
| `--no-sandbox` | Disable browser sandboxing |
| `--image-responses <mode>` | `"allow"` or `"omit"` image responses (default: allow) |

## Accessibility Scanning Tools

### scan_page

Scan the current page for accessibility violations using Axe.

```json
{"violationsTag": ["wcag2aa", "wcag21aa", "wcag22aa"]}
```

For Electron CDP targets, `scan_page` may currently fail with `Target.createTarget: Not supported`. If that happens, keep using the CLI session, select the live app tab with `browser_tabs`, and run Axe through `browser_evaluate` by injecting the local `node_modules/axe-core/axe.min.js` bundle.

### audit_site

Crawl and aggregate accessibility violations across multiple pages. Writes a JSON report.

```json
{
  "startUrl": "https://example.com",
  "strategy": "links",
  "maxPages": 25,
  "maxDepth": 2,
  "sameOriginOnly": true,
  "violationsTag": ["wcag2aa"]
}
```

**Crawl strategies:**
- `links` (default) - Follow all `<a>` links up to `maxDepth`
- `nav` - Scan the start page, then follow only navigation links found on that page inside `<nav>`, `<header>`, or `[role="navigation"]` (single-hop)
- `sitemap` - Fetch URLs from sitemap XML (use `sitemapUrl` to override default `/sitemap.xml`)
- `provided` - Scan an explicit `urls` array

**Key options:**
- `maxPages` (1-200, default 25)
- `maxDepth` (0-5, default 2, links strategy only)
- `includeSubdomains` - Allow subdomains when `sameOriginOnly=true`
- `excludePathPatterns` - Regex patterns to skip (default: `logout|signout`)
- `reportFile` - Custom output filename

### scan_page_matrix

Run accessibility scans across viewport, media, and zoom variants. Compares each variant against a baseline.

```json
{
  "violationsTag": ["wcag2aa"],
  "reloadBetweenVariants": false
}
```

**Default variants:** baseline, mobile (375x812), desktop (1280x720), forced-colors, reduced-motion, zoom-200

**Custom variants:**

```json
{
  "variants": [
    {"name": "baseline"},
    {"name": "tablet", "viewport": {"width": 768, "height": 1024}},
    {"name": "dark-mode", "media": {"colorScheme": "dark"}},
    {"name": "zoom-150", "zoomPercent": 150}
  ]
}
```

**Media options:** `colorScheme` (light/dark), `forcedColors` (active/none), `contrast` (more/no-preference), `reducedMotion` (reduce/no-preference)

### audit_keyboard

Audit keyboard tab order, focus visibility, skip links, and focus traps. Writes a JSON report.

```json
{
  "maxTabs": 50,
  "checkSkipLink": true,
  "checkFocusVisibility": true,
  "checkFocusTrap": true,
  "screenshotOnIssue": true,
  "maxIssueScreenshots": 3
}
```

**Key options:**
- `includeShiftTab` - Alternate Tab/Shift+Tab
- `activateSkipLink` - Press Enter when skip link found
- `stopOnCycle` (default true) - Stop on focus trap detection
- `jumpScrollThresholdPx` (default 800) - Scroll delta for jump detection

## Violation Tag Reference

**WCAG standards:**
`wcag2a`, `wcag2aa`, `wcag2aaa`, `wcag21a`, `wcag21aa`, `wcag21aaa`, `wcag22a`, `wcag22aa`, `wcag22aaa`, `section508`

**Categories:**
`cat.aria`, `cat.color`, `cat.forms`, `cat.keyboard`, `cat.language`, `cat.name-role-value`, `cat.parsing`, `cat.semantics`, `cat.sensory-and-visual-cues`, `cat.structure`, `cat.tables`, `cat.text-alternatives`, `cat.time-and-media`

## Browser Automation Tools

These tools are always available and work in the interactive REPL.

### Navigation & Page

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to URL: `{"url": "https://..."}` |
| `browser_navigate_back` | Go back to previous page |
| `browser_close` | Close the page |
| `browser_resize` | Resize window: `{"width": 1280, "height": 720}` |
| `browser_snapshot` | Capture accessibility snapshot |
| `browser_take_screenshot` | Take screenshot (png/jpeg, fullPage option) |
| `browser_wait_for` | Wait for text/time: `{"text": "loaded"}` or `{"time": 5}` |

### Interaction

| Tool | Description |
|------|-------------|
| `browser_click` | Click element by ref: `{"element": "Submit", "ref": "s1e5"}` |
| `browser_type` | Type text: `{"element": "Search", "ref": "s1e3", "text": "query", "submit": true}` |
| `browser_press_key` | Press key: `{"key": "Enter"}` |
| `browser_hover` | Hover over element |
| `browser_drag` | Drag between elements |
| `browser_select_option` | Select dropdown option |
| `browser_fill_form` | Fill multiple form fields at once |
| `browser_file_upload` | Upload files: `{"paths": ["/path/to/file"]}` |
| `browser_handle_dialog` | Handle browser dialog: `{"accept": true}` |
| `browser_evaluate` | Run JavaScript on page |

### Tabs & Config

| Tool | Description |
|------|-------------|
| `browser_tabs` | Manage tabs: `{"action": "list"}`, `{"action": "new"}`, `{"action": "close"}`, `{"action": "select", "index": 1}` |
| `browser_navigation_timeout` | Set navigation timeout (30s-20min) |
| `browser_default_timeout` | Set default operation timeout (30s-20min) |

### Diagnostics

| Tool | Description |
|------|-------------|
| `browser_console_messages` | Get all console messages |
| `browser_network_requests` | Get all network requests |

### Optional Tools (require `--caps`)

**`--caps pdf`:** `browser_pdf_save` - Save page as PDF

**`--caps verify`:** `browser_verify_element_visible`, `browser_verify_text_visible`, `browser_verify_list_visible`, `browser_verify_value`

**`--caps vision`:** `browser_mouse_move_xy`, `browser_mouse_click_xy`, `browser_mouse_drag_xy`

## Common Recipes

### Full WCAG 2.2 AA audit of a site

```bash
npx mcp-accessibility-scanner --headless interactive
```

```
> browser_navigate {"url":"https://example.com"}
> audit_site {"strategy":"links","maxPages":50,"maxDepth":3,"violationsTag":["wcag2aa","wcag21aa","wcag22aa"]}
```

### Quick single-page scan

```bash
npx mcp-accessibility-scanner --headless interactive
```

```
> browser_navigate {"url":"https://example.com/page"}
> scan_page {"violationsTag":["wcag2aa"]}
```

### Responsive + media variant scan

```bash
npx mcp-accessibility-scanner --headless interactive
```

```
> browser_navigate {"url":"https://example.com"}
> scan_page_matrix {"violationsTag":["wcag2aa","wcag21aa"]}
```

### Keyboard accessibility audit with screenshots

```bash
npx mcp-accessibility-scanner --headless interactive
```

```
> browser_navigate {"url":"https://example.com"}
> audit_keyboard {"screenshotOnIssue":true,"maxIssueScreenshots":5,"activateSkipLink":true}
```

### Scan specific pages from a list

```bash
npx mcp-accessibility-scanner --headless interactive
```

```
> audit_site {"strategy":"provided","urls":["https://example.com/","https://example.com/about","https://example.com/contact"],"violationsTag":["wcag2aa"]}
```

### Electron app flow

Launch the app binary directly if `open -a` does not expose the CDP port. If the app is already running, quit it first so the debug flag is applied on a clean start.

```bash
npx mcp-accessibility-scanner interactive \
  --cdp-launch-command /Applications/YourApp.app/Contents/MacOS/YourApp \
  --cdp-launch-args=--remote-debugging-port={port} \
  --cdp-launch-port 9222
```

Typical REPL flow:

```
> browser_tabs {"action":"list"}
> browser_tabs {"action":"select","index":1}
> browser_evaluate {"function":"() => ({ url: location.href, text: document.body.innerText, links: Array.from(document.querySelectorAll('a,button,[role=button]')).map((el, i) => ({ i, text: (el.textContent || '').trim(), tag: el.tagName, href: el.getAttribute('href') })) })"}
> browser_evaluate {"function":"() => document.querySelector('SELECTOR_FOR_NEXT_STEP')?.click()"}
```

If `scan_page {}` fails on the Electron target, use this Axe fallback from the same REPL session:

```json
{
  "function": "async () => { if (!window.axe) { await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = 'file:///ABSOLUTE/PATH/TO/node_modules/axe-core/axe.min.js'; script.onload = resolve; script.onerror = () => reject(new Error('Failed to load axe')); document.head.appendChild(script); }); } const results = await window.axe.run(document); return { url: location.href, violations: results.violations.length, incomplete: results.incomplete.length, passes: results.passes.length, inapplicable: results.inapplicable.length, rules: results.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length })) }; }"
}
```
