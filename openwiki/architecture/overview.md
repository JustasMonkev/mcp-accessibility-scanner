# Architecture overview

## System shape

The runtime is a layered MCP-to-browser adapter:

```text
MCP client / interactive CLI / library caller
                |
      stdio or Streamable HTTP
                |
       src/mcp/server.ts
                |
    BrowserServerBackend (per connection/session)
                |
       Context (lazy browser session)
                |
 BrowserContextFactory -> Playwright BrowserContext
                |
         Tab -> Playwright Page
                |
 Tool handler -> Response -> MCP result/artifacts
```

The boundary between MCP infrastructure and browser behavior is `ServerBackend` (`src/mcp/server.ts`). `BrowserServerBackend` implements it using the browser-specific context and tool registry (`src/browserServerBackend.ts`).

## Entrypoints and startup

### Published CLI

`cli.js` imports `lib/program.js`. `src/program.ts` defines global Commander options and three visible modes:

- no subcommand: start MCP, using stdio unless `--port` is set;
- `interactive`: construct a backend directly and execute `<tool-name> <json>` lines;
- `list-tools`: resolve configuration and print enabled descriptors.

Hidden `--connect-tool` and `--vscode` paths support proxy/integration flows. Selection order in the default action is extension, VS Code, connection switch, then normal browser backend (`src/program.ts`).

### Programmatic API

`createConnection(config, contextGetter?)` in `src/index.ts` returns an unconnected SDK `Server`. Without a getter it uses the normal factory selection; with a getter it wraps the supplied Playwright context and assumes ownership by closing it on teardown.

## MCP connection lifecycle

`src/mcp/server.ts` creates an SDK `Server`, registers tool list/call handlers, and gates both on backend initialization. On the MCP `initialized` event it:

1. checks client capabilities;
2. waits for transport readiness before requesting roots;
3. requests roots with a two-second timeout;
4. records client name/version;
5. initializes the backend;
6. releases queued list/call requests.

`BrowserServerBackend.initialize()` uses the first root URI as `rootPath`, optionally creates a `SessionLog`, and creates a `Context`. Browser launch remains lazy.

Unknown tool names are protocol `InvalidParams` errors. Zod validation and execution failures are returned as MCP tool results with `isError`, allowing clients to distinguish protocol misuse from failed browser work.

### Transport ownership

- **Stdio:** one server/backend connection; no heartbeat.
- **Streamable HTTP:** each initial POST creates a UUID session, transport, backend, and context. Sessions are removed on close. The only endpoint is `/mcp`.
- **In-process:** paired transport used by proxy/debugger composition without a socket.

HTTP initialization waits for the event-stream GET before root discovery. Clients that only POST are released by one five-second fallback timer per session. The first HTTP tool call starts heartbeat pings; `PLAYWRIGHT_MCP_PING_TIMEOUT_MS <= 0` disables them (`src/mcp/http.ts`, `src/mcp/server.ts`).

## Runtime ownership

### `BrowserServerBackend`

Owns the filtered tool list, one `Context`, and optional session log. A call:

1. finds the tool and parses its Zod schema;
2. creates `Response`;
3. marks the context's running tool name;
4. invokes the handler;
5. performs deferred response work;
6. records the response when session logging is enabled;
7. clears the running marker and serializes.

### `Context`

`Context` owns browser-session state (`src/context.ts`):

- lazy browser-context creation promise;
- `Tab[]` and selected tab;
- context factory and client metadata;
- origin routing, tracing, and input recorder setup;
- process-global registration for shutdown cleanup.

Creation failures clear the cached promise so a later operation can retry. Closing the final page starts browser-context shutdown; a later tool can create a new context. Closing and creation are deliberately separated, and creation during active close fails with `Another browser context is being closed.`

### `Tab`

`Tab` wraps a Playwright `Page` and tracks title, main-document HTTP status, console/page errors, requests/responses, downloads, dialogs/file choosers, and snapshots (`src/tab.ts`). It applies configured navigation/default timeouts and makes page-state reads best effort.

Important bounded operations:

- navigation waits for `domcontentloaded`, then waits at most five seconds for `load`;
- snapshot/title reads use the current runtime default timeout, with non-positive values falling back to five seconds;
- title refresh is capped at five seconds even if the configured default is larger;
- modal states race page-state reads so a blocking dialog does not hang response generation.

## Browser factory strategies

`contextFactory()` chooses exactly one strategy in this order (`src/browserContextFactory.ts`):

1. remote Playwright endpoint;
2. launch a Chromium-family app and attach over CDP;
3. attach to an existing CDP endpoint;
4. isolated browser/context;
5. persistent browser profile (default).

Isolated/remote factories may share a launched browser while contexts exist. Persistent mode uses an explicit data directory or a stable profile keyed by browser and client-root hash. CDP non-isolated mode reuses the external browser's first context and disconnects rather than closing that context. CDP connections pass `noDefaults: true` so Playwright does not overwrite target-browser defaults.

See [Configuration and runbook](../operations/configuration-and-runbook.md) for operating each strategy.

## Tool and response architecture

`src/tools.ts` statically aggregates tools. Capabilities beginning with `core` are always visible; optional tools require configured capabilities such as `vision`, `pdf`, or `verify`. `defineTabTool` in `src/tools/tool.ts` also enforces modal-state rules.

`Response` (`src/response.ts`) is both accumulator and presentation boundary. A serialized result can contain:

- markdown result text and generated Playwright code;
- tab list and current ARIA snapshot;
- local `file://` resource links;
- image attachments unless `imageResponses` is `omit`;
- structured content for machine consumers;
- `isError`.

Snapshot collection is deferred until `finish()`, so mutating tools can request fresh post-action state. Title refreshes run concurrently and settle independently.

## Evolution and design rationale

Recent history is best read as hardening of state-heavy MCP work:

- `audit_site`, `scan_page_matrix`, and `audit_keyboard` established accessibility reporting as a first-class domain, then added progress and reduced browser/aggregation overhead.
- `browser_find` and snapshot compression were optimized from repeated ancestor scans to parent-index passes, avoiding quadratic work on large ARIA trees (`src/tools/snapshot.ts`, `src/utils/ariaCompression.ts`).
- HTTP root readiness was tightened and its POST fallback timer made per-session and single-shot (`src/mcp/http.ts`).
- CDP attach/launch now uses `noDefaults` to preserve external app/browser settings (`src/browserContextFactory.ts`).
- Response title refreshes are capped because a large user timeout should not make every tool response wait that long on an unresponsive page (`src/tab.ts`).

These changes imply three architectural invariants: external browser state should be preserved, bookkeeping must not dominate large-page work, and response/session liveness must have independent bounds.

## Change hazards

- Backend initialization exceptions are logged but do not resolve the initialization gate; avoid introducing failure paths without deciding how queued requests terminate (`src/mcp/server.ts`).
- `_runningToolName` is one scalar, not a call mutex. Do not assume concurrent call behavior without tests or an explicit serialization contract.
- Request cancellation metadata reaches the backend, but most browser handlers do not consume the per-request abort signal.
- Final-tab closure starts context shutdown without awaiting it; tab lifecycle tests are important around close/reopen changes.
- Session log writes are debounced; shutdown does not expose an explicit awaited flush in the backend.
