# PR #339 MCP regression — 2026-11-07

The initial PR ran the automated test suite and focused browser probes, but did not include an adaptive agent-driven regression of every MCP tool. This follow-up adds that validation with GPT-6.1 Sol agents using high reasoning.

## Method

Agents connected the real MCP SDK client to the built `cli.js` over stdio, inspected the live tool inventory, and chose subsequent calls from returned snapshots and results. Browsers, local fixture servers, generated reports, downloads and session files were real. Deterministic harness assertions are recorded separately from adaptive agent checks. A successful call alone is not proof of correctness: positive and negative controls checked DOM effects, file contents, counts, preserved state and rejected inputs.

Initial target: `070f4924273b585bf3853e0ec2263eb4b8974781`. Final validation targets the follow-up source included with this report; the final provider-close refinement was checked separately after the full-suite run. Runtime: Node 24.22.1, Playwright 1.65.0, pinned Chromium headless shell 158.0.8127.18 (revision 1254). Full Chromium's process singleton is restricted in this local environment.

## Coverage

Live inventory contains 33 default tools, plus vision (3), PDF (1), verify (4), devtools (2), and install (1): 44 standalone tools. Provider switching adds `browser_connect`, for 45 distinct static names. Page-supplied WebMCP tools are additional and dynamic. All **45 static tools** received successful adaptive Sol-agent MCP calls; the known negative-case defect below is retained separately.

| Area | Assertions exercised |
| --- | --- |
| Browser actions | Forms, typing, selection, keyboard, hover, click, drag/drop, upload, dialog handling, tabs, history, resize and media. Fractional click count rejected without a click event. |
| Output | Snapshot/find output and file artifacts, console/network redaction, actual PDF, CSS/device screenshot dimensions at DPR 2, coordinate events and generated recording code. |
| Accessibility | All five audit tools with seeded defects and clean controls; reports parsed from disk; crawl scope, exclusion validation, hash collisions, frame warnings, shadow/modal/slot ancestry, delegated-focus neighbors, singular transforms and frame-budget saturation. |
| Lifecycle | Session isolation and stale handles, timeouts, closure/reopening, session log persistence and dynamic WebMCP exposure. |
| Trace viewer | Two real traces through one viewer, HTTP 200 for its UI/descriptor and HTTP 403 outside the allowed trace root. IPv6-first server / IPv4-first client reproduced the original connection refusal. |
| Installation/providers | Real pinned archives installed into a disposable cache via a local mirror; provider switching back to the default browser and documented rejection paths. |

## Corrections found during regression and review

- Bind the trace viewer to explicit IPv4 loopback so its advertised URL reaches the bound socket regardless of `localhost` address ordering.
- Await asynchronous backend cleanup during ordinary stdio and HTTP process shutdown, including disconnected backends still saving files, initialization already in progress, and proxy child cleanup.
- Hide frames whose assigned slot hides them; retain visible slotted first-summary frame coverage in open and closed shadow roots.
- Truncate mixed/encoded data URLs conservatively without exposing text after ambiguous delimiters, while retaining surrounding query/fragment and markup boundaries.
- Escape Markdown table delimiters in two historical audit entries.

## Validation results

- The repository's deterministic MCP harness passed **34/34 scenarios**, with **0 skips and 0 failures**, on both the initial head and the integrated follow-up. Each run recorded 134 tool responses, including 10 expected negative responses. The harness adapter changed launch/output wiring for the installed browser, not fixture assertions. The integrated harness preceded the final sanitizer/slot refinements; fresh MCP sessions and the focused suites verified those final changes afterward.
- Adaptive Sol agents successfully invoked **45/45 static tools**, including cached-install and provider-switch paths. The core browser lane made 99 calls across 36 tools on the initial head (80 successes, 19 expected errors), followed by 26 additional optional-tool and redaction calls against the rebuilt server. The accessibility lane recorded 65 initial calls, 22 follow-up calls, and 30 calls on the final frozen build covering the corrected slots and unchanged audit controls.
- Full local suite: **2,060 passed / 57 failed / 20 skipped**. The 57 failed test names exactly match the previous PR run (2,048 passed / 57 failed / 20 skipped); no new failure names appeared. These are the previously characterized full-Chromium launch/process restrictions. This is not a green full-suite claim.
- All **283 tests in the four final changed-area suites** passed (`utils`, `tools-axe`, `mcp-server-init`, `browserContextFactory`). After the final proxy-close refinement, all 28 MCP initialization/proxy/VS Code tests and the actual external-provider exit probe passed. Build, lint/typecheck, changed-line slop check and whitespace checks passed.
- Actual immediate-exit probes verified the final saved Markdown entry and finalized trace for raw stdio EOF, authenticated HTTP SIGTERM, and default providers behind `--connect-tool` and `--vscode`. Delayed file appends made pending writes observable. Stateless HTTP also retained explicit sessions across requests, isolated handles and rejected forged Host headers.
- Independent before/after and mutation checks covered encoded payload leakage, raw SVG/outer suffix preservation, assigned-slot visibility, light-DOM slot semantics, and asynchronous cleanup. Reverting the relevant branches made the new assertions fail.
- Initial hosted CI: [2,104 passes, 20 skips and one trace-viewer failure](https://github.com/JustasMonkev/mcp-accessibility-scanner/actions/runs/42348448613). The fix reproduced that connection failure locally before passing. [Windows ARM64 smoke jobs](https://github.com/JustasMonkev/mcp-accessibility-scanner/actions/runs/42348448642) passed on the initial head. Current follow-up hosted status is in the PR checks; those earlier green jobs do not certify the new head.

## Known limits

This is tool-level regression coverage, not an exhaustive proof of every option, website, browser, OS or transport combination. Native extension attachment and a real VS Code editor UI were not exercised. The VS Code bridge did attach to a real external Playwright BrowserServer; after the provider-close fix, its child saved the final log before the parent exited. Default-provider and validation paths were also exercised. Browser installation used official pinned archive bytes served locally, so it does not validate the public CDN. Explicit JavaScript evaluation returns the requested raw value; data-URL truncation applies to rendered browser output, not a promise to sanitize arbitrary evaluated data. Docker is unavailable and WebKit lacks host libraries here.

An unrelated pre-existing optional-tool defect was reproduced: `browser_verify_list_visible` checks matching item counts and can report success for hidden items or an unexpected order. This PR does not change that tool. Its successful happy-path execution must not be interpreted as full correctness of its negative cases.

## Static tool execution inventory

Each name below was invoked through the live MCP protocol. This records execution coverage, not exhaustive correctness.

| Capability | Tools |
| --- | --- |
| core | `audit_keyboard`, `audit_screen_reader`, `audit_site`, `browser_click`, `browser_close`, `browser_console_messages`, `browser_default_timeout`, `browser_drag`, `browser_drop`, `browser_emulate_media`, `browser_evaluate`, `browser_file_upload`, `browser_fill_form`, `browser_find`, `browser_handle_dialog`, `browser_hover`, `browser_navigate`, `browser_navigate_back`, `browser_navigation_timeout`, `browser_network_request`, `browser_network_requests`, `browser_press_key`, `browser_resize`, `browser_select_option`, `browser_session_close`, `browser_session_open`, `browser_snapshot`, `browser_tabs`, `browser_take_screenshot`, `browser_type`, `browser_wait_for`, `scan_page`, `scan_page_matrix` |
| connect-tool / VS Code | `browser_connect` |
| install | `browser_install` |
| vision | `browser_mouse_click_xy`, `browser_mouse_drag_xy`, `browser_mouse_move_xy` |
| pdf | `browser_pdf_save` |
| devtools | `browser_start_recording`, `browser_stop_recording` |
| verify | `browser_verify_element_visible`, `browser_verify_list_visible`, `browser_verify_text_visible`, `browser_verify_value` |
