# Accessibility and tool domain

## Domain boundaries

The scanner treats browser automation as a means to create an auditable page state. Its accessibility domain has four primary analysis products:

| Tool | Scope | Primary result |
|---|---|---|
| `scan_page` | current page, one tag set | readable summary plus JSON-stringified deduplicated Axe violations |
| `audit_site` | multiple discovered/provided pages | aggregate and per-page versioned JSON report |
| `scan_page_matrix` | current page under viewport/media/zoom variants | versioned comparison report against the first variant |
| `audit_keyboard` | actual Tab/Shift+Tab traversal | versioned heuristic focus/skip-link/trap report |

The latter three also return concise MCP `structuredContent` and local report resource links. `scan_page` is intentionally simpler and does not write a report (`src/tools/axe.ts`, `snapshot.ts`, `auditSite.ts`, `scanPageMatrix.ts`, `auditKeyboard.ts`).

## Tool taxonomy and capability model

`src/tools.ts` aggregates all tool modules. Core categories are:

- accessibility scans/audits;
- ARIA snapshot, search, and ref-based interactions;
- navigation, tab lifecycle, resize, and waits;
- keyboard/form/file/dialog input;
- console, network, evaluation, screenshot, and artifacts.

Tools whose capability starts with `core` are always exposed. Optional capabilities include coordinate mouse tools (`vision`), PDF (`pdf`), and assertions (`verify`). Tool descriptors include Zod-derived JSON schemas plus read-only/destructive/open-world hints (`src/tools/tool.ts`, `src/mcp/tool.ts`).

The type annotation is operational guidance, not a proof of side-effect freedom. Audits marked destructive may navigate, open/close tabs, reload, alter viewport/media/zoom, move focus, scroll, or write files.

## Axe finding model

`src/tools/axe.ts` is the shared Axe vocabulary and normalization layer.

Supported tags include WCAG 2.0/2.1/2.2 A–AAA, Section 508, and Axe categories. Raw nodes are deduplicated per rule using target plus HTML. Trimmed violations retain:

- rule ID, impact, tags, help and help URL;
- description;
- bounded nodes with target, HTML, and failure summary.

Summaries count violation rules and retained nodes by impact/rule. This distinction matters for `audit_site`: per-page display totals can be bounded by `maxNodesPerViolation`, while aggregate occurrence counts use the full deduplicated node set.

## Site aggregation concepts

`audit_site` groups findings by rule and tracks:

- total deduplicated node occurrences;
- number of affected pages;
- approximate unique occurrence fingerprints;
- up to three representative samples across pages.

The fingerprint is a compact 32-bit hash of normalized HTML, scoped per rule. It was introduced to avoid storing full HTML as a map key and reduce memory. It is approximate: collisions and identical markup in different semantic locations can undercount uniqueness (`src/tools/auditSite.ts`; recent history around occurrence hashing and reduced dedupe work).

URL identity is also normalized: fragments and configured tracking parameters are removed, remaining query parameters sorted, and non-root trailing slashes stripped. This makes crawl limits reflect logical pages rather than common URL noise.

## Snapshot and ref model

`Tab.captureSnapshot()` asks Playwright for an AI-mode ARIA snapshot. Responses combine it with URL, title, main-document status, recent console messages, modal states, and downloads (`src/tab.ts`, `src/response.ts`). Snapshot/title failures degrade to textual state rather than failing the tool.

Interactive snapshot lines contain refs such as `[ref=e12]`. Ref-based tools require both:

- `element`: human-readable intent/permission context;
- `ref`: exact current snapshot reference.

Before acting, `Tab.refLocator()` captures a fresh snapshot and verifies the ref still exists, then creates `aria-ref=<ref>`. Refs are therefore **ephemeral capabilities**, not persistent selectors. A DOM/state change can invalidate them; recapture before retrying.

Most mutating interactions request a fresh post-action snapshot. This keeps the returned state aligned with the mutation and produces new refs for the next call.

## Finding within large snapshots

`browser_find` searches an uncompressed fresh snapshot using literal text or RE2 syntax. It returns match windows plus ancestor context. RE2 intentionally rejects unsupported JavaScript-regex features such as lookahead and protects against pathological backtracking.

Recent history replaced repeated backward ancestor scans with one parent-index pass. Preserve that near-linear shape when changing output context (`src/tools/snapshot.ts`).

## Snapshot compression

Response presentation may compress repeated, non-interactive ARIA structures (`src/utils/ariaCompression.ts`). Compression:

- activates only when a structural signature occurs more than 100 times;
- retains the first 10 repeated instances;
- preserves interactive/ref-sensitive roles, pointer refs, and protected grid/tree structures;
- appends a warning directing callers to `browser_evaluate` for the full list.

It does not change the underlying fresh snapshot used for ref validation. Recent changes propagate parent/row-container state in linear passes to avoid quadratic behavior on deeply repeated trees.

## Keyboard audit semantics

`audit_keyboard` sends real Tab/Shift+Tab keys and samples active-element role/name/tag/id/href/text, geometry, viewport state, scroll, and a focus fingerprint. It uses heuristics:

- visible focus: computed outline or box shadow;
- jump: large vertical scroll delta or focused element outside the viewport;
- skip link: link text/id or common main/content fragment target;
- possible trap: repeated fingerprints in a recent window without reaching HTML/BODY.

These are diagnostics, not WCAG proof. Pseudo-element/background/border focus treatments can be missed, box shadows are not contrast-checked, and intentional cyclic widgets can resemble traps. Full-page issue screenshots can be expensive and may capture sensitive content.

## Response and report contracts

`Response.serialize()` emits one markdown text item, then resource links and optional images, plus structured content and error state (`src/response.ts`). Advanced audit reports are versioned JSON and include metadata/options/timing, detailed results, and concise summary objects.

Resource links are local `file://` URIs. They work naturally for local clients that can reach the same filesystem; remote HTTP clients may need another artifact-transfer mechanism. Do not assume the link itself uploads report contents.

Progress notifications are sent only if the MCP request supplied a progress token. Notification failures are swallowed and debug-logged so audit completion is not coupled to progress delivery.

## Domain invariants for changes

- Keep the full report and concise structured content consistent, but do not force all detail into MCP responses.
- Bound retained nodes, screenshots, pages, depth, pattern length, and response work.
- Preserve raw/deduplicated/trimmed distinctions when calculating totals.
- Restore temporary browser state in `finally` paths.
- Treat keyboard results and uniqueness fingerprints as approximations in labels and docs.
- Never use compressed presentation data to validate interaction refs.
