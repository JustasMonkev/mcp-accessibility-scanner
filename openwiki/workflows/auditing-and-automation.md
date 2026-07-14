# Auditing and automation workflows

## Common session flow

A robust session follows this sequence:

1. navigate or attach to the target state;
2. inspect with `browser_snapshot` or `browser_find`;
3. interact using current refs;
4. run the narrowest suitable audit;
5. consume markdown immediately and retain JSON report links for detail;
6. close tabs/browser context when finished.

In the interactive CLI, each line is `<tool-name> <json>`. In MCP mode, the same names are tool identifiers, not shell subcommands.

## Single-page Axe scan

```text
browser_navigate {"url":"https://example.com"}
scan_page {"violationsTag":["wcag21aa","wcag22aa"]}
```

`scan_page` runs Axe on the current page and returns the URL, rule/node counts, and deduplicated violations. It does not create a report file or structured summary. Use it for quick iteration where the current page state is already correct (`src/tools/snapshot.ts`, `src/tools/axe.ts`).

Watch for:

- no current tab: navigate first;
- dynamic content: use the available wait tools before scanning;
- Electron CDP targets: Axe may fail with `Target.createTarget: Not supported`; `SKILL.md` documents injecting local `axe.min.js` via `browser_evaluate` as a fallback.

## Site audit

`audit_site` breadth-first scans discovered or explicit URLs while preserving the originally selected tab.

```json
{
  "startUrl": "https://example.com",
  "strategy": "links",
  "maxPages": 25,
  "maxDepth": 2,
  "sameOriginOnly": true,
  "violationsTag": ["wcag2aa"]
}
```

Strategies (`src/tools/auditSite.ts`):

- `links`: follow anchors breadth-first to `maxDepth`;
- `nav`: scan start page, then one hop of links inside navigation/header regions;
- `sitemap`: read sitemap XML, optionally from `sitemapUrl`;
- `provided`: scan explicit `urls`; this can infer the root from the first valid URL if the current page is blank.

Defaults are 25 pages, depth 2, same-origin only, common tracking query parameters ignored, logout/signout paths excluded, and 10 retained nodes per violation. HTTP(S) is required.

Operational behavior:

- temporary tabs are opened and closed;
- `sameOriginOnly: false` permits external crawling;
- `includeSubdomains` matters only while same-origin restriction is enabled;
- exclusion patterns use RE2 and are capped in length;
- progress is reported per crawl/scan when the client provides a progress token;
- the report contains every page status/error plus aggregate totals and representative findings.

Verify changes with `tests/tools-auditSite.test.ts`, the report integration test, and real-browser smoke when navigation behavior changes.

## Responsive/media matrix

`scan_page_matrix` runs Axe repeatedly on the current page with variant state:

```json
{
  "violationsTag": ["wcag2aa"],
  "reloadBetweenVariants": false
}
```

Default variants are baseline, mobile 375×812, desktop 1280×720, forced colors, reduced motion, and 200% CSS zoom. Custom variants can set viewport, media emulation, and zoom.

The **first variant is always the comparison baseline**, regardless of its name or whether it modifies the page. Put an intentional baseline first.

For each variant the tool applies state, optionally reloads, waits, scans, and computes rule/node deltas against baseline. In `finally`, it restores viewport and root zoom and resets media emulation to neutral (`src/tools/scanPageMatrix.ts`). It does not recover a pre-existing custom media emulation; callers that depend on one should make it explicit in their matrix.

Verify restoration, baseline, failure, and diff behavior in `tests/tools-scanPageMatrix.test.ts`.

## Keyboard audit

```json
{
  "maxTabs": 50,
  "checkSkipLink": true,
  "checkFocusVisibility": true,
  "checkFocusTrap": true,
  "screenshotOnIssue": true,
  "maxIssueScreenshots": 3
}
```

The tool drives real keyboard traversal and records each stop. Optional behaviors include alternating Shift+Tab, activating a discovered skip link, stopping on a possible cycle, and taking capped issue screenshots (`src/tools/auditKeyboard.ts`).

Use the result as evidence for manual review, not a pass/fail WCAG oracle. Focus visibility and trap detection are computed-style/fingerprint heuristics. Activating skip links can navigate and then call `goBack`; traversal also changes focus, scroll, and potentially page state.

Verify algorithmic behavior in `tests/tools-auditKeyboard.test.ts` and wrapper/schema behavior in `tests/tools-auditKeyboard.tool.test.ts`.

## Snapshot-driven interaction

1. Call `browser_snapshot` or `browser_find`.
2. Select a current line with `[ref=...]`.
3. Call a ref-based tool with both `element` and `ref`.
4. Use the post-action snapshot returned by mutating tools for the next step.

Example:

```json
{"element":"Submit form button","ref":"e12"}
```

Refs are checked against a fresh ARIA snapshot immediately before action. A stale ref intentionally fails instead of risking interaction with the wrong element (`src/tab.ts`).

`browser_find` is better than repeatedly requesting huge snapshots when looking for text/roles in large pages. Its regex mode uses RE2, and output includes nearby lines and ancestors.

## Modal and file workflows

Dialogs and file choosers become tab modal states. Ordinary tab tools are blocked while an unsupported modal is pending; only the matching modal-clearing tool is permitted (`src/tools/tool.ts`). This prevents unrelated page operations from hanging behind JavaScript dialogs or unresolved file selection.

Response snapshot/title work races modal appearance and returns modal instructions instead of waiting indefinitely.

## Reports and artifact paths

Advanced audits ask `Context.outputFile()` for sanitized output paths. Resolution order is:

1. explicit `outputDir`;
2. first MCP client root plus `.playwright-mcp`;
3. timestamped directory under the OS temp directory.

Docker sets `/app/output`; mount it to retain artifacts after container exit. MCP report resource links are `file://` URLs and presume shared filesystem visibility.

## Workflow change checklist

- Does the tool restore selected tab and all temporary page state on success and error?
- Are crawl/variant/tab/screenshot/node counts bounded?
- Does progress remain optional and failure-tolerant?
- Are report totals explicit about full, deduplicated, or trimmed nodes?
- Does structured content remain concise and version-compatible with the full JSON report?
- Are destructive annotations and README/SKILL examples still accurate?
- Have mock-focused tests and at least one real-browser path been considered?
