# ADR-002: Exact-name MCP tool selection

## Decision

Adopt additive exact-name selection for [issue #240](https://github.com/JustasMonkev/mcp-accessibility-scanner/issues/240), following the maintainer's implementation request. On September 28, 2026, [Playwright #42931](https://github.com/microsoft/playwright/pull/42931) is still open; this is an explicit local contract, not a claim of compatibility with a released upstream feature. No dependency change is needed.

The upstream proposal now defines `allowedTools` as additions to enabled capabilities, not a whitelist. Preserve that meaning and existing defaults. `blockedTools` takes precedence, including over normally always-on core, accessibility and session tools. Reject calls as well as hiding listings. `browser_connect` is a known proxy-owned name, not a new browser capability.

Configuration and exact-name semantics are documented in the [README](../../README.md#exact-name-tool-selection). Validation runs on the merged configuration before starting any provider or HTTP listener. Browser tool selection uses the same policy as direct invocation. Both proxy boundaries enforce blocking themselves so a switched provider cannot reintroduce blocked names. Provider limitations, session routing, request metadata, progress and cancellation are unchanged. The initialization instructions and the modal-state guidance derive from the same policy, so neither directs a client to a blocked tool.

## Dynamic page tools

Issue #240 asked how exact-name lists should treat page-registered WebMCP tools (#233/#234). They are outside the policy, and generated names are rejected in both lists.

A generated name hashes a per-process scope id, a per-discovery document id, the document's `timeOrigin` and the registration (`listWebMCPTools`). Configuration is read only at startup, so a name copied from `tools/list` can never match a registration created after the server restarts. Accepting it would pass validation and leave the page tool exposed, the silent no-op that [CODING_STANDARDS.md](../../CODING_STANDARDS.md) section 1 forbids. Startup therefore treats any `webmcp_*` entry as an unknown name and says why.

Two ways to make page tools selectable were considered and left out. Restart-stable names would drop scope and document identity from the name, which is what makes stale registrations and cross-session names fail closed; that is a persistent page-action policy. A runtime policy-update path would be a new control surface. Either needs its own decision. Meanwhile page tools stay discoverable and keep their scope and staleness checks on invocation; wildcards and a restrictive allowlist remain outside this feature.

## Verification

- `tests/tool-policy.test.ts`: defaults, capability additions, overlap, invalid names, rejection of generated WebMCP names, direct-call rejection and MCP transport coverage for browser/extension/direct-proxy/VS Code paths; provider switches and refreshed lists; initialization instructions with and without blocked tools.
- `tests/config.test.ts` and `tests/program.test.ts`: source replacement, explicit empty values, malformed lists, CLI help/dispatch and validation before listeners start.
- `tests/tab.test.ts` and `tests/navigation-dialogs.test.ts`: modal-state guidance when the handler is available and when it is blocked, including a real dialog.
