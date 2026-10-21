# ADR-004: Retained network diagnostics and URL presentation

## Status

Accepted, 2026-10-21. Implements #289 and #290 without changing browser dependencies.

## Context

The previous request list reset on explicit `browser_navigate` and assigned positions starting at one. Reusing an old index after navigation could select an unrelated request. Login redirects and multi-page audits also lost earlier diagnostics. URLs in tool output and session files could include query or fragment grant values, independent of the existing header/body redaction policy.

## Decisions

Keep the default request-list scope: explicit `browser_navigate` starts a new list; link clicks, form submissions and history changes keep appending. Add `all: true` to include the most recent 200 earlier requests plus current requests. The current list retains its existing uncapped behavior. Retention is per tab within its browser session, not shared across tabs or sessions.

Assign monotonically increasing tab-lifetime IDs. Keep the public detail argument named `index`, but resolve it by retained ID instead of array position. Both list modes use the same IDs. Eviction removes the oldest historical IDs without recycling them. Missing IDs return an error. Late responses can update retained entries but cannot reinsert evicted requests or overwrite current-navigation status. Close and disposal release both lists.

Adopt opt-in `redactUrlParams`, `--redact-url-params` and `PLAYWRIGHT_MCP_REDACT_URL_PARAMS`. Lists replace lower-precedence lists (CLI, environment, config file); explicit empty values disable redaction. Match nonempty query/fragment values by case-insensitive names after one key-decoding pass. Never interpolate names into regular expressions. Use URL-safe `REDACTED`, not angle brackets that break Markdown autolinks.

Apply the same presentation policy to tool-result text and structured string values, progress messages, tool-list display fields and saved session Markdown/snapshot YAML. Preserve original runtime arguments and objects. The MCP server boundary is the single redaction point for results, errors and progress, including proxy/provider results; the interactive REPL, which calls the backend directly, applies the same helper. Session action-update matching uses the same redacted representation as its original write.

This is not a secrecy guarantee. Raw reports, find exports, saved code, downloads, traces, images, embedded resources, resource links, schemas, structured property keys, startup/debug/protocol errors and runtime state are deliberately unchanged. The README coverage table is the public contract. Whole encoded URL blobs are not recursively decoded, and URL-shaped prose can match the opt-in renderer.

The extension UI change in upstream Playwright #43258 cannot be copied here: this repository vendors the relay, not that UI. Preserve the supported extension-token/CDP-token handoff rather than changing browser requests or Chrome arguments.

## Alternatives

- Do not retain history: preserves positional numbering but loses earlier diagnostics and leaves stale-index ambiguity.
- Renumber the combined list: rejected because an ID could refer to a different request after navigation or eviction.
- Automatically clear on every browser navigation: deferred because it changes existing link/form/history behavior and requires a separate document/redirect boundary contract.
- Rewrite every artifact: rejected because binary/native traces and browser state have different formats and lifetimes; text replacement would create false assurances or damage evidence.
- Redact only normal result text: rejected because structured data, proxy errors, progress, WebMCP descriptions and saved session snapshots would bypass the selected policy.

## Verification

Behavioral regressions cover retained IDs, navigation, eviction, failures, late responses and tab/session isolation. Native Chromium/MCP checks verify that actual navigation and captured request URLs retain synthetic values while displayed responses and session files mask them. A raw accessibility report remains unchanged as an explicit exclusion. Separate regressions exercise forwarded errors/progress and session-recorder rewrites, including quoted and whitespace-bearing URL values.
