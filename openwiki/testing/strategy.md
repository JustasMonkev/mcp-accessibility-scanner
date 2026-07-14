# Testing strategy

## Commands

```bash
npm test                 # Vitest suite
npm run test:watch       # local watch mode
npm run test:coverage    # V8 text/json/html/lcov
npm run typecheck        # tsgo --noEmit
npm run lint             # ESLint, then typecheck
npm run build            # compile src/ to lib/
npm run test:mcp         # actual CLI over stdio, existing browsers only
npm run test:mcp:install # direct harness including install behavior
npm run test:docker      # image/CLI/Chromium/HTTP smoke
```

Prefer a focused Vitest file during iteration, then run the relevant broader checks. Node 24 is the package and container baseline (`package.json`, `Dockerfile`).

## Test layers

### Unit and component tests

Most `tests/*.test.ts` files mock Playwright/MCP boundaries and exercise algorithms, schemas, lifecycle decisions, and serialization. High-value groups:

- config/CLI: `config.test.ts`, `program.test.ts`;
- browser/context/tab: `browserContextFactory.test.ts`, `context.test.ts`, `tab.test.ts`;
- protocol: `mcp-http.test.ts`, `mcp-server-*.test.ts`, `mcp-proxyBackend.test.ts`, `mcp-toolListChanged.test.ts`;
- response/tool contracts: `response.test.ts`, `tool-definitions.test.ts`, `mcp-tool.test.ts`;
- domain tools: `tools-auditSite.test.ts`, `tools-scanPageMatrix.test.ts`, `tools-auditKeyboard*.test.ts`, `tools-snapshot.test.ts`;
- utilities/compression: `utils.test.ts`, `tools-utils.test.ts`.

Tests often encode critical nonfunctional invariants: timer caps, restoration in `finally`, no duplicate fallback timers, preservation of CDP defaults, and near-linear parent traversal.

### Filesystem/report integration

`tests/tools-auditSite.integration.test.ts` performs real report writes while mocking browser/Axe work. Use this layer for report naming/serialization/resource-link behavior without paying for a live browser.

### Real browser smoke

`tests/e2e-tools-smoke.test.ts` launches Chromium and checks representative evaluation and advanced audits, including report files, structured content, and resource links. Use it when mocks cannot validate Playwright behavior.

### Direct MCP harness

`.claude/run-mcp-direct-harness.mjs` builds/launches the real CLI over stdio in headless isolated mode, drives fixture pages tool by tool, and records logs/results. It validates packaging, transport, tool discovery, and actual browser interaction as one system. The default skips browser installation; `--include-install` enables it.

### Docker smoke

`tests/docker-smoke.sh` builds the image, checks CLI version, launches Chromium, starts HTTP MCP, and uses the expected 406 response to an incomplete request as readiness. Run it for Dockerfile, package contents, entrypoint, browser dependencies, HTTP startup, or output changes.

## Coverage policy

Vitest uses Node, 30-second test/hook timeouts, six workers, parallel files, and 90% line/function/branch/statement thresholds (`vitest.config.ts`). However, coverage excludes substantial integration-heavy code:

- extension and VS Code;
- browser server/backend, program, config, context, tab, factories, session log;
- MCP infrastructure;
- many Playwright interaction tools.

The percentage therefore measures a selected testable subset, not whole-system confidence. Do not use threshold success as evidence that transport/browser/integration changes are covered; choose the appropriate smoke/harness layer.

## CI reality

`.github/workflows/ci.yml` installs dependencies and Chromium on Node 24, then runs TypeScript checking, lint, tests, and build. Its current trigger is pull requests targeting the literal branch pattern `feat/`. No repository evidence explains that narrow branch policy, so verify intended CI coverage before relying on it for main/default-branch changes.

## Focused change matrix

| Change | Minimum focused validation | Broader validation |
|---|---|---|
| CLI option/config/env precedence | `config.test.ts`, `program.test.ts` | lint, typecheck, build |
| CDP/persistent/isolated ownership | `browserContextFactory.test.ts`, `context.test.ts` | direct MCP harness on relevant target |
| Tab title/snapshot/modal lifecycle | `tab.test.ts`, `response.test.ts` | snapshot/tool smoke |
| HTTP readiness/security/session/heartbeat | `mcp-http.test.ts`, `mcp-server-errors.test.ts` | real HTTP/Docker smoke |
| Tool descriptor/schema | `tool-definitions.test.ts`, corresponding tool test | `list-tools`, direct harness |
| Site audit | audit-site unit + integration | real browser smoke/direct harness |
| Matrix | matrix unit tests | real browser smoke |
| Keyboard | both keyboard test files | real browser smoke/manual review |
| Snapshot/find/compression | snapshot + utils tests | direct harness on large page |
| Extension/VS Code/proxy | proxy/VS Code tests where present | external integration/manual compatibility |
| Packaging/container | build | Docker smoke |

## Regression themes from recent history

Recent fixes reveal the cases most likely to regress:

- **Unbounded waits:** title refresh now has an independent five-second cap; HTTP readiness fallback is single-shot per session.
- **Quadratic processing:** snapshot compression and `browser_find` compute parent relationships once.
- **External-state mutation:** CDP attach/launch uses `noDefaults` to preserve browser settings.
- **Invalid configuration combinations:** mobile is rejected with device/CDP/remote/extension/Firefox combinations.
- **Transport edge cases:** roots readiness, Host/Origin checks, unknown sessions, protocol-vs-tool errors, and heartbeat behavior have dedicated tests.

When optimizing, add an adversarial large/deep input or fake-timer regression test—not only a functional example.

## Before merging

1. Run the closest focused tests.
2. Run `npm run lint` and `npm test` for source behavior changes.
3. Run `npm run build` to verify generated-package compilation.
4. Add real-browser/direct-MCP validation when crossing mocked boundaries.
5. Run Docker smoke for container/package/HTTP changes.
6. Update `README.md`, `SKILL.md`, public types, and examples when user-facing contracts change.
7. Confirm no generated `lib/`, coverage, report, or output artifacts are accidentally committed.
