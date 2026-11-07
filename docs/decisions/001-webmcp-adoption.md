# ADR-001: Page-registered WebMCP adoption

## Status

Accepted. The September 8, 2026 decision deferred adoption. [PR #242](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/242) adopted a bounded dynamic-tool implementation following the maintainer's request in [#233](https://github.com/JustasMonkev/mcp-accessibility-scanner/issues/233). [PR #287](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/287) added native WebMCP object input.

## Historical decision

For [#216](https://github.com/JustasMonkev/mcp-accessibility-scanner/issues/216), [Playwright #42613](https://github.com/microsoft/playwright/pull/42613) was still an unmerged experimental proposal. The server owned its own tool registry and existing accessibility scans did not require WebMCP. The decision was to defer, not permanently decline, and to require a concrete audit-setup use case, deliberate scope and explicit execution/trust boundaries before adoption.

The [original decision](https://github.com/JustasMonkev/mcp-accessibility-scanner/blob/d7aa4c849ed26500412806672ed4e00e24ddaa17/docs/decisions/001-webmcp-adoption.md) records the alternatives and full historical conditions, including the preference for an opt-in capability at that time.

## Adopted approach

After [Playwright #42671](https://github.com/microsoft/playwright/pull/42671) merged, the maintainer requested implementation. A client can invoke a page's application-state preparation tool before running the existing accessibility audits. Discovery is dynamic when the page already supports WebMCP; browser launch flags, dependencies and built-in tool identifiers stay unchanged.

[The integration contract](../webmcp.md) specifies scope-specific names, metadata-based session selection that does not overwrite page arguments, conservative safety annotations, bounded discovery and invocation, stale-selection rejection and list-change notifications. Page registration never authorizes consequential actions. No automatic retry is allowed after an uncertain timeout or cancellation.

This implementation differs from both the earlier opt-in proposal and a mechanical upstream copy. Its dynamic tool names include scope/frame/registration identity; routing is outside page arguments; page safety hints are not trusted. The existing scanner snapshot format is not replaced.

## Validation boundary

Focused regression tests and a Chromium API fixture cover the bridge's contracts. Separate native Chromium tests exercise discovery and invocation; see the [documented test coverage and browser versions](../webmcp.md#verification).
