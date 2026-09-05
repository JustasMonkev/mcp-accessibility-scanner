# Codex findings catalog

Condensed catalog of the 179 inline review findings the Codex bot (`chatgpt-codex-connector`) left on this repo's PRs (#44–#148, reviewed 2026). Organized by the defect pattern each illustrates; each entry cites the PR so you can read the full thread. Severity was P2 unless marked P1.

Codex's review behavior, for calibration: it re-reviews after every fix commit and escalates with fresh bypass evidence (PR #96 got 26 findings over 8 commits, #98 got 18); it reads cross-file context (CI workflows, factories, session log) rather than just the diff; and it reasons about concrete failure inputs, not style.

## Contents

1. [Silent no-op configuration](#1-silent-no-op-configuration)
2. [Validation after side effects](#2-validation-after-side-effects)
3. [Success reported for work not performed](#3-success-reported-for-work-not-performed)
4. [Sanitizer/truncator bypasses and corruption](#4-sanitizertruncator-bypasses-and-corruption)
5. [Races, timers, cancellation, shared state](#5-races-timers-cancellation-shared-state)
6. [Caps and limits](#6-caps-and-limits)
7. [Generated code and output validity](#7-generated-code-and-output-validity)
8. [DOM/a11y heuristic edge cases](#8-domally-heuristic-edge-cases)
9. [Refactor and dependency-bump regressions](#9-refactor-and-dependency-bump-regressions)
10. [CLI robustness](#10-cli-robustness)
11. [Docs drift](#11-docs-drift)
12. [Test and harness hygiene](#12-test-and-harness-hygiene)

## 1. Silent no-op configuration

- `--vscode --storage-state`: startup guard passes, but the VS Code factory returns `browser.contexts()[0]` without `setStorageState` — authenticated scans silently run anonymously (P1, #148).
- `--extension --isolated --storage-state`: guard validated `IsolatedContextFactory`, but the program then starts `ExtensionContextFactory`, which never applies `contextOptions` (#143).
- Storage state rejected for `remoteEndpoint`/CDP+isolated even though those factories create fresh contexts and could forward it; and rejected for persistent/CDP contexts even though pinned Playwright has `BrowserContext.setStorageState()` (#143, #142).
- `--mobile` silently ignored with `cdpLaunch`, `--extension`, and config-file `remoteEndpoint`/`cdpEndpoint`/env endpoints — validation only saw `cliOptions.cdpEndpoint`, not the merged config; `--mobile` + config-file `browserName: webkit` fell back to Chromium (#118, five findings).
- `PLAYWRIGHT_MCP_PING_TIMEOUT_MS` above 60000 had no effect: `server.ping()` was called without request options, so the SDK's default timeout fired first (#91).
- `browser_default_timeout` updates `page.setDefaultTimeout` but snapshot/title guards hard-coded `context.config.timeouts.defaultTimeout` — user-extended timeouts ignored (#93).
- Proxy backend forwarded `progressToken` but never bridged `onprogress` → `sendNotification`: progress silently dropped through the proxy (#50).
- Extension relay never forwarded `PLAYWRIGHT_MCP_EXTENSION_TOKEN` as a query param, so token-based reconnect fell back to manual approval (#131).
- Advertised vs enforced: with `--host 0.0.0.0` the server printed `http://0.0.0.0:<port>/mcp`, but its own Host-header allowlist rejected that Host with 403; earlier, wildcard binds never added interface IPs to `allowedHosts`, 403ing LAN/Docker clients (#73, #51).
- Blank env value: `Number('')` is `0`, so a present-but-empty `PING_TIMEOUT` hit the `<= 0` branch and disabled the heartbeat entirely, contra README (#91).
- `PLAYWRIGHT_MCP_CDP_HEADERS` split on commas broke comma-valued headers (`X-Forwarded-For: a, b`) (#101).

## 2. Validation after side effects

- Unknown `withRules`/`disableRules` IDs validated only after navigation; per-page catch turned the error into page failures, so `provided`-strategy audits visited every URL, marked all errored, and wrote a completed report instead of rejecting (#145).
- Same in `scan_page_matrix`: rule validation ran after viewport/media/zoom mutation and possible reload; `finally` restores emulation but not form/app state lost to the reload (#145).
- Empty `--input-file` → `''` parsed as `{}` → a default tool invocation ran instead of failing fast (#44).
- `withRules: []` treated as omitted, silently scanning the full tag set (#145).
- `clickCount` accepted 0/negative/fractional; after `.min(1)` was added, `1.5` still performed one click while reporting 1.5 — needed `.int()` too (#105, two rounds).

## 3. Success reported for work not performed

- When every snapshot ref went stale, `audit_screen_reader` returned `Findings: 0` / "No screen-reader-level issues detected" with `resolvedCount` zero — an unevaluated page presented as clean (#145).
- `includeIncomplete: false` suppressed detail blocks but the summary still printed `Incomplete: N`; conversely `totalIncomplete: 0` was emitted when collection was disabled — uncollected indistinguishable from clean (#141).
- Annotation layer: page CSS could hide the entire injected overlay while `marked` still counted every node; labels clipped by `overflow:hidden` on small elements; markers for off-canvas elements never appear in the PNG yet count as marked (#142).
- Completed download reported as `Downloaded file ... to <path>` after eviction had already unlinked the file (#98).
- Session-loss detection: skipped after failed navigations, so the *next* successful URL was blamed; redirect target not reported (`sessionLoss.url` kept the requested URL) (#143).

## 4. Sanitizer/truncator bypasses and corruption

PR #96 (data-URL truncation, 26 findings) and #95 (4 findings) — the canonical cluster. Grouped:

**Unsanitized output paths**: page/tab URL line; page `<title>`; `browser_console_messages` tool output (only the snapshot copy was sanitized); modal-dialog descriptions (the `modalStates` branch never reached the sanitized renderer); network request *query params* (`?src=data:...` didn't start with `data:`); `browser_find` snippets bypassed `truncateDataUrls` entirely (#95, #96, #111).

**Matcher bypasses**: uppercase `DATA:`; percent-encoded `data%3A` via URLSearchParams; mixed encoding (`base64%2C`); encoded metadata (`text%2Fhtml`); encoded wrapper prefix (`%22data%3A...`); Unicode case-mapping length shifts (`İ`) desyncing lowercase-search offsets; escaped spaces in media params rejected as invalid so nothing truncated (#96).

**Partial consumption (payload leaks)**: scan stopped at `<` for raw SVG/HTML payloads and appended the rest unchanged; `&` inside a raw HTML payload treated as query separator; huge media-type parameters copied wholesale before the ellipsis; `secret:1<tail>` colon treated as source-location suffix (#95, #96).

**Over-consumption (output corruption)**: closing quote and `[ref=e1]` swallowed, breaking follow-up element targeting; `#fragment` consumed as payload; console `@ file:line` suffix dropped; `%3E`-ending payloads never "complete" so trailing context eaten; nested encoded URL's `%26id%3D123` params dropped (#96).

**False positives on ordinary text**: `metadata:text,abc` rewritten because the substring matched; prose `data: total, average` treated as a data URL; `?type=data:text/html;base64&tags=a,b` corrupted by accepting the *next* parameter's comma as delimiter (#95, #96).

## 5. Races, timers, cancellation, shared state

- Heartbeat `Promise.race`: losing `setTimeout` never cleared — one leaked timer every 3s per HTTP session (#91).
- Wedged CDP page: after `captureSnapshot()`'s title read timed out, the all-tabs refresh immediately retried `updateTitle()` on the same tab, doubling the stall (#93).
- Abort signals: profile-discovery I/O merely *checked* the signal afterwards — an abort during `readdir` left context creation hung; an already-fired abort event is not replayed by a listener registered later (#136, two findings).
- Extension approval: protocol v2 opens the socket only after the user clicks Allow, but a 5s race timed out normal first-time approval (P1, #131).
- Interactive REPL called `process.exit(0)` before async `serverClosed()` disposal finished (#55).
- CDP child process left running when `browser.newContext()` rejected — cleanup existed only on the success path (#142).
- Running-tool stack: unconditional `pop()` in `finally` corrupted attribution when overlapping calls finished out of order; the first fix still read "newest entry" and was re-flagged; final fix used `AsyncLocalStorage` (#98, two rounds).
- Output eviction (`--output-max-size`, 13 race findings in #98): deleted a tool's own just-written screenshots before its response returned; active trace files mid-`tracing.stop()`; session-log `*.snapshot.yml` siblings of the protected `session.md`; pending downloads (including from already-closed tabs, and completed ones not yet reported); cross-session in HTTP mode (shared output dir, per-context protection was needed); cross-process via the shared `/tmp` fallback root (pid-scoping was needed); eviction not serialized with overlapping tools (a gate was needed).
- MCP HTTP init: 5s fallback timer fired on idle sessions, permanently initializing the backend with `[]` roots; any session GET marked the transport initialized before SSE validation accepted it (#109).
- Seed-tab cleanup: two overlapping `createTarget` calls both claimed the same seed tab; URL-prefix matching closed *another relay's* connect page; `_knownTabs` URLs go stale (no `onUpdated` listener), so a navigated former seed tab — now a real page — was closed (P1, #133).
- Stale tab state: `browser_navigate_back` / bfcache traversal changes the URL without a `response` event, so the rendered `HTTP status:` line showed the previous page's 402/500 (#110, #111); background tabs' titles went stale once `finish()` refreshed only the current tab (#93).
- Download listener used the 5s op timeout while navigation runs 60s — late-starting downloads made `browser_navigate` report an error though the download succeeded (#136).
- Annotations: animations left enabled between measure and capture, so markers drifted (#142).

## 6. Caps and limits

- `maxElements` not enforced on the final 50-element chunk: `51` analyzed 100, `1` analyzed 50 (#146, re-flagged in #145).
- Hidden (`aria-hidden`) refs consumed the analysis budget before filtering — 400 hidden refs meant zero visible elements audited (#146).
- Serial 1s timeout waits per stale ref: default audit could stall ~400s, max ~2000s (#146).
- `browser_find`: per-match `ancestorIndices` scanned backward through the whole tree — O(n²) on nested matches (#118).
- User-supplied regex run with backtracking `RegExp` — `(a+)+$` blocks the event loop; repo precedent is RE2 (#111).

## 7. Generated code and output validity

- `browser_drop` data with MIME keys emitted `{ data: { text/plain: 'hello' } }` — invalid JS in the repro snippet (#117).
- Locator-scoped bare expression emitted `locator.evaluate('() => (element.textContent)')` — replaying fails, `element` undefined (#117).
- In-page `eval` for expression support: CSP without `unsafe-eval` broke even `() => document.title` (P1 regression, #126, first raised #117); `typeof value === 'function'` auto-invoked `window.open`/`el.click` (Illegal invocation) (#126); direct `eval` shadowed page globals (`() => result` hit the wrapper's TDZ const) (#126); `(${expression})` rejected trailing semicolons (#126).
- ARIA compression appended its notice as a bare line inside the ```yaml fence — invalid YAML for parsing clients (#107).
- Harness assertions expected the unquoted arrow-function form while the tool emits `javascript.quote`d code (#120).

## 8. DOM/a11y heuristic edge cases

From the screen-reader audit (#146/#145/#148), keyboard audit (#144), and annotations (#142):

- **Shadow DOM**: visible label in shadow root → `visibleText: null`, check skipped; Axe shadow selector paths misclassified as iframes (#146, #142).
- **Iframes**: child-doc elements can't reach the embedding `aria-hidden` iframe via `closest()`; iframe-root sibling direction measured from the outer document (#146).
- **aria-hidden**: `"TRUE"` missed by case-sensitive selector (#145).
- **Visibility**: `visibility:hidden` root + `visibility:visible` descendant still renders text — root short-circuit wrong (#148); `opacity:0` element's text counted as "visible" for label-in-name (#145); `opacity:0` *ancestor* not checked before accepting a painted child in `paintsOver` (#144); hit-test ≠ visual occlusion — transparent overlay wins `elementFromPoint` (false "obscured"), `pointer-events:none` opaque overlay loses it (false pass) (#144).
- **Geometry**: `getBoundingClientRect()` ignores ancestor `overflow`/`clip-path` clipping (rejected as a documented ceiling after measurement) and returns scaled offsets under CSS zoom/transform that get re-applied doubled (#144, #142); off-canvas elements have nonzero rects but never appear in screenshots (#142); top layer (`<dialog>`/popover/fullscreen) paints above a `body`-appended overlay (#142).
- **No-text-node labels**: `<input type="submit" value="Send" aria-label="...">` bypassed label-in-name (#146).
- **Snapshot parsing**: YAML-quoted keys (`'button "Warning: Delete" [ref=e1]'`) silently dropped by the role regex, mis-parenting descendants (#146, re-flagged #145).
- **Normalize before comparing**: relative vs absolute same-destination `href`s flagged as "different targets"; element refs used as "targets" made repeated Save buttons always ambiguous (#146).
- **Spec semantics vs proxy**: inline exception is "in a sentence", not `display === 'inline'`; sentence detection must walk inline ancestors (`<strong><a>` wrapper); disabled controls aren't spacing neighbors; undersized-neighbor check needs box-vs-circle, not center distance; contenteditable is a target and must be measured for obscuration (#144).
- **Role coverage**: `option` missing from named-roles; filename-alt-text check ran on links, not just images; treegrid rows and range widgets (`separator`, `scrollbar`) and `[cursor=pointer]` nodes unprotected from compression (#146, #107).
- **Injected UI**: fixed `id` collides with page's own element (cleanup removed the page's node); inline styles overridable by author CSS `!important` (#142).
- **Session-loss cookie logic** (#142/#143/#148): track by name+domain+path, not name; snapshot the baseline once at crawl start (cookies minted mid-crawl aren't baseline); extend scope as URLs are discovered; keep monitoring after the first loss (list, not single); exclude cookies expiring at their own stated expiry; check after failed navigations too.

## 9. Refactor and dependency-bump regressions

- `package-lock.json` regenerated with npm 10 vs 11 dropped `libc` fields from native optional deps (`@rolldown/binding-*`, Oxlint, Lightning CSS) — `npm ci` installs incompatible glibc/musl binaries. Happened twice (#87, #139); the second time bundled into an unrelated one-line fix.
- `engines.node` raised to `>=24` inside a test-only PR — `EBADENGINE` for Node 18/20/22 consumers (P1, #63).
- `playwright`/`playwright-core` bumped to 1.62-alpha while `@playwright/test` stayed 1.61 — nested duplicate runtime, CLI/browser revision mismatch (#124).
- `finish()` narrowed "refresh all tabs" to "refresh current tab" — background tab titles went stale (#93).
- SHA-256 dedup fingerprint replaced with 32-bit FNV-1a; Codex produced two colliding HTML strings, showing occurrences silently skipped (#80).
- `noDefaults` forced for **all** CDP attach sessions removed `acceptDownloads`/focus/media defaults with no opt-out (#120); the behavior change also wasn't documented (#121).
- Named ESM imports from the CJS `playwright-core/lib/coreBundle` — works only via lexer heuristics; use default import + destructure (P1, #76).
- `SKILL.md` recipe still read the removed singular `sessionLoss` field after the rename to `sessionLosses` (#148).

## 10. CLI robustness

- `call --output json` emitted plain stderr text when `callTool` threw — JSON mode must wrap failures as `isError` payloads (#44).
- `list-tools | head` crashed with unhandled `EPIPE` (#44).
- Commander variadic `--cdp-header` consumed the following `interactive` subcommand as a header value (#101).

## 11. Docs drift

- README not updated for: new `HTTP status:` response line (#110); CDP `noDefaults` behavior change (#121). AGENTS.md mandates README sync and Codex checks it.
- OpenWiki claims vs reality (#127): quickstart said `install chromium` but the default channel is branded `chrome`; testing doc claimed the harness builds first (it runs whatever `lib/` exists); runbook's "install browsers" command actually ran the whole harness; browser-backed tests silently skip without the install.
- Coverage/harness scripts requiring uncommitted `lib/` build output on a clean checkout without saying so (#126, #127).

## 12. Test and harness hygiene

- Harness tests referenced non-exposed tool names (`browser_network_request`, `browser_drop`) — coverage verification fails (#120).
- Assertions didn't match actual generated-code format (quoted vs unquoted function) (#120).
- 15s `runCLI` abort on `ts-node/esm` startup → false `ETIMEDOUT` on cold CI runners; test the built entrypoint or relax the budget (#55).

## Owner-rejected findings (calibration)

Not every finding was accepted. The owner rejected some with measurements and documented them as ceilings: ref-less exposed nodes (decorative-dominated), ancestor-clipping detection (4 false positives per true positive), visual-occlusion false-negative half, auth-cookie classification (unimplementable without silent failures), experimental-rule tags mapping to real success criteria (README reworded instead). The lesson: a deliberate, measured, *documented* limitation is a valid answer to a checklist item — an unexamined one is not.
