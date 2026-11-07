# Merged PR review audit — 2026-11-07

The audit found review findings that still applied to `main`, including regressions of previously fixed findings. This follow-up fixes the confirmed gaps; it does not treat a resolved GitHub thread as proof that the current code is correct.

## Scope and evidence

Starting commit: `429584e9e698c5bd1bec7d77bf824e8aee402280`.

- All **217 merged PRs**, from #2 through #335, merged between 2025-05-06 and 2026-11-07.
- **459 conversation comments**, **1,228 inline comments** in 756 threads, and **851 submitted reviews** (363 with nonempty bodies).
- 704 threads were resolved and 52 unresolved when collected. Those statuses were recorded separately from the current-code dispositions. Historical threads were not changed by this audit.
- Paginated REST retrieval and GitHub Search agreed on all 217 merged PR IDs. All per-PR conversation counts reconciled. REST returned 1,227 inline comments; GraphQL additionally returned one resolved maintainer reply on #197, which is included in the union. All REST inline IDs and bodies matched GraphQL, and the largest review lists (#148 and #156) were independently reconciled across REST pages.
- GPT-6.1 Sol agents with high reasoning reviewed disjoint PR ranges. A separate agent reviewed the resulting fixes and reproduced important edge cases. Duplicate bot summaries, acknowledgments and status messages are distinguished from actionable findings.

Detailed dispositions, original comment links and present-code evidence:

- [PRs 1–99](reviews/2026-11-07-prs-1-99.md)
- [PRs 100–199](reviews/2026-11-07-prs-100-199.md)
- [PRs 200–299](reviews/2026-11-07-prs-200-299.md)
- [PRs 300 and later](reviews/2026-11-07-prs-300-plus.md)

## Confirmed gaps corrected

| Area | Result | Original PRs |
| --- | --- | --- |
| Site audits | Keep occurrence fingerprints collision-resistant; reject empty exclusions and sitemap indexes; document RE2 restrictions; keep subdomain crawling on the original port. | #33, #34, #80, #156 |
| Data URL truncation | Preserve fragments and adjacent encoded query parameters; truncate ambiguous MIME-parameter commas conservatively. | #96 |
| Interactive CLI | Render tool errors on stderr and resource links with configured URL redaction. Await backend cleanup and flush final session Markdown/snapshots before exit. | #55 |
| HTTP startup | Empty host defaults to loopback. Wildcard bind logs remain accurate while generated client URLs use loopback addresses accepted by the existing Host guard. | #73 |
| Mouse input | Reject fractional click counts before dispatch. | #105 |
| Persistent profiles | Reject incompatible storage-state imports at ordinary CLI startup as well as provider-switch startup. | #148 |
| Trace lifecycle | Wait for an old shared trace to finish stopping before starting a replacement. | #148 |
| Trace viewer | Supply the pinned Playwright API's file-root policy and generate a working directory-trace URL, with Windows path handling. | #170 |
| Screen-reader audit | Treat singular transforms as unpainted while preserving invertible counter-rotations; expose the frame-work saturation limit in structured output. | #148, #197 |
| Axe frame coverage | Follow multiple slot projections through the flattened tree so modal and exclusion ancestry remain correct. | #156 |
| Session recording | Update pending and flushed snapshots when consecutive input is coalesced; serialize snapshot writes with log updates. | #189 |
| Tool metadata | Do not advertise `browser_find` as read-only when it can write a file. | #263 |
| Keyboard audit | Exclude a focus-delegating host from its own target-spacing neighbors while retaining real nearby light and shadow controls. | #307 |
| Screenshot guidance | Limit direct mouse-coordinate reuse to CSS-scaled viewport screenshots and explain device scale/crop origins. | #324 |
| URL selection | Allocate choice rows only for reconstruction while preserving the selected URLs. | #315 |
| Tests and documentation | Require clean Docker shutdown; isolate absent/empty protocol-header checks; use portable benchmark temporary paths; correct WebMCP adoption status and disclose fixed benchmark run order. | #156, #217, #248, #281, #301 |

## Deliberate limits

The detailed reports retain owner-declined suggestions, superseded code, and documented detection limits as distinct dispositions. In particular, the future labeled-site evaluation suggested on #315 remains research work, and native discarded-tab acceptance on #332 remains tracked in #244. This follow-up does not claim either is solved. Directly treating a shadow `<slot>` as an Axe selector anchor was rejected after comparing Axe's actual flattened tree; the separate multiple-projection ancestor bug was reproduced and fixed.

## Validation

The subsequent [agent-driven MCP regression](reviews/2026-11-07-mcp-regression.md) covers all 45 static tool names and records additional fixes, final checks and known limits.

Regression checks include failing-before/passing-after cases and deliberate mutations for changed logic. Node 24.22.1 and pinned Playwright 1.65.0 were used. Chromium 158.0.8127.18 headless-shell and Firefox 159 probes exercise the changed browser logic.

The unchanged baseline produced 2,025 passes, 54 failures and 20 skips in this environment. The first integrated follow-up run produced 2,047 passes, 57 failures and 20 skips: the identical 54 baseline failure names plus three new keyboard cases blocked by the same full-Chromium UNIX-socket/process restrictions. Those three cases pass independently on pinned Chromium headless-shell and Firefox. WebKit cannot launch with the missing host libraries, and Docker is not installed. These results do not establish a green full-suite or Docker run. Final follow-up check counts and hosted CI status are recorded in the PR description.

Build, lint/typecheck and changed-line slop checks pass. Independent real-CLI checks reproduce loss of the final saved session entry before the fix and verify both Markdown and snapshot files after immediate EOF afterward. HTTP smoke tests use the emitted client URL for empty/IPv4-wildcard/IPv6-wildcard listeners and retain rejection of a foreign Host header. URL-selection controls preserve all 200 selected URLs on a 20,000-URL input while reducing choice-array allocations from 40,403 to 281.

## PR coverage

The counts below include replies and non-actionable review text. The linked range reports explain the substantive dispositions.

| PR | Title | Inline | Reviews with text | Conversation | Unresolved threads |
| --- | --- | ---: | ---: | ---: | ---: |
| [#2](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/2) | Add MseeP.ai badge | 0 | 2 | 1 | 0 |
| [#5](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/5) | chore: update package dependencies and improve accessibility scanning functionality | 1 | 2 | 0 | 0 |
| [#8](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/8) | Add MseeP.ai badge | 2 | 3 | 0 | 1 |
| [#9](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/9) | feat: add initial implementation of tools and server for MCP | 11 | 3 | 2 | 0 |
| [#15](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/15) | feat: add timeout configuration options for Playwright operations | 5 | 1 | 3 | 5 |
| [#17](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/17) | chore(deps): bump playwright from 1.55.0 to 1.56.1 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#19](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/19) | Add vitests tests | 4 | 1 | 1 | 4 |
| [#20](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/20) | chore(deps-dev): bump js-yaml from 4.1.0 to 4.1.1 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#21](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/21) | chore(deps): bump body-parser from 2.2.0 to 2.2.1 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#22](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/22) | chore(deps): bump express from 5.1.0 to 5.2.1 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#24](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/24) | chore: update @modelcontextprotocol/sdk to version 1.24.0 and change … | 0 | 0 | 0 | 0 |
| [#25](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/25) | feat: add unit tests for manualPromise and tool modules, update depen… | 3 | 2 | 6 | 0 |
| [#26](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/26) | chore(deps): bump qs from 6.14.0 to 6.14.1 in the npm_and_yarn group across 1 directory | 0 | 0 | 1 | 0 |
| [#27](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/27) | chore(deps): bump @modelcontextprotocol/sdk from 1.24.3 to 1.25.2 in the npm_and_yarn group across 1 directory | 0 | 0 | 1 | 0 |
| [#28](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/28) | chore(deps): bump hono from 4.11.3 to 4.11.4 in the npm_and_yarn group across 1 directory | 0 | 0 | 1 | 0 |
| [#29](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/29) | chore(deps-dev): bump lodash from 4.17.21 to 4.17.23 in the npm_and_yarn group across 1 directory | 0 | 0 | 1 | 0 |
| [#30](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/30) | chore(deps): bump hono from 4.11.4 to 4.11.7 in the npm_and_yarn group across 1 directory | 0 | 0 | 1 | 0 |
| [#31](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/31) | feat: update deps | 3 | 1 | 2 | 3 |
| [#32](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/32) | chore(deps): bump @modelcontextprotocol/sdk from 1.25.3 to 1.26.0 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#33](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/33) | feat: add audit tools for accessibility checks and update documentation | 19 | 6 | 2 | 0 |
| [#34](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/34) | Remove zod-to-json-schema dependency and bump version | 4 | 4 | 2 | 1 |
| [#35](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/35) | chore(deps): bump qs from 6.14.1 to 6.14.2 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#36](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/36) | chore(deps): bump tar from 7.5.7 to 7.5.9 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#37](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/37) | chore(deps): bump hono from 4.11.7 to 4.12.0 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#38](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/38) | chore(deps-dev): bump ajv from 6.12.6 to 6.14.0 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#39](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/39) | fix: bump minimatch to 3.1.3 to address ReDoS vulnerability | 2 | 2 | 2 | 0 |
| [#40](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/40) | chore(deps): bump hono from 4.12.0 to 4.12.2 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#42](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/42) | fix: pin rollup to &gt;=4.59.0 to resolve GHSA-mw96-cpmx-2vgc | 1 | 1 | 4 | 0 |
| [#47](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/47) | chore(deps): bump the npm_and_yarn group across 1 directory with 2 updates | 0 | 0 | 0 | 0 |
| [#48](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/48) | chore(deps): bump tar from 7.5.9 to 7.5.10 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#49](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/49) | chore(deps): bump express-rate-limit from 8.2.1 to 8.3.0 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#50](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/50) | feat: add progress reporting for keyboard and site audits | 5 | 5 | 2 | 0 |
| [#51](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/51) | chore: bump MCP sdk | 7 | 6 | 2 | 1 |
| [#52](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/52) | chore: bump MCP sdk | 4 | 1 | 2 | 4 |
| [#53](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/53) | chore(deps): bump hono from 4.12.5 to 4.12.7 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#54](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/54) | chore(deps): bump tar from 7.5.10 to 7.5.11 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#55](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/55) | chore: cli | 5 | 5 | 2 | 0 |
| [#56](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/56) | chore(deps-dev): bump flatted from 3.3.3 to 3.4.2 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#57](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/57) | chore(deps): bump picomatch from 4.0.3 to 4.0.4 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#58](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/58) | chore(deps-dev): bump happy-dom from 20.5.1 to 20.8.9 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#59](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/59) | chore(deps): bump brace-expansion from 5.0.3 to 5.0.5 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#60](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/60) | chore(deps): bump path-to-regexp from 8.3.0 to 8.4.0 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#61](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/61) | chore(deps-dev): bump vite from 7.3.1 to 7.3.2 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#62](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/62) | chore(deps-dev): bump lodash from 4.17.23 to 4.18.1 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#63](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/63) | Simplify callback type checking in audit site test | 6 | 5 | 5 | 0 |
| [#64](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/64) | chore(deps): bump @hono/node-server from 1.19.10 to 1.19.13 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#65](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/65) | chore(deps): bump hono from 4.12.7 to 4.12.12 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#66](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/66) | chore(deps): bump hono from 4.12.12 to 4.12.14 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#67](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/67) | chore(deps): update dependencies to latest versions | 5 | 1 | 1 | 5 |
| [#70](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/70) | chore(deps): bump ip-address from 10.1.0 to 10.2.0 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#71](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/71) | chore(deps): bump hono from 4.12.14 to 4.12.18 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#72](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/72) | chore(deps): bump fast-uri from 3.1.0 to 3.1.2 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#73](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/73) | Fix HTTP MCP default bind address and preserve wildcard address reporting | 3 | 2 | 1 | 0 |
| [#74](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/74) | chore(deps): bump brace-expansion from 5.0.5 to 5.0.6 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#75](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/75) | Migrate TypeScript scripts to tsgo | 1 | 1 | 1 | 1 |
| [#76](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/76) | Update dependencies, fix Playwright 1.60 breakage, reduce dedup work | 5 | 2 | 1 | 0 |
| [#77](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/77) | Apply SOLID principles and complete tsgo migration | 3 | 1 | 1 | 0 |
| [#78](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/78) | chore(deps): bump hono from 4.12.18 to 4.12.23 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#79](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/79) | fix: include root export files in npm package | 0 | 0 | 3 | 0 |
| [#80](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/80) | Reduce browser round-trips and simplify accessibility tool internals | 2 | 2 | 1 | 0 |
| [#81](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/81) | Adopt latest MCP spec features and bump package to 2.0.13 | 0 | 0 | 1 | 0 |
| [#82](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/82) | chore(deps-dev): bump vite from 8.0.14 to 8.0.16 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#83](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/83) | chore(deps): bump the npm_and_yarn group across 1 directory with 3 updates | 0 | 0 | 0 | 0 |
| [#85](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/85) | Fix browser_evaluate broken by playwright-core 1.59 (_evaluateFunction removal) | 0 | 0 | 1 | 0 |
| [#86](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/86) | chore(deps): bump undici from 6.26.0 to 6.27.0 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#87](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/87) | chore: bump playwright/playwright-core to 1.61.0 | 2 | 1 | 1 | 1 |
| [#88](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/88) | fix: restore resolved locator code snippets via public Locator.normalize() (playwright-core 1.61) | 1 | 1 | 1 | 0 |
| [#90](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/90) | fix: wait for commit on navigate_back to avoid bfcache timeouts | 0 | 0 | 1 | 0 |
| [#91](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/91) | feat: make MCP heartbeat timeout configurable | 3 | 1 | 1 | 0 |
| [#93](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/93) | fix: guard CDP page state capture timeouts | 4 | 4 | 1 | 0 |
| [#96](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/96) | fix: truncate data URL payloads in MCP output | 27 | 9 | 1 | 4 |
| [#97](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/97) | docs: sync README tool list with current CLI surface | 0 | 0 | 1 | 0 |
| [#99](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/99) | feat: add scale option to browser_take_screenshot (mirror upstream Playwright MCP #41465) | 0 | 0 | 1 | 0 |
| [#101](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/101) | feat: support CDP connection headers and timeout | 8 | 2 | 1 | 0 |
| [#103](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/103) | fix: race condition on startup #102 | 0 | 0 | 1 | 0 |
| [#104](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/104) | chore: run tests only on feature branches | 0 | 0 | 1 | 0 |
| [#105](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/105) | feat: add button, clickCount and delay options to browser_mouse_click_xy | 3 | 3 | 1 | 0 |
| [#107](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/107) | feat: add browser_snapshot compression option | 6 | 3 | 4 | 0 |
| [#109](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/109) | Fix streamable HTTP listRoots initialization race | 4 | 2 | 4 | 0 |
| [#111](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/111) | feat: mirror Playwright MCP find and status updates | 4 | 2 | 4 | 0 |
| [#113](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/113) | fix: bind Docker Compose MCP port to localhost | 0 | 0 | 1 | 0 |
| [#114](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/114) | Fix HTTP session fallback timer accumulation | 0 | 0 | 1 | 0 |
| [#115](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/115) | fix: avoid quadratic snapshot compression | 0 | 0 | 1 | 0 |
| [#118](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/118) | feat: mirror Playwright MCP find and mobile updates | 12 | 4 | 1 | 0 |
| [#120](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/120) | chore: add noDefaults | 3 | 1 | 1 | 0 |
| [#121](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/121) | fix: preserve CDP browser defaults on attach | 1 | 1 | 1 | 0 |
| [#125](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/125) | fix: cap unresponsive tab title refreshes | 0 | 1 | 1 | 0 |
| [#127](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/127) | docs: add OpenWiki repository guide | 6 | 4 | 1 | 2 |
| [#128](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/128) | fix: remove shebang from index.d.ts type declaration | 0 | 0 | 1 | 0 |
| [#129](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/129) | Upgrade dependencies and use TypeScript 7 throughout | 0 | 0 | 1 | 0 |
| [#131](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/131) | feat: support extension protocol v2 | 18 | 6 | 6 | 0 |
| [#133](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/133) | Fix orphaned extension reconnect seed tab | 9 | 3 | 1 | 0 |
| [#135](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/135) | feat: make post-action settle delay configurable | 0 | 0 | 1 | 0 |
| [#136](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/136) | fix: sync MCP download and extension profile handling | 9 | 3 | 4 | 0 |
| [#137](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/137) | chore(deps): bump body-parser from 2.2.2 to 2.3.0 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#138](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/138) | chore(deps): bump the npm_and_yarn group across 1 directory with 3 updates | 0 | 0 | 0 | 0 |
| [#139](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/139) | fix: surface missing browser executable path in not-installed error (sync Playwright MCP #41941) | 1 | 2 | 1 | 1 |
| [#140](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/140) | fix: escape user input in generated code | 1 | 1 | 1 | 0 |
| [#141](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/141) | Surface Axe incomplete results and add scan scoping | 13 | 4 | 2 | 0 |
| [#142](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/142) | Annotated violation screenshots for scan_page | 26 | 3 | 2 | 0 |
| [#143](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/143) | Honour storage state or say why not, and detect session loss mid-crawl | 12 | 2 | 2 | 0 |
| [#144](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/144) | WCAG 2.2 target size and focus-not-obscured checks | 18 | 2 | 2 | 0 |
| [#145](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/145) | Rule-level control: withRules / disableRules | 22 | 3 | 2 | 0 |
| [#146](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/146) | audit_screen_reader: accessible names and reading order | 26 | 2 | 2 | 0 |
| [#147](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/147) | Feat/axe improvements | 0 | 0 | 1 | 0 |
| [#148](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/148) | fix: address post-merge review comments on #142 and #145 | 173 | 28 | 6 | 4 |
| [#149](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/149) | feat: add pre-push-review skill distilled from Codex PR review findings | 2 | 1 | 1 | 0 |
| [#151](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/151) | Handle out-of-band dialog closes to unblock snapshots | 5 | 2 | 1 | 1 |
| [#152](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/152) | feat(screenshot): add webp output format for browser_take_screenshot | 0 | 0 | 1 | 0 |
| [#153](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/153) | feat: sync browser tools with upstream Playwright MCP (#116) | 6 | 2 | 2 | 0 |
| [#154](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/154) | chore(deps): bump the npm_and_yarn group across 1 directory with 2 updates | 0 | 0 | 0 | 0 |
| [#155](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/155) | chore(deps): bump Playwright to 1.62.1 for AI-snapshot ARIA fixes | 0 | 0 | 2 | 0 |
| [#156](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/156) | Add end-to-end latency benchmarking and optimize axe scanning | 148 | 31 | 41 | 0 |
| [#157](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/157) | chore(deps): bump @hono/node-server from 1.19.13 to 2.0.12 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#159](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/159) | chore(deps): bump ip-address from 10.2.0 to 10.4.0 in the npm_and_yarn group across 1 directory | 0 | 0 | 0 | 0 |
| [#160](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/160) | chore(deps): bump the npm_and_yarn group across 1 directory with 3 updates | 0 | 0 | 0 | 0 |
| [#164](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/164) | Tear down CDP relay on unexpected browser disconnect | 2 | 1 | 1 | 0 |
| [#170](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/170) | Update @modelcontextprotocol/sdk to 1.30.0 and bump ws patch | 101 | 21 | 1 | 0 |
| [#172](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/172) | Redact request and response bodies from network details | 0 | 0 | 1 | 0 |
| [#175](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/175) | chore: add knip | 3 | 1 | 1 | 0 |
| [#176](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/176) | Validate Host and Origin on the extension CDP relay WebSocket upgrade | 3 | 1 | 1 | 0 |
| [#181](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/181) | chore(deps): surface aria-hidden markers in AI snapshots | 0 | 1 | 1 | 0 |
| [#182](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/182) | Handle tab detach during attachment and re-attachment | 18 | 7 | 6 | 2 |
| [#185](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/185) | Treat a detach that cancels an in-flight attach as recoverable | 9 | 4 | 9 | 0 |
| [#189](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/189) | feat: add browser action recording tools | 57 | 18 | 2 | 2 |
| [#196](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/196) | fix(audit_screen_reader): restore names the AI snapshot moved into rendered children | 17 | 5 | 8 | 0 |
| [#197](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/197) | fix(audit_screen_reader): bound unresponsive frame work | 6 | 2 | 5 | 1 |
| [#198](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/198) | fix(audit_screen_reader): retry recovered frame work | 0 | 0 | 4 | 0 |
| [#199](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/199) | refactor: share frame work pool for axe installs | 0 | 0 | 2 | 0 |
| [#200](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/200) | docs: warn about extension token focus behavior | 0 | 0 | 2 | 0 |
| [#201](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/201) | feat: add snapshot bounding boxes | 0 | 0 | 2 | 0 |
| [#202](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/202) | test: cover trace recovery after failed stop | 0 | 0 | 2 | 0 |
| [#203](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/203) | test: cover searchbox-derived snapshot names | 0 | 0 | 2 | 0 |
| [#205](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/205) | fix: wait for HTTP event stream before heartbeat | 0 | 0 | 2 | 0 |
| [#208](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/208) | fix: disable bundled Chromium sandbox on Linux | 4 | 3 | 2 | 0 |
| [#209](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/209) | fix: stabilize request body limit handling | 2 | 2 | 4 | 0 |
| [#210](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/210) | fix: security hardening — browser_connect RCE, HTTP auth, extension token, upload allowlist, sitemap SSRF | 27 | 9 | 9 | 0 |
| [#211](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/211) | fix: resolve open scanner issues | 12 | 4 | 6 | 0 |
| [#212](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/212) | fix: bound extension token connection waits | 0 | 0 | 2 | 0 |
| [#214](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/214) | test: upgrade Playwright and migrate to Luna harness | 9 | 4 | 9 | 0 |
| [#215](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/215) | feat: add --profile-dir-name for explicit extension profile selection | 23 | 7 | 2 | 0 |
| [#217](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/217) | docs: propose deferring WebMCP adoption | 2 | 1 | 2 | 0 |
| [#220](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/220) | chore(deps): bump the npm_and_yarn group across 1 directory with 2 updates | 0 | 0 | 1 | 0 |
| [#223](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/223) | fix: address idle lifecycle, image responses, and compatibility checks | 3 | 2 | 2 | 1 |
| [#225](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/225) | Require explicit install capability for browser downloads | 4 | 2 | 2 | 3 |
| [#227](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/227) | fix: handle pinned Playwright browser failure paths | 0 | 0 | 2 | 0 |
| [#228](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/228) | chore(deps): bump @vitest/mocker from 4.1.10 to 5.0.1 in the npm_and_yarn group across 1 directory | 0 | 0 | 1 | 0 |
| [#232](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/232) | feat: configurable tool-result file path rendering | 1 | 1 | 4 | 0 |
| [#238](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/238) | Fix browser dialog, accessible-name and proxy routing failures | 8 | 1 | 7 | 0 |
| [#239](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/239) | Refactor merged snapshot and download code for readability | 0 | 0 | 2 | 0 |
| [#241](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/241) | Fix capped browser wait duration reporting | 0 | 0 | 2 | 0 |
| [#242](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/242) | feat(mcp): expose page WebMCP tools dynamically | 28 | 5 | 3 | 0 |
| [#247](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/247) | feat: add maxResults to browser_find | 1 | 1 | 2 | 0 |
| [#248](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/248) | fix(docker): run scanner under tini | 0 | 1 | 2 | 0 |
| [#249](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/249) | test(webkit): verify nested-details visibility through MCP tools | 2 | 1 | 3 | 0 |
| [#250](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/250) | fix(cdp): explain attach timeouts from tabs without a renderer; record numpad keys (#244) | 4 | 1 | 3 | 0 |
| [#252](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/252) | test: validate pinned browser regressions before upgrading Playwright | 12 | 3 | 2 | 0 |
| [#253](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/253) | feat: add exact-name MCP tool selection | 6 | 1 | 2 | 0 |
| [#254](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/254) | chore(deps): bump undici from 8.9.0 to 8.11.2 in the npm_and_yarn group across 1 directory | 0 | 0 | 1 | 0 |
| [#255](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/255) | fix(audit_site): don't let one page's dialog stall the crawl; add #230/#231 coverage | 39 | 13 | 7 | 0 |
| [#260](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/260) | feat: extend MCP tool prompts with new browser and audit capabilities | 0 | 0 | 2 | 0 |
| [#261](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/261) | fix(wait): race text and textGone and use time as their timeout in browser_wait_for | 13 | 3 | 3 | 0 |
| [#262](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/262) | test: add comprehensive host-recipient survival tests and refine MCP … | 6 | 4 | 2 | 0 |
| [#263](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/263) | feat: save browser_find results as optional artifacts | 1 | 3 | 2 | 1 |
| [#264](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/264) | fix: pass credentials from --proxy-server as proxy username/password | 8 | 2 | 4 | 0 |
| [#266](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/266) | test: accept the native relaunch crash on Chrome 154.0.8037.98 and Edge 154.0.4258.62 | 6 | 2 | 2 | 0 |
| [#268](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/268) | Document reliable login and interactive-state accessibility audits | 0 | 0 | 2 | 0 |
| [#269](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/269) | Fix generated form replay booleans and option labels | 0 | 0 | 2 | 0 |
| [#270](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/270) | Fix keyboard audit navigation, tab shutdown races, and HTTP failures | 15 | 4 | 6 | 0 |
| [#273](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/273) | ci: publish to npm on version tags via trusted publishing | 34 | 5 | 2 | 0 |
| [#274](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/274) | chore(deps): bump the npm_and_yarn group across 1 directory with 3 updates | 0 | 0 | 1 | 0 |
| [#275](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/275) | chore: bump version to 4.0.0 in server.json | 0 | 0 | 2 | 0 |
| [#276](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/276) | docs: fix quickstart prerequisites and packaged README asset links | 3 | 1 | 2 | 0 |
| [#277](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/277) | fix(navigate): return beforeunload dialogs from browser_navigate_back | 6 | 1 | 3 | 0 |
| [#278](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/278) | perf: short-circuit reading-order analysis | 0 | 0 | 2 | 0 |
| [#279](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/279) | Remove unused development dependencies | 0 | 0 | 2 | 0 |
| [#280](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/280) | fix(audit_keyboard): resolve every aria-labelledby id reference | 2 | 0 | 2 | 0 |
| [#281](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/281) | fix: align dependency updates with native install approvals | 1 | 2 | 3 | 0 |
| [#282](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/282) | perf: optimize screen-reader audits and add representative benchmarks | 0 | 0 | 2 | 0 |
| [#283](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/283) | feat(tabs): reject unsupported browser_tabs isolatedContext | 0 | 0 | 2 | 0 |
| [#285](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/285) | Fix configured HTTP hostname validation without relaxing wildcard policy | 2 | 0 | 2 | 0 |
| [#286](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/286) | Disclose authenticated proxy credential leakage on pinned Playwright | 0 | 0 | 2 | 0 |
| [#287](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/287) | Support native WebMCP object input without retrying page actions | 0 | 0 | 2 | 0 |
| [#288](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/288) | chore(deps): bump hono from 4.13.7 to 4.13.13 in the npm_and_yarn group across 1 directory | 0 | 0 | 1 | 0 |
| [#291](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/291) | Retain stable network history and add scoped URL-parameter redaction | 10 | 2 | 2 | 0 |
| [#294](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/294) | Refactor Axe frame-coverage helpers | 0 | 1 | 2 | 0 |
| [#297](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/297) | fix: make accessibility audit reports evidence-aware | 0 | 0 | 2 | 0 |
| [#301](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/301) | Speed up malformed data-URL parsing with measured benchmarks | 1 | 1 | 2 | 1 |
| [#304](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/304) | fix: honor CLI settle timeout | 1 | 0 | 2 | 1 |
| [#305](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/305) | fix: align public connection types with runtime server | 1 | 1 | 3 | 0 |
| [#306](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/306) | fix: preserve crawl paths and decode sitemap URLs | 2 | 1 | 2 | 0 |
| [#307](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/307) | fix: distinguish keyboard focus identity and traversal direction | 4 | 2 | 2 | 1 |
| [#308](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/308) | fix: ignore blank numeric environment overrides | 0 | 0 | 2 | 0 |
| [#309](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/309) | fix: yield native form dialogs without background filling | 1 | 0 | 2 | 0 |
| [#310](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/310) | fix: enforce configured coverage thresholds | 0 | 0 | 2 | 0 |
| [#311](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/311) | fix: cancel pending browser waits and release session leases | 0 | 0 | 2 | 0 |
| [#312](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/312) | fix: generate replayable file chooser upload code | 1 | 1 | 2 | 0 |
| [#313](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/313) | fix: enforce Chromium redirect and WebSocket origin restrictions | 0 | 0 | 2 | 0 |
| [#314](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/314) | refactor: consolidate repeated test and benchmark setup | 0 | 0 | 2 | 0 |
| [#315](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/315) | audit_site: similar-pattern grouping and representative page selection | 18 | 4 | 2 | 0 |
| [#316](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/316) | test: cover URL-parameter redaction in network tools | 0 | 0 | 2 | 0 |
| [#317](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/317) | Add concurrent page auditing to audit_site tool | 5 | 1 | 2 | 0 |
| [#319](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/319) | feat(extension): allow disabling controlled tab groups | 0 | 0 | 2 | 0 |
| [#320](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/320) | fix: prevent collisions in HTML pattern grouping keys | 0 | 0 | 2 | 0 |
| [#321](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/321) | refactor: remove code smells and comments, simplify tools and core modules | 0 | 0 | 2 | 0 |
| [#322](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/322) | fix: resolve six moderate dependency vulnerabilities | 0 | 0 | 2 | 0 |
| [#323](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/323) | refactor: simplify long handlers and remove code smells | 0 | 1 | 2 | 0 |
| [#324](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/324) | fix(screenshot): clarify screenshot actions with vision tools | 1 | 1 | 2 | 1 |
| [#327](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/327) | chore(deps): bump playwright and playwright-core to 1.65.0 | 3 | 1 | 2 | 0 |
| [#328](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/328) | fix: guard Chrome installation on native Windows ARM64 (#292) | 0 | 1 | 6 | 0 |
| [#329](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/329) | fix: reject unsupported persistent Firefox mTLS proxy mode (#235) | 0 | 0 | 4 | 0 |
| [#330](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/330) | fix: recover only proven empty WebKit response bodies (#257) | 0 | 0 | 4 | 0 |
| [#331](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/331) | fix: enforce preloaded-page origin policy and graceful SIGHUP cleanup (#296) | 0 | 0 | 4 | 0 |
| [#332](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/332) | test: add genuine discarded-tab CDP acceptance gate (#244) | 6 | 2 | 6 | 0 |
| [#333](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/333) | test: add installer cache and Windows networking gates (#295) | 0 | 0 | 4 | 0 |
| [#334](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/334) | fix: prevent terminated shared-worker crashes during CDP attachment (#303) | 0 | 0 | 10 | 0 |
| [#335](https://github.com/JustasMonkev/mcp-accessibility-scanner/pull/335) | fix: validate Firefox mobile screens and retain upgrade regressions (#325) | 0 | 0 | 10 | 0 |
| **Total** | **217 merged PRs** | 1228 | 363 | 459 | 52 |
