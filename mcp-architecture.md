# MCP Accessibility Scanner – Internal Architecture

This document describes how the Model Context Protocol (MCP) server in this project wires Playwright automation into an LLM-facing tool surface. It covers lifecycle management, browser interaction primitives, and how individual actions like clicking, typing, or locating elements are implemented.

## 1. Bootstrapping and Connection Lifecycle

### CLI entry points
- `src/program.ts` registers the CLI, parses flags, resolves configuration, and launches transports (`startStdioTransport` for stdio, `startHttpTransport` for SSE/streamable HTTP) before constructing a `Server` (`src/program.ts:18`, `src/program.ts:44`).
- Optional browser-agent support is exposed via `src/browserServer.ts`, which can run separately to host persistent browser profiles over CDP.

### Server and transport wiring
- `Server` owns the resolved `FullConfig` and a shared `BrowserContextFactory`. It provisions a fresh MCP `Connection` per transport session and keeps the connection list for coordinated shutdown (`src/server.ts:9`).
- Transport adapters (`src/transport.ts`) multiplex stdio, SSE (`/sse`), and streamable HTTP (`/mcp`). Each new HTTP session receives a unique session id and is bound to a `Connection`. Closing the HTTP response tears down the connection and browser resources (`src/transport.ts:38`).

### MCP handshake
- `createConnection` builds the Playwright-backed tool catalog and binds request handlers to the MCP server (`src/connection.ts:29`).
- `ListTools` serializes the available tools using `zodToJsonSchema`, while `CallTool` validates modal preconditions before delegating to the per-tool handler (`src/connection.ts:39`, `src/connection.ts:55`).
- The `Connection` tracks the Model Provider’s client version so the server can tailor responses (e.g., embed images only when supported) (`src/connection.ts:85`).

## 2. Configuration Model
- `resolveConfig` merges user overrides with defaults such as Chromium + persistent context (`src/config.ts:77`).
- CLI flags map to structured overrides that control browser selection, network filtering, output directories, trace capture, and tool capability gating (`src/config.ts:114`).
- The final `FullConfig` always contains concrete `launchOptions`, `contextOptions`, networking rules, and server binding details.

## 3. Browser Context Provisioning

### Factories and isolation modes
- `contextFactory` chooses the correct `BrowserContextFactory` implementation based on config flags (persistent user data dir, isolated context, remote CDP endpoint, or browser-agent proxy) (`src/browserContextFactory.ts:31`).
- `BaseContextFactory` caches Playwright `Browser` instances and tears them down when the final context closes (`src/browserContextFactory.ts:47`).
- Persistent mode locks a profile directory, retries on contention, and auto-creates platform-specific cache paths (`src/browserContextFactory.ts:163`).
- Isolated mode launches a fresh in-memory browser; remote and CDP modes attach to pre-existing endpoints (`src/browserContextFactory.ts:99`, `src/browserContextFactory.ts:117`).

### Network policies and tracing
- Once a context is created, `Context._setupBrowserContext` applies network allow/block-lists via Playwright routing before subscribing to page events (`src/context.ts:333`).
- If `saveTrace` is enabled, Playwright tracing starts immediately and is stopped during shutdown (`src/context.ts:341`, `src/context.ts:293`).

## 4. Session Runtime (`Context`)

### State tracked per connection
- The `Context` instance keeps the active tool list, config, lazily created browser context, open tabs, modal state stack, pending action promises, download queue, and client capability flags (`src/context.ts:36`).
- Modal states (dialogs, file choosers) are associated with the owning tab and surfaced to the agent when a tool cannot proceed (`src/context.ts:63`).

### Tab lifecycle
- Each Playwright `Page` is wrapped in a `Tab` that subscribes to console, network, dialog, file chooser, and download events (`src/tab.ts:32`).
- Tab creation ensures a current tab is selected, while closure clears artifacts, updates modal state, and may trigger connection teardown if no tabs remain (`src/context.ts:273`, `src/tab.ts:55`).
- `Tab.navigate` clears instrumentation buffers, handles navigation failures caused by downloads, waits for DOM readiness, and caps the extra load wait to 5 seconds (`src/tab.ts:73`).

### Snapshot capture
- `Tab.captureSnapshot` produces a `PageSnapshot`, which invokes Playwright’s internal `_snapshotForAI` to collect a YAML accessibility tree annotated with `aria-ref` tokens (`src/pageSnapshot.ts:24`).
- `PageSnapshot.refLocator` converts the stored reference into a Playwright locator constrained by `aria-ref` and labeled with a human-readable description for traceability (`src/pageSnapshot.ts:52`).

## 5. Tool Execution Pipeline

### Tool contract
- Tools implement a `handle(context, params)` function that returns `{ code, action?, captureSnapshot, waitForNetwork, resultOverride? }` (`src/tools/tool.ts:49`).
- `defineTool` is a thin helper that preserves typing and emphasizes declarative schema definitions (`src/tools/tool.ts:66`).

### Running a tool
1. `Context.run` validates parameters against the tool’s Zod schema and invokes `handle` (`src/context.ts:135`).
2. If the tool indicated network activity, `waitForCompletion` observes in-flight requests and frame navigations to delay the response until the page settles (`src/tools/utils.ts:21`).
3. When the tool requests snapshot capture, the current tab records an AI snapshot unless JavaScript is blocked by a modal dialog (`src/context.ts:161`).
4. The returned MCP response always contains the executed Playwright code snippet, download summaries, modal warnings (if any), the tab list when multiple tabs are open, and optionally the fresh snapshot text and action-generated artifacts such as images (`src/context.ts:166`).

### Modal gating
- Before running a tool, `CallTool` enforces that only tools marked with `clearsModalState` may run while a dialog or file chooser is active, preventing conflicting interactions (`src/connection.ts:65`).
- Tools that resolve modals (e.g., `browser_handle_dialog`, `browser_file_upload`) remove the modal state once their operation succeeds (`src/tools/dialogs.ts:17`, `src/tools/files.ts:17`).

## 6. Element Interaction Strategies

### Snapshot-driven interactions
- **Click / Double-click:** `browser_click` selects the element using the latest snapshot, generates user-facing Playwright code, and executes either `Locator.click` or `Locator.dblclick` (`src/tools/snapshot.ts:69`).
- **Typing:** `browser_type` fills text or presses sequentially based on the `slowly` flag, with optional submit via Enter (`src/tools/snapshot.ts:169`).
- **Drag & Drop:** `browser_drag` chains `Locator.dragTo` between snapshot-referenced elements (`src/tools/snapshot.ts:101`).
- **Hover & Select Option:** Similar locator-based operations for hover and dropdown selection (`src/tools/snapshot.ts:135`, `src/tools/snapshot.ts:215`).
- Errors raised by stale references fall back to instructing the agent to refresh the snapshot (`src/tools/utils.ts:80`).

### Vision (coordinate) mode
- When `config.vision` is true, `visionTools` replaces snapshot-driven actions with coordinate-based mouse primitives that operate directly on the page viewport (`src/tools.ts:25`).
- Mouse and keyboard events are replayed via Playwright’s low-level APIs (`page.mouse.move/down/up`, `page.keyboard.type`) while still feeding code snippets back to the LLM (`src/tools/vision.ts:89`).
- Coordinate actions skip snapshot capture because the vision client typically consumes separate imagery to reason about the UI.

### Keyboard and wait utilities
- Raw key presses are exposed independently through `browser_press_key`, which acts on the focused element (`src/tools/keyboard.ts:9`).
- `browser_wait_for` lets the agent pause on a timer or wait for specific text to appear/disappear using Playwright locator waits (`src/tools/wait.ts:15`).

## 7. Finding and Describing Elements
- The agent must first call `browser_snapshot` to obtain the accessibility tree with stable `ref` identifiers and human-readable element descriptions (`src/tools/snapshot.ts:24`).
- Subsequent actions require both `element` (for audit logging) and `ref` (for locator resolution). Playwright’s internal `_generateLocatorString` provides the ergonomic “code snippet” representation that is echoed back to the LLM (`src/tools/utils.ts:80`).
- This design keeps the agent honest: it can only operate on elements present in the latest snapshot, and the human-readable description doubles as an explicit permission trail.

## 8. Auxiliary Capabilities

### Accessibility scanning
- `scan_page` builds an `AxeBuilder` with user-supplied WCAG tags, runs Axe in the page, and returns the JSON report in the response body ready for the LLM to interpret (`src/tools/snapshot.ts:244`).

### Screenshots and PDFs
- `browser_take_screenshot` saves an image to disk (JPEG by default, PNG when `raw=true`) and optionally embeds the base64 payload depending on client capabilities (`src/tools/screenshot.ts:17`).
- In vision mode, `browser_screen_capture` always returns a JPEG buffer tuned for bandwidth (`src/tools/vision.ts:26`).

### Console, network, and downloads
- Console messages and network requests accumulate per tab and are formatted on demand via `browser_console_messages` and `browser_network_requests` (`src/tools/console.ts:9`, `src/tools/network.ts:9`).
- Downloads trigger asynchronous tracking so the response can report saved filenames and locations (`src/context.ts:262`). Files are saved under the configured `outputDir`, with helper sanitization for predictable names (`src/tools/utils.ts:72`).

### File uploads and dialogs
- File chooser prompts elevate to modal state; `browser_file_upload` sets the provided files then clears the state (`src/tools/files.ts:17`).
- Dialogs (alert/confirm/prompt) are handled via `browser_handle_dialog`, which accepts or dismisses using the stored `playwright.Dialog` instance (`src/tools/dialogs.ts:17`).

### Tab management
- Agents can query and control tabs using `browser_tab_*` tools, which delegate to `Context.listTabsMarkdown`, `Context.selectTab`, `Context.newTab`, and `Context.closeTab` (`src/tools/tabs.ts:9`).

## 9. Response Shaping and Client Feedback
- Every tool response includes a Markdown fragment showing the exact Playwright instructions executed, aiding auditability (`src/context.ts:166`).
- Additional sections enumerate modal states, downloads, tab summaries, and the target page’s URL/title so the agent can ground subsequent reasoning (`src/context.ts:183`).
- When snapshots are captured, the YAML payload is appended, giving the agent the freshest tree without needing another RPC (`src/context.ts:205`).

## 10. Shutdown and Cleanup
- `Context.close` stops tracing and releases the browser context; `Server.setupExitWatchdog` listens for stdin closure or signals and closes all connections before exiting (`src/context.ts:293`, `src/server.ts:17`).
- Browser factories reset cached browser promises when the underlying browser disconnects, ensuring future sessions recreate healthy instances (`src/browserContextFactory.ts:57`).

## 11. Extending the MCP Server
- New tools can be added by implementing the `Tool` contract, exporting from a module under `src/tools`, and including them in `snapshotTools` or `visionTools` arrays (`src/tools.ts:9`).
- Capability strings allow clients to request narrower tool sets; pass `--caps` to limit surface area at startup (`src/config.ts:140`).
- The modular context factory makes it straightforward to plug in alternative browser provisioning strategies (e.g., remote agents or isolated ephemeral contexts).

## 12. Typical Interaction Flow
1. Client connects via stdio/SSE and calls `ListTools`.
2. Client invokes `browser_navigate` to open a URL; the tab loads and captures a snapshot if configured (`src/tools/navigate.ts:9`).
3. Client requests `browser_snapshot` to fetch the accessibility tree and element refs.
4. Client interacts using element-based actions (`browser_click`, `browser_type`, etc.), each returning updated context and snapshots.
5. Auxiliary tools (wait, console, network, scan_page) enrich the agent’s understanding as needed.
6. When done, the client issues `browser_close` or simply drops the transport; the server cleans up all resources.

This architecture ensures deterministic, observable automation while preserving a rich feedback loop to the LLM, enabling both accessibility auditing and general browser control from the same MCP surface.
