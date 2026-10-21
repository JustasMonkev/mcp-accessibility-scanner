# Upstream URL-redaction port

Source: [microsoft/playwright](https://github.com/microsoft/playwright/tree/66070a1eaa0b869379607a9e0e1a652ddf2a77da), pinned to `66070a1eaa0b869379607a9e0e1a652ddf2a77da`.

Reviewed source:

- [context.ts, lines 154–158 and 515–524](https://github.com/microsoft/playwright/blob/66070a1eaa0b869379607a9e0e1a652ddf2a77da/packages/playwright-core/src/tools/backend/context.ts#L154): compile-once escaped regex and text replacement.
- [response.ts, lines 172–233](https://github.com/microsoft/playwright/blob/66070a1eaa0b869379607a9e0e1a652ddf2a77da/packages/playwright-core/src/tools/backend/response.ts#L172): response presentation boundaries.
- [secrets.spec.ts, lines 193–216](https://github.com/microsoft/playwright/blob/66070a1eaa0b869379607a9e0e1a652ddf2a77da/tests/mcp/secrets.spec.ts#L193): query, fragment, link and tab-output coverage.

No pristine common upstream base has been established. This is a partial behavioral port, not a vendored snapshot or a new upstream baseline.

Adopted: compile-once, case-insensitive literal-name regex matching after `?`, `&` or `#`, and text replacement. Names are escaped, not decoded. Values end at upstream delimiters; encoded keys and suffixes after raw quotes/whitespace remain visible. These limits intentionally replace the earlier custom parser's broader matching.

Local adaptations: keep URL-safe `REDACTED` instead of upstream `<redacted>` so Markdown autolinks remain valid. Apply the helper at the MCP boundary and interactive REPL, not a new `Context.redactSecrets` method. Preserve structured property keys and original objects while replacing structured string values; cover session Markdown/snapshots, progress and tool-list display text. Raw reports, resources, schemas and runtime inputs remain unchanged. Arbitrary configured-secret replacement and other upstream features are outside this port. No dependency or configuration-surface changes.

Verification: 108 focused tests and 4 native Chromium/MCP tests passed; the full suite passed 1,764 tests with 5 skipped. Lint and build passed. Coverage includes adopted matching, metadata/input preservation, disabled behavior, raw-report exclusions and recorder rewrites. The slop checker flags the structured JSON transformation as a clone; it deliberately transforms JSON string values while preserving keys, not arbitrary JavaScript object types. See [ADR-004](docs/decisions/004-network-history-url-redaction.md) and the [README coverage table](README.md#url-redaction-coverage) for the local contract.
