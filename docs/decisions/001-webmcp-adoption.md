# ADR-001: Defer page-registered WebMCP tools

## Status

Proposed for maintainer acceptance through this PR. Decision: defer implementation, not decline the feature permanently.

## Context

Reviewed on 2026-09-08 for [issue #216](https://github.com/JustasMonkev/mcp-accessibility-scanner/issues/216).
[Playwright PR #42613](https://github.com/microsoft/playwright/pull/42613) was open and unmerged at the time of review. Its [reviewed implementation](https://github.com/microsoft/playwright/blob/c459274bd151e9791f8ef7e7589207ddda482ee5/packages/playwright-core/src/tools/backend/webmcp.ts) adds discovery and invocation of page-registered tools, plus a navigation hint. The proposal requires experimental browser flags and supports differing Chromium and Firefox API shapes.

This server owns its [tool registry](../../src/tools.ts) and [capability types](../../config.d.ts). A Playwright upgrade alone does not expose these tools. No existing accessibility scan requires them. They could help prepare application state before an audit, but that use case does not yet justify a default public API expansion.

## Decision

Do not add `browser_webmcp_list`, `browser_webmcp_call`, navigation discovery, browser flags, or dependencies in this change. Keep the existing tool surface and browser defaults unchanged.

If adopted later, prefer an explicit opt-in `webmcp` capability over upstream's `core` classification. Page registration is not permission to invoke a tool. Page-supplied names, descriptions, schemas, annotations, and results remain untrusted data; a claimed read-only annotation must not change the server's action classification or authorize a consequential call.

## Conditions for revisiting

A follow-up adoption proposal should identify a concrete audit-setup use case and settle these contracts before implementation:

- **Capability and browser setup:** gate discovery, invocation, and any navigation hint together. Document supported browser versions and required flags without silently changing existing launches or attached browsers. Distinguish an absent API from an empty tool list.
- **Frame identity:** address the registering frame, including duplicate names and duplicate frame URLs. Reject ambiguous or stale selections after navigation, detachment, or frame replacement; do not silently invoke a different frame's tool.
- **Execution limits:** bound discovery and invocation, including concurrency and output size. Clean up timers and listeners. A timeout must not imply that a consequential page action was cancelled or rolled back, and must not trigger an automatic retry.
- **Failures and trust:** distinguish unsupported APIs, partial discovery, failed invocation, and page-returned failures. Preserve page error payloads as untrusted results without reporting them as successful actions or promoting page annotations to trusted MCP metadata.

The reviewed upstream listing bounds each frame probe to five seconds but treats timed-out or failed probes as contributing no tools. Its invocation uses `frame.evaluate` inside `waitForCompletion`. This repository's [completion helper](../../src/tools/utils.ts) bounds settling, not an indefinitely pending callback. Adoption therefore needs explicit partial-discovery and invocation-deadline behavior, not just a copied handler.

Verification must cover absent support, empty and partial listings, duplicate tool names across same-URL frames, stale frame identities, hanging discovery and calls, page-tool failures, and misleading annotations. Use reproducible browser fixtures against a pinned API revision; upstream merge status alone is not proof that these contracts are satisfied.

## Alternatives and consequences

- **Adopt as core now:** mirrors upstream, but adds default discovery and invocation for an experimental API unrelated to required scan behavior. Not selected.
- **Implement opt-in now:** limits exposure and is the preferred future shape, but still requires the contracts and browser evidence above. Deferred.
- **Decline permanently:** avoids maintenance but rules out a potentially useful audit-setup integration without evidence. Not selected.

This decision adds no runtime behavior. Revisit when a maintainer sponsors a concrete use case and a follow-up design addresses the listed contracts; no polling service or speculative implementation is introduced.
