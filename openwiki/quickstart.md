# MCP Accessibility Scanner: Quickstart

## What this repository is

MCP Accessibility Scanner is a Node.js 24+ / TypeScript Model Context Protocol server that combines a real Playwright browser with Axe-based accessibility analysis. MCP clients can navigate and manipulate pages, inspect accessibility snapshots, run WCAG scans, crawl sites, compare responsive/media variants, audit keyboard behavior, and receive reports and browser artifacts.

The product has two overlapping surfaces:

- **Accessibility analysis:** `scan_page`, `audit_site`, `scan_page_matrix`, and `audit_keyboard` turn browser state into Axe findings, heuristic keyboard observations, JSON reports, and concise MCP structured content.
- **Browser automation:** navigation, snapshots, ref-based interaction, forms, tabs, console/network inspection, screenshots, PDFs, waits, and optional assertions make it possible to reach and verify the state to audit.

The published package is `mcp-accessibility-scanner`; both configured binary names, `mcp-accessibility-scanner` and `mcp-server-playwright`, point to `cli.js` (`package.json`). Source code lives in `src/`; `lib/` is generated build output and should not be edited.

## Start here

Requirements: Node.js 24 or newer and npm.

```bash
npm ci
npx playwright install chromium
npm run build
npm test
```

Useful development commands:

```bash
npm run typecheck        # TypeScript without emit
npm run lint             # ESLint plus typecheck
npm test                 # full Vitest suite
npm run test:coverage    # V8 coverage with configured thresholds
npm run test:mcp         # direct stdio MCP harness
npm run test:docker      # build/run container smoke test
```

Run modes:

```bash
node cli.js                         # MCP server over stdio (default)
node cli.js interactive             # manual <tool-name> <json> REPL
node cli.js list-tools              # discover enabled tools
node cli.js --headless interactive  # common local development mode
node cli.js --port 8931             # MCP Streamable HTTP at /mcp
```

`cli.js` loads `lib/program.js`, so build first after source changes. Installed-package examples use `npx mcp-accessibility-scanner ...`; repository development can use `node cli.js ...` after `npm run build`.

## Minimal audit

In interactive mode:

```text
> browser_navigate {"url":"https://example.com"}
> scan_page {"violationsTag":["wcag21aa","wcag22aa"]}
> audit_keyboard {"maxTabs":30}
> browser_close {}
```

For a broader audit, use `audit_site`; for responsive and media-state comparison, use `scan_page_matrix`. These advanced workflows create versioned JSON reports and return report metadata through MCP. See [Auditing and automation workflows](workflows/auditing-and-automation.md).

## Mental model

1. `src/program.ts` resolves configuration and selects stdio, HTTP, extension, VS Code, or connection-switch startup.
2. Each MCP connection/session owns a `BrowserServerBackend` and a lazy `Context`.
3. `Context` obtains a Playwright browser context only when a tool needs one, then owns ordered `Tab` wrappers.
4. A tool validates its Zod schema, operates on the context/current tab, and fills a `Response`.
5. `Response.finish()` may refresh titles or capture an ARIA snapshot; serialization returns markdown, resource links, images, structured content, and error state.

Read [Architecture overview](architecture/overview.md) for ownership and lifecycle details.

## Repository navigation

| Need | Start here |
|---|---|
| Understand startup, MCP sessions, browser ownership, and responses | [Architecture overview](architecture/overview.md) |
| Find the source or tests for a feature | [Source map](architecture/source-map.md) |
| Understand tools, Axe findings, snapshots, refs, and report contracts | [Accessibility and tool domain](domain/accessibility-and-tools.md) |
| Run or modify scans, crawls, matrices, keyboard audits, or browser interactions | [Auditing and automation workflows](workflows/auditing-and-automation.md) |
| Configure browsers, CDP, networking, HTTP, output, Docker, or troubleshoot runtime failures | [Configuration and runbook](operations/configuration-and-runbook.md) |
| Work on MCP clients, programmatic API, extension, VS Code, or Electron | [Clients and browser integrations](integrations/clients-and-browser-connections.md) |
| Choose tests and understand CI/coverage boundaries | [Testing strategy](testing/strategy.md) |

Primary user documentation remains `README.md`; direct-automation recipes and the Electron fallback are in `SKILL.md`. This wiki explains the source relationships and change impact rather than duplicating those references.

## Design direction from recent history

The repository began as a focused accessibility scanner and later absorbed a broader Playwright MCP architecture. Recent work shows three priorities:

- **Richer audit workflows:** multi-page, matrix, and keyboard audit tools were added together, then refined with progress reporting, RE2-backed patterns, fewer browser round trips, and compact occurrence fingerprints.
- **Upstream alignment and connection flexibility:** mobile emulation, `browser_find`, status reporting, CDP launch/attach, extension, VS Code, and proxy backends mirror or build on Playwright MCP behavior.
- **Bounded resource use and safer defaults:** recent fixes cap title refreshes, avoid quadratic snapshot/find processing, limit HTTP fallback timers to one per session, preserve attached-browser defaults with CDP `noDefaults`, and bind Compose HTTP to localhost.

When changing hot paths, treat bounded time and near-linear processing as explicit design constraints.

## Working conventions

- Edit `src/`, not generated `lib/`; update `README.md` when behavior, commands, configuration, or tool surfaces change (`AGENTS.md`).
- Preserve published package/binary names and exported MCP tool names unless a breaking change is intentional.
- Put behavior tests near the corresponding `tests/*.test.ts`; use targeted tests first, then lint/typecheck and broader suites.
- Audit tools are operationally destructive: they can navigate, open/close tabs, change viewport/media/zoom, move focus, scroll, and write artifacts.
- Snapshot refs are ephemeral. Validate behavior against fresh snapshots and expect stale refs after page state changes.
- Never expose the unauthenticated HTTP transport to untrusted networks; Docker Compose binds host port 8931 to loopback intentionally.

## Backlog

- **Browser extension compatibility testing** — `src/extension/`; protocol and relay behavior are documented, but no repository-local end-to-end compatibility suite for the external bridge extension was found.
- **Release/publishing pipeline** — `package.json` and `README.md`; npm packaging is clear, while Docker Hub documentation and the GHCR-default multiarch script suggest multiple image paths whose authoritative release process is not documented.
- **MCP initialization/concurrency guarantees** — `src/mcp/server.ts` and `src/browserServerBackend.ts`; failure and concurrent-call semantics need design confirmation before documenting stronger guarantees.
- **Debugger backend** — `src/mcp/mdb.ts`; it is not connected to the normal CLI path, so its intended consumer and lifecycle remain deferred.
