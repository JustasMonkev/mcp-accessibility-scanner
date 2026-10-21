# Upstream implementation adaptations

Source: [microsoft/playwright](https://github.com/microsoft/playwright/tree/66070a1eaa0b869379607a9e0e1a652ddf2a77da), pinned to `66070a1eaa0b869379607a9e0e1a652ddf2a77da`.

Reviewed source:

- [context.ts, lines 154–158 and 515–524](https://github.com/microsoft/playwright/blob/66070a1eaa0b869379607a9e0e1a652ddf2a77da/packages/playwright-core/src/tools/backend/context.ts#L154): compile-once escaped regex and text replacement.
- [response.ts, lines 172–233](https://github.com/microsoft/playwright/blob/66070a1eaa0b869379607a9e0e1a652ddf2a77da/packages/playwright-core/src/tools/backend/response.ts#L172): response presentation boundaries.
- [secrets.spec.ts, lines 193–216](https://github.com/microsoft/playwright/blob/66070a1eaa0b869379607a9e0e1a652ddf2a77da/tests/mcp/secrets.spec.ts#L193): query, fragment, link and tab-output coverage.
- [tab.ts](https://github.com/microsoft/playwright/blob/66070a1eaa0b869379607a9e0e1a652ddf2a77da/packages/playwright-core/src/tools/backend/tab.ts#L266) and [network.ts](https://github.com/microsoft/playwright/blob/66070a1eaa0b869379607a9e0e1a652ddf2a77da/packages/playwright-core/src/tools/backend/network.ts#L32): one retained request collection, navigation-ID boundary and stable detail lookup.
- [MCP config](https://github.com/microsoft/playwright/blob/66070a1eaa0b869379607a9e0e1a652ddf2a77da/packages/playwright-core/src/tools/mcp/config.ts) and [program](https://github.com/microsoft/playwright/blob/66070a1eaa0b869379607a9e0e1a652ddf2a77da/packages/playwright-core/src/tools/mcp/program.ts): option forwarding reviewed; local empty-list and startup-validation behavior retained.

No pristine common upstream base has been established. This is a partial behavioral port, not a vendored snapshot or a new upstream baseline.

Adopted: compile-once, case-insensitive literal-name regex matching after `?`, `&` or `#`, and text replacement. Names are escaped, not decoded. Values end at upstream delimiters; encoded keys and suffixes after raw quotes/whitespace remain visible. These limits intentionally replace the earlier custom parser's broader matching.

Network adaptation: use one retained collection and a navigation-ID boundary instead of separate current/history maps. Keep a Map and WeakMap rather than upstream's array so detail lookup and response association stay constant-time. Preserve this fork's explicit-navigation reset scope, exact 200-request historical cap, cached responses, redacted headers/bodies and bounded reads. Upstream's extra network options and raw-body output are not imported.

Local adaptations: keep URL-safe `REDACTED` instead of upstream `<redacted>` so Markdown autolinks remain valid. Apply the helper at the MCP boundary and interactive REPL, not a new `Context.redactSecrets` method. Preserve structured property keys and original objects while replacing structured string values; cover session Markdown/snapshots, progress and tool-list display text. Raw reports, resources, schemas and runtime inputs remain unchanged. Arbitrary configured-secret replacement and other upstream features are outside this port. No dependency or configuration-surface changes.

Verification: the full suite passed 1,765 tests with 5 skipped; lint and build passed. The focused network suite passed 129 tests. Removing the navigation-ID guard made a late response overwrite current HTTP 200 with stale HTTP 500; the regression test failed, then passed after restoration. Changed-line slop checks passed. The existing structured JSON transformation remains a reviewed clone heuristic: it transforms JSON string values while preserving keys, not arbitrary JavaScript object types. See [ADR-004](docs/decisions/004-network-history-url-redaction.md) and the [README coverage table](README.md#url-redaction-coverage) for the local contract.
