# Configuration and runbook

## Configuration precedence

CLI startup resolves configuration in this order (`src/config.ts`):

```text
defaults < JSON config file < environment < explicit CLI options
```

Only defined values override prior values; browser launch/context, network, server, and timeout objects are merged. Programmatic `resolveConfig()` uses defaults plus caller config only.

Defaults include Chromium with Chrome channel, headed except Linux without `DISPLAY`, sandbox enabled, viewport `null`, 60-second navigation timeout, five-second operation timeout, and tracing off. Internal `assistantMode` is forced on. Non-Chromium browsers have channel removed.

Mobile emulation is inserted at the precedence level where `mobile` originated, allowing later explicit fields to override device defaults. It uses Pixel 10 for Chromium and iPhone 17 for WebKit. It is rejected with explicit device, Firefox, extension mode, CDP attach/launch, or remote endpoint.

The full public shape is in `config.d.ts`; user examples are in `README.md`. Do not document or copy live secret-bearing config values.

## Browser connection strategies

Factory selection is ordered (`src/browserContextFactory.ts`):

| Strategy | Trigger | Ownership/notes |
|---|---|---|
| Remote Playwright | `browser.remoteEndpoint` | Connects to remote browser and creates a new context. |
| Launch then CDP attach | `browser.cdpLaunch` / CLI launch flags | Spawns app, polls endpoint, attaches, SIGTERMs child on close/timeout. |
| Existing CDP | `browser.cdpEndpoint` | Chromium only; reuses first context unless isolated; disconnects without closing external context. |
| Isolated | `browser.isolated` / `--isolated` | In-memory new context; suitable for concurrent instances. |
| Persistent | default | Stable on-disk profile keyed by browser and client-root hash unless `userDataDir` is explicit. |

CDP attach/launch passes `noDefaults: true` to preserve external browser defaults. Headers combine client-derived User-Agent with configured CDP headers. `PLAYWRIGHT_MCP_CDP_HEADERS` is newline-separated so commas inside header values survive; repeated `--cdp-header` flags use `Name: Value` form.

Persistent launch retries profile-lock/`Invalid URL` failures five times, one second apart, then recommends `--isolated`. Closing final tab releases the browser context; the next browser tool can create another.

## Stdio and HTTP operation

No port means stdio and is the normal MCP-client mode. `--port` enables unauthenticated Streamable HTTP at `/mcp`; default host is `localhost` (`src/mcp/server.ts`, `src/mcp/http.ts`).

HTTP protections:

- only `/mcp` is routed;
- Host must be loopback or the concrete bound address;
- browser Origin, when supplied, must match Host authority and scheme exactly;
- wildcard bind addresses are not accepted as Host values themselves;
- unknown session IDs return 404;
- heartbeat closes nonresponsive sessions unless disabled with non-positive `PLAYWRIGHT_MCP_PING_TIMEOUT_MS`.

These checks are not authentication. Keep the endpoint behind a trusted local boundary or add an external authenticated proxy. Compose intentionally publishes `127.0.0.1:8931:8931`; do not broaden it casually.

Readiness note: root discovery waits for the client's event-stream GET. POST-only clients are allowed through after a single five-second fallback per session, potentially without roots.

## Network policy inside the browser

`allowedOrigins` installs a catch-all abort route followed by allow routes. `blockedOrigins` installs abort routes afterward, so blocking remains dominant (`src/context.ts`). Service-worker blocking is available because service workers can bypass normal route interception.

Test allow/block combinations whenever changing route order; browser routing priority is behaviorally significant.

## Output, reports, traces, and sessions

Output path resolution (`src/config.ts`):

1. explicit output directory;
2. `<first-client-root>/.playwright-mcp`;
3. timestamped OS temp directory.

Names are sanitized. Advanced audits, screenshots, PDFs, downloads, traces, and optional session logs rely on this boundary.

- `--save-trace`: starts Playwright tracing when context setup completes and stops it before context close.
- `--save-session`: creates a session log and input recorder; response writes are debounced.
- `--image-responses omit`: suppresses image attachments but not file creation/resource links.

For Docker, mount `/app/output`; otherwise artifacts disappear with the container.

## Docker runbook

The multi-stage `Dockerfile` builds with Node 24, prunes dev dependencies, installs Chromium and system dependencies, then runs as non-root user `mcp`. Runtime defaults are headless Chromium, output `/app/output`, and entrypoint `node cli.js --no-sandbox`.

```bash
npm run test:docker
# or

docker compose up -d
```

The healthcheck POSTs an intentionally incomplete MCP request and treats HTTP 406 as readiness. Compose adds HTTP host/port/browser/output arguments and mounts `./output`.

## Troubleshooting

### Browser executable missing

The factory rewrites Playwright's missing-executable error with install/change-config guidance. Install the configured browser or run the direct harness with installation enabled:

```bash
npm run test:mcp:install
```

### Persistent profile already in use

Wait for the previous process to close, choose a different `--user-data-dir`, or use `--isolated`. Do not delete a profile that may belong to a running browser.

### Browser context is being closed

Closing the last tab starts asynchronous context shutdown. Wait before issuing the next browser-creating action; context creation during close is rejected intentionally.

### CDP app fails to become ready

Check command, `{port}` substitution, cwd, app support for Chromium remote debugging, startup timeout, and CDP connection timeout. On timeout the child receives SIGTERM. Mobile/device emulation is not supported on these paths.

### HTTP client hangs during initialization

Ensure the client opens the Streamable HTTP event stream and answers server pings. POST-only clients incur the fallback delay. For proxies that cannot answer server-initiated pings, set `PLAYWRIGHT_MCP_PING_TIMEOUT_MS=0` with awareness that dead-session detection is then disabled.

### Tool response waits on an unhealthy page

Page-state reads are bounded; title refresh is capped at five seconds regardless of a larger default operation timeout. If a response still stalls, inspect the tool operation itself, pending browser modal, MCP heartbeat, and external CDP target.

### Reports exist but the client cannot open links

Report links are local `file://` URLs. Confirm client and server share the filesystem. For remote clients, copy/serve artifacts through a separate trusted mechanism.

## Operational change checklist

- Update `config.d.ts`, CLI/env parsing, merge tests, validation tests, and README together for new settings.
- Preserve external CDP context ownership and default settings.
- Keep all waits/timers per-session or per-operation and clear or bound them.
- Re-run HTTP security/routing tests for transport changes.
- Run Docker smoke for image, entrypoint, browser install, output, or HTTP changes.
- Confirm cleanup under normal close, signal handling, and failure; process shutdown has a 15-second watchdog.
