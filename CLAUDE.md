# CLAUDE.md

This file gives coding agents a practical map of this repository.

## What This Repo Is

`mcp-accessibility-scanner` is a TypeScript MCP server built on Playwright + Axe.

- CLI entry: `src/program.ts` (compiled and launched via `cli.js`)
- Library entry: `src/index.ts` (`createConnection`)
- MCP backend: `src/browserServerBackend.ts`
- Runtime browser/session orchestration: `src/context.ts`, `src/tab.ts`
- Tool registry: `src/tools.ts`
- Tool implementations: `src/tools/*.ts`
- MCP transport/helpers: `src/mcp/*`

## Daily Commands

```bash
npm run build
npm run lint
npm run test
npm run test:coverage
npx vitest run tests/<file>.test.ts
```

## Runtime Flow (Mental Model)

1. `src/program.ts` parses CLI options and resolves config via `resolveCLIConfig`.
2. It builds a browser context factory from `src/browserContextFactory.ts`.
3. `BrowserServerBackend` exposes filtered tools to MCP and routes tool calls.
4. Each tool writes through `Response` (`src/response.ts`) for result text/code/images/snapshots.
5. `Context` owns tabs/browser context lifecycle; `Tab` owns page-level state (snapshot refs, console, requests, modal states, downloads).

## Tool System (Important)

- Define tools with `defineTool` or `defineTabTool` in `src/tools/tool.ts`.
- Register new tool modules in `src/tools.ts`.
- `defineTabTool` enforces modal-state safety automatically.
- Tool schemas are Zod, converted to MCP JSON schema in `src/mcp/tool.ts`.

Capability gating in `filteredTools`:
- Always enabled: capabilities starting with `core` (`core`, `core-tabs`, `core-install`)
- Optional via config `capabilities`: `pdf`, `vision`, `verify`

Current tab tools are exposed through:
- `browser_tabs` (`action: list | new | close | select`) in `src/tools/tabs.ts`
- `browser_navigation_timeout`
- `browser_default_timeout`

## Accessibility-Specific Additions In This Fork

- `audit_site` (`src/tools/auditSite.ts`): crawl + aggregate Axe results, writes JSON report.
- `scan_page_matrix` (`src/tools/scanPageMatrix.ts`): multi-variant scan (viewport/media/zoom), writes JSON report.
- `audit_keyboard` (`src/tools/auditKeyboard.ts`): tab-order/focus heuristics, optional issue screenshots, writes JSON report.

All report-producing tools write to `context.outputFile(...)` and sanitize filenames.

## Editing Rules That Matter Here

- Keep Apache copyright headers in source files.
- TS is ESM/NodeNext; internal imports in `.ts` use `.js` suffixes.
- ESLint is strict (`@typescript-eslint/no-floating-promises`, no console, import extension rules, etc.).
- `tsconfig` is strict mode; keep type safety tight.

## Testing Guidance

- Framework: Vitest (`tests/*.test.ts`).
- Most tests mock Playwright/tab/context behavior. Follow existing patterns in `tests/tools-*.test.ts`.
- Coverage thresholds are 90% across lines/functions/branches/statements (see `vitest.config.ts`).
- If you change tool schemas or names, update tests that validate tool definitions and MCP conversion.

## Common Pitfalls

- README may contain stale tool names; rely on `src/tools/*.ts` as source of truth.
- `browser_wait_for` caps `time` wait to 30s internally.
- `browser_take_screenshot` saves full-page images to disk but intentionally does not attach large full-page images to MCP response.
- Timeout tools currently enforce minimum `30_000ms` even though schema descriptions mention `0`.

## When Adding/Changing A Tool

1. Implement in `src/tools/<topic>.ts` using `defineTool`/`defineTabTool`.
2. Add precise Zod schema descriptions (they are surfaced directly to MCP clients).
3. Decide whether to call:
   - `response.setIncludeSnapshot()` (state changed / snapshot needed)
   - `response.setIncludeTabs()` (tab list relevant)
4. Add module export to `src/tools.ts`.
5. Add/update focused Vitest tests under `tests/`.
6. Run `npm run lint` and relevant tests before finishing.
