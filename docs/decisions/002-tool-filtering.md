# ADR-002: Exact-name MCP tool selection

## Decision

Adopt additive exact-name selection for [issue #240](https://github.com/JustasMonkev/mcp-accessibility-scanner/issues/240), following the maintainer's implementation request. On September 28, 2026, [Playwright #42931](https://github.com/microsoft/playwright/pull/42931) is still open; this is an explicit local contract, not a claim of compatibility with a released upstream feature. No dependency change is needed.

The upstream proposal now defines `allowedTools` as additions to enabled capabilities, not a whitelist. Preserve that meaning and existing defaults. `blockedTools` takes precedence, including over normally always-on core, accessibility and session tools. Reject calls as well as hiding listings. `browser_connect` is a known proxy-owned name, not a new browser capability.

Configuration and exact-name semantics are documented in the [README](../../README.md#exact-name-tool-selection). Validation runs on the merged configuration before starting any provider or HTTP listener. Browser tool selection uses the same policy as direct invocation. Both proxy boundaries enforce blocking themselves so a switched provider cannot reintroduce blocked names. Provider limitations, session routing, request metadata, progress and cancellation are unchanged.

## Dynamic page tools

Unlike the current upstream patch, which rejects all non-built-in names, accept complete generated WebMCP identifiers in both lists. Startup can validate their shape but cannot validate registrations in pages or sessions that do not exist yet. Invocation retains the existing scope and stale-registration checks. Allowed names do not grant availability; blocked names are rejected before session lookup or browser activity.

The browser observer compares the filtered catalog, so changes affecting only hidden tools need no notification. Proxies retain downstream list-change notifications and filter every refreshed list. Exact matching intentionally does not survive an identity change: a page action with a new registration identity is a different name. Wildcards, a persistent page-action policy, and a restrictive allowlist are outside this feature.

## Verification

- `tests/tool-policy.test.ts`: defaults, capability additions, overlap, invalid names, direct-call rejection and MCP transport coverage for browser/extension/direct-proxy/VS Code paths; provider switches and refreshed lists.
- `tests/config.test.ts` and `tests/program.test.ts`: source replacement, explicit empty values, malformed lists, CLI help/dispatch and validation before listeners start.
- `tests/webmcp-backend.test.ts`: real generated names, blocking before session routing, changed registrations and filtered observer notifications.
