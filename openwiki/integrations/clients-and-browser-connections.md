# Clients and browser integrations

## Integration map

The same `BrowserServerBackend` and tools can be reached through several boundaries:

| Boundary | Main source | Intended use |
|---|---|---|
| stdio MCP | `src/program.ts`, `src/mcp/server.ts` | Claude Desktop/Code, VS Code, and other local MCP clients. |
| Streamable HTTP MCP | `src/mcp/http.ts` | local/session-based HTTP clients; unauthenticated. |
| interactive CLI | `src/program.ts` | manual and agent direct automation without an MCP client. |
| programmatic SDK server | `src/index.ts` | embedding with config or a custom Playwright context getter. |
| browser extension | `src/extension/*` | control an existing Chrome/Edge instance through bridge extension/CDP relay. |
| VS Code | `src/vscode/*` | proxy tools to a browser exposed by the VS Code integration. |
| CDP attach/launch | `src/browserContextFactory.ts` | existing Chromium browser or launched Electron/desktop app. |
| Docker | `Dockerfile`, `docker-compose.yaml` | isolated headless Chromium deployment. |

## MCP clients

Default CLI invocation is stdio MCP, not a manual shell command interface:

```bash
npx mcp-accessibility-scanner
```

`interactive` is the direct tool REPL and is the required mode in `SKILL.md`. `list-tools` prints currently enabled descriptors. Tool names such as `browser_navigate` are MCP identifiers/REPL commands, not standalone subcommands.

The server advertises tool-list-change support, a human title, and instructions emphasizing audit tools. Client roots influence default output/profile locations. For HTTP, root discovery is delayed until the event stream is ready or the POST fallback fires.

## Programmatic embedding

`createConnection(userConfig, contextGetter?)` in `src/index.ts` returns an SDK `Server`; the caller connects its transport. A custom getter lets an embedding supply a Playwright `BrowserContext`, but the scanner's wrapper closes that context during teardown. Treat that as ownership transfer unless the API is changed.

The library export surface is `index.js`/`index.d.ts`, and config types are `config.d.ts`. Source-only changes that alter these contracts must keep package-root types in sync.

## Existing browser via extension

`ExtensionContextFactory` starts a local CDP relay and connects Playwright to its endpoint (`src/extension/extensionContextFactory.ts`). `src/extension/cdpRelay.ts`:

- hosts HTTP/WebSocket endpoints locally;
- launches the fixed-ID Playwright MCP Bridge extension page;
- forwards CDP commands/events between Playwright and the extension;
- exposes the resulting default browser context.

`src/extension/protocol.ts` defines protocol version 1 and command/event messages. This repository does not contain the bridge extension implementation or a visible end-to-end protocol compatibility suite, so coordinate protocol changes with the external extension.

Extension mode is selected by `--extension`, only supports Chrome/Edge-family targets, and is incompatible with mobile emulation.

## VS Code and provider switching

`src/vscode/host.ts` exposes a proxy backend and a programmatic `browser_connect`. Switching starts a child stdio server connected to the VS Code extension's browser and can emit tool-list-changed when descriptors differ (`src/vscode/main.ts`, `src/mcp/proxyBackend.ts`).

The hidden `--connect-tool` path similarly offers standalone and extension providers over in-process transports. `ProxyBackend` closes the previous downstream MCP client before switching and forwards roots and progress.

`src/mcp/mdb.ts` supports a debugger-style stack where later downstream tool servers shadow earlier ones and are popped until a requested tool is found.

## Existing CDP endpoint

Configure `browser.cdpEndpoint`, `--cdp-endpoint`, or `PLAYWRIGHT_MCP_CDP_ENDPOINT`. Optional connection headers and timeout support authenticated/proxied endpoints.

Important semantics:

- Chromium-family only;
- `noDefaults: true` preserves the target browser's default-context settings;
- non-isolated mode uses the first existing context;
- scanner close disconnects Playwright rather than closing the external context;
- device/mobile emulation is rejected on this path.

The first-context assumption is important for unusual CDP targets. Add focused tests before supporting targets that expose no context.

## Launching Electron or a desktop app

`--cdp-launch-command` spawns a command, substitutes `{port}` in configured args, polls `http://127.0.0.1:<port>`, and attaches via CDP. A free port is chosen if none is configured. The child receives SIGTERM on timeout and normal close (`src/browserContextFactory.ts`).

Example shape:

```bash
npx mcp-accessibility-scanner \
  --cdp-launch-command /path/to/app \
  --cdp-launch-args "--remote-debugging-port={port}" \
  interactive
```

`SKILL.md` is the canonical recipe source for Electron. Some Electron targets reject Axe target creation; its documented fallback is to select the live app tab and inject the local Axe bundle through `browser_evaluate`.

## Remote Playwright endpoint

`browser.remoteEndpoint` connects through Playwright's protocol, appending browser name and launch options to the endpoint URL, then creates a fresh context. This differs from CDP: it can select the configured Playwright browser type and follows context ownership rather than attaching to an external default context.

Mobile emulation is currently rejected with remote endpoints.

## Docker integration

The image packages Chromium and exposes 8931. Compose starts Streamable HTTP and binds it to host loopback. Output is mounted from `./output` to `/app/output`.

Security boundary: Docker packaging does not add MCP authentication. Publishing port 8931 beyond loopback grants browser automation and local artifact capabilities to any reachable client.

## Integration change checklist

- Preserve transport-independent backend/tool behavior.
- Be explicit about who closes browser, browser context, child process, downstream client, and server.
- Test tool-list changes and progress forwarding when proxying.
- Keep extension protocol version synchronized with the external bridge.
- Preserve CDP external defaults and context ownership.
- Validate configuration conflicts before launching expensive processes.
- Document filesystem visibility for report links and mounts.
