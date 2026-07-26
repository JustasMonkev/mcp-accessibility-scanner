---
name: pre-push-review
description: Self-review a code change against the recurring defect patterns that automated PR review (Codex) keeps finding in this repo, and fix them locally before committing or pushing. Use this skill every time you are about to commit, push, or open a PR in this repository — after implementing a feature, fix, refactor, or dependency bump — even if the change looks small or you believe it is already correct. Also use it when asked to "review my changes", "check before pushing", or "make sure Codex won't flag this".
---

# Pre-push review: catch Codex findings before they reach GitHub

This repo's PRs are reviewed by the OpenAI Codex bot. An analysis of all 179 inline findings it left across ~50 PRs shows the same defect classes recurring again and again. Almost every one of them was detectable from the diff alone — which means you can catch them locally.

Work through the checklist below against your actual diff — everything that differs from the default branch (`git diff origin/main...HEAD`, or `git diff main...HEAD` in a checkout with no `origin` remote; if neither ref exists, diff against the merge base of whatever ref tracks the default branch) plus any staged and unstaged changes. Don't treat it as a form to tick off: for each section, ask "does my change touch this territory?" — if yes, actively hunt for the failure mode described. Fix what you find, then run the final gate.

For concrete examples of every pattern (real findings with file/PR references), read `references/codex-findings-catalog.md`. Consult it whenever a section below feels abstract or you want to see what the failure looks like in practice.

## 1. Trace every option end-to-end — no silent no-ops

The single most common Codex finding (~20 occurrences): a flag, config field, or env var is accepted but silently ignored on some code path. `--storage-state` validated at startup but dropped by the VS Code/extension/CDP context factories; `--mobile` accepted with `remoteEndpoint`/`cdpLaunch`/`--extension` where context options are never applied; a configurable timeout that the SDK's own default overrides; a progress token forwarded but notifications never bridged through the proxy backend.

If your change adds or touches any option, setting, or env var:

- Enumerate **every** consumer path: launch modes (persistent, `--isolated`, `remoteEndpoint`, `cdpEndpoint`, `cdpLaunch`, `--extension`, `--vscode`), transports (stdio, HTTP), and the proxy backend. Grep for where the value is read.
- For each path, the option must be either **applied** or **rejected with a clear error at startup**. "Accepted but ignored" is never acceptable — the user believes they got the behavior (e.g. runs an "authenticated" audit that is actually anonymous).
- Validate against the **merged** config (CLI + config file + env), not just `cliOptions` — Codex caught mobile validation that only inspected the CLI flag while the config file smuggled in a CDP endpoint.
- Check the value is honored at runtime too: does a later runtime update (e.g. `browser_default_timeout`) actually reach the code that reads the config snapshot?
- Env var parsing: a present-but-blank value must not become `0`/`{}` and change semantics (blank `PING_TIMEOUT` disabled the heartbeat entirely). Values containing commas/colons must survive parsing (comma-splitting broke comma-valued headers).
- Consistency between what you advertise and what you enforce: the server printed a `0.0.0.0` URL that its own Host-header allowlist then rejected with 403.

## 2. Validate inputs before side effects

Codex repeatedly flagged validation that happens *after* navigation, page mutation, or crawl start — so bad input destructively alters state or produces a completed-looking report:

- Validate all tool arguments (rule IDs, URLs, selectors, files) **before** navigating, reloading, changing viewport/media/zoom, or starting a crawl. A `finally` that restores emulation cannot restore form or application state lost to a reload.
- Reject explicitly-empty inputs rather than coercing them to defaults: empty `--input-file` must not become `{}` and run a default invocation; `withRules: []` must not silently fall back to scanning everything.
- Constrain numeric schemas fully: positive **and** integer (`clickCount: 1.5` performed one click while reporting 1.5). Test the boundary values.
- An invalid argument must reject the call — not be converted into per-page "errors" while the tool still writes a completed report.

## 3. Never report success for work not performed

A "clean" result must be distinguishable from "nothing was evaluated":

- If every element ref went stale, every navigation failed, or annotation markers were hidden by page CSS, do **not** return "0 findings / no issues detected". Fail, retry, or prominently report what could not be evaluated.
- Structured output: a count that was never collected must be `null`/omitted, not `0` — consumers can't tell "uncollected" from "genuinely clean".
- If you count something as done (marked, scanned, downloaded), verify the artifact actually exists/is visible at response time. Codex found responses advertising file paths that eviction had already deleted, and screenshots "marked" whose annotations were clipped, off-canvas, or painted over.

## 4. Sanitizers, truncators, and parsers: enumerate paths and attack the boundaries

The data-URL truncation work drew 30 findings over two PRs — the largest cluster. When you write anything that filters/truncates/rewrites text in output:

- **Enumerate every output path** that can carry the data: snapshot body, page/tab URL line, page title, console messages (both the snapshot copy and the dedicated tool), network request URLs *and query params*, modal-dialog descriptions, `browser_find` snippets, downloads. Sanitizing one path while five others leak defeats the purpose.
- **Try to bypass your own matcher**: uppercase/mixed-case scheme, percent-encoded forms (`data%3A`, `%2C`), mixed encoding, wrappers (quotes, `url(...)`, JSON), Unicode case-mapping offset shifts, embedding inside another URL's query parameter.
- **Try to corrupt ordinary text**: does the substring match rewrite `metadata:text,abc` or prose like `data: total, average`? Anchor to real token boundaries.
- **Consume completely, preserve the rest**: partial consumption left payload tails after the ellipsis; over-consumption swallowed closing quotes, `[ref=...]` markers, query params, and fragments — breaking follow-up element targeting. Whatever follows the matched region must survive byte-for-byte.
- Write unit tests for each bypass/corruption case you considered. Codex re-reviewed after every fix commit and kept finding fresh bypasses; a test corpus is the only way to stay ahead.

## 5. Async, timers, cancellation, and shared state

- Every `setTimeout` used in a `Promise.race` must be cleared when the other branch wins — the losing timer otherwise accumulates per iteration (one leaked timer every 3s per HTTP session).
- Abort/cancellation signals must be **raced against** the pending I/O, not checked before/after it — and re-checked after any `await`, because an already-fired abort event is not replayed.
- Never `process.exit()` while async cleanup (context disposal, trace finalization) is still running — await it.
- Cleanup must run on **failure** paths too: a spawned CDP child process must be killed when `browser.newContext()` rejects, not only on success.
- Shared mutable state across overlapping calls: an unconditional `pop()` in `finally` corrupts a stack when calls finish out of order — use per-call tokens or `AsyncLocalStorage`. Anything keyed on "the newest/current entry" is suspect.
- Anything that deletes files (eviction, cleanup) must account for in-flight producers: active traces, pending downloads (including from already-closed tabs), sibling sessions in HTTP mode, and **other processes** sharing a temp root. Ask: "what is being written *right now* that my delete walk can see?"
- If tabs/pages are involved: does your state go stale when a background tab changes, when bfcache/history traversal changes the URL without lifecycle events, or when the page rerenders after a snapshot?

## 6. Enforce caps and limits exactly

- Chunked loops must respect the remaining budget on the final chunk (`maxElements: 51` analyzed 100; `maxElements: 1` analyzed 49 extra).
- Apply filters **before** consuming the budget: slicing raw refs let hidden elements exhaust the cap so visible content was never audited.
- Test a cap value that is not a multiple of your chunk size, and cap+1.

## 7. Generated code and structured output must be valid

- Any "Ran Playwright code" snippet must be replayable JavaScript: quote object keys that aren't identifiers (`{ 'text/plain': ... }`), keep the `(element) =>` parameter for locator-scoped expressions, don't emit a quoted string where a function is expected.
- Output embedded in a YAML/markdown fence must keep the fence parseable — a bare notice line inside the ```yaml fence made large snapshots invalid YAML.
- Don't `eval` in the page when Playwright can pass the function through — strict-CSP pages (`script-src` without `unsafe-eval`) break otherwise. Don't call values just because `typeof === 'function'` (`window.open`!); decide function-vs-expression from the source form.

## 8. DOM and accessibility heuristics: the recurring edge-case set

Every a11y heuristic PR (screen-reader audit, keyboard audit, annotations) got flagged for the same environments. When writing or changing any in-page heuristic, walk this list:

- **Shadow DOM** (labels/text in shadow roots; Axe selector paths through shadow boundaries)
- **Iframes** (aria-hidden does not cross the boundary via `closest()`; direction/metrics must come from the child document)
- **aria-hidden**: case-insensitive values (`"TRUE"`), inheritance, hidden elements consuming analysis budget
- **Visibility subtleties**: a `visibility:hidden` root with a `visibility:visible` descendant still renders text; `opacity:0` on an ancestor hides painted children; hit-testing (`elementFromPoint`) is not visual occlusion — transparent overlays win hit-tests, `pointer-events:none` overlays lose them
- **Off-canvas/clipped** elements: nonzero rects that never appear in a screenshot; `getBoundingClientRect()` ignores ancestor `overflow`/`clip-path` clipping; CSS zoom/transform scales rect coordinates
- **Top layer**: `<dialog>`, popover, fullscreen render above anything appended to `body`
- **Elements without text nodes**: `<input type="submit" value=...>` has a visible label but no child text
- **Snapshot parsing**: Playwright YAML-quotes keys whose accessible name contains `: `, `#`, braces — a regex that misses the quoted form silently drops the control
- **Normalize before comparing**: relative vs absolute `href`s are the same destination; raw attribute comparison creates false "different target" findings
- **Injected UI** must survive the page: unique per-scan IDs (the page may already use your ID), style isolation against author CSS, animations frozen between measurement and capture
- Measure the spec's semantics, not a proxy: "inline" for WCAG target-size means *in a sentence*, not `display === 'inline'`; disabled controls aren't pointer targets.

False positives matter as much as false negatives — several findings were "this reports a violation a screen-reader user would never encounter". When you deliberately accept a detection ceiling, document it (the owner rejected several findings with measurements; that's a valid outcome, but a *decided* one).

## 9. Refactors and dependency bumps: don't narrow behavior silently

- After a refactor, diff the *behavior*, not just the code: "refresh all tabs" quietly became "refresh current tab"; SHA-256 fingerprints became a 32-bit FNV hash with demonstrated collisions; forcing `noDefaults` for **all** CDP sessions removed download/focus/media defaults with no opt-out.
- **Lockfile diffs are review surface.** Twice, a regenerated `package-lock.json` dropped `libc` fields from native optional deps (npm 10 vs 11), making `npm ci` install incompatible glibc/musl binaries. Also check for version splits (`playwright` bumped while `@playwright/test` lagged, nesting a duplicate runtime). Don't ship unrelated lockfile rewrites inside a focused change.
- Never change `engines.node` (or any published contract: package name, binary name, tool names, report fields) as a side effect of an unrelated change.
- ESM/CJS interop: use default-import + destructure for CommonJS bundles (`playwright-core/lib/...`); named ESM imports from CJS rely on lexer heuristics.
- If a consumed field/behavior was removed or renamed, grep the whole repo for readers of the old name.

## 10. CLI and process robustness

- Error paths must honor the output contract: `--output json` must emit JSON on failure too (wrap as an `isError` payload), not plain stderr text.
- Handle `EPIPE` on stdout so `list-tools | head` doesn't crash with a stack trace.
- Commander: variadic options swallow following subcommands (`--cdp-header X interactive` ate `interactive`); use repeatable single-value options with an accumulator.
- Exit codes and cleanup ordering (see §5 on `process.exit`).

## 11. Docs and contract sync

AGENTS.md requires README updates for user-facing changes, and Codex enforces it:

- Grep `README.md`, `SKILL.md`, and `openwiki/` for every flag, field, tool output line, or behavior you changed. A report field you renamed (`sessionLoss` → `sessionLosses`) leaves recipes reading an absent field.
- Docs must describe what the code *does*: don't claim the harness builds first when it doesn't, or document an install command that also runs the full harness.
- New user-visible output lines (e.g. `HTTP status:`) are part of the documented tool response format — document them.

## 12. Tests and harness hygiene

- Assertions must match the *actual* output format (the harness asserted an unquoted arrow function while the tool emits a quoted one; it referenced tool names that aren't exposed — `browser_network_request` vs `browser_network_requests`).
- No fragile timeouts: budget for cold CI runners (loader startup blew a 15s budget), and prefer testing built entrypoints over `ts-node/esm` startup.
- Nothing in the default test/coverage path may require uncommitted build output (`lib/`) without building first or saying so.
- User-supplied regexes executed server-side need RE2 or bounding — `(a+)+$` hangs the event loop (the repo already uses RE2 for crawl exclusions; match that).

## Final gate

After fixing what the checklist surfaced, run and pass:

```bash
npm run lint    # oxlint --type-aware + tsc --noEmit
npm test        # vitest
npm run build   # tsc — required before test:mcp, which runs the built cli.js
```

Then re-read your full diff one last time with fresh eyes, asking the two questions Codex asks best:

1. *"On which input, mode, or timing does this silently do the wrong thing?"*
2. *"Does everything this change claims (in output, docs, and option surface) actually happen on every path?"*

Only then push.
