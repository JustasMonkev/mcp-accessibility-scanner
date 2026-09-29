# September 2026 browser verification

## History references (#231)

`tests/history-downloads.integration.test.ts` exercises direct Playwright APIs and
the MCP protocol through an in-process transport, both over CDP and through a
normally launched browser. Its local pages cover an initial plain reference,
four consecutive back-navigation cycles using returned main-frame and iframe
references, and preservation of the form value and history length. No reload or
replacement navigation is used to recover references. The default CDP fixture
retains Playwright's supported launch flags, including
`--disable-back-forward-cache`.

On Linux, Node 24.19.0, paired Playwright/playwright-core 1.63.0 and bundled
Chromium **headless shell** 153.0.8010.12, all four history cases passed. No bfcache
restores were observed, so this verifies ordinary history traversal only.
The full Chromium executable could not launch in this container because its
native ProcessSingleton socket was denied. Hosted CI then exercised full
browsers on Node 24.20.0 with the same paired Playwright dependencies:

| Browser | Platform | CDP with BFCache explicitly enabled | Normal launched control |
| --- | --- | --- | --- |
| Chromium 153.0.8010.12 | Linux and Windows | Iframe contents missing after back, both direct and MCP | Passed |
| Chrome 153.0.8010.53 | Windows | Iframe contents missing after back, both direct and MCP | Passed |
| Edge 153.0.4234.48 | Windows | Iframe contents missing after back, both direct and MCP | Passed |

These failures occurred in [Actions run 35691616856](https://github.com/JustasMonkev/mcp-accessibility-scanner/actions/runs/35691616856)
with the original fixture deliberately removing Playwright's BFCache-disabling
flag. The upstream maintainer [closed the report as unsupported](https://github.com/microsoft/playwright/issues/42777#issuecomment-5739095543).
[Playwright documents](https://playwright.dev/docs/navigations#backforward-cache-bfcache)
that restoring cached documents desynchronizes its page state. This is a known
upstream limitation, **not a fixed BFCache implementation** in this server.

For a user-managed external browser, explicitly start it with
`--disable-back-forward-cache` before attaching, or use normal server-launched
mode. No attached browser's settings, history, form state, or tabs are silently
changed. The original unsupported-mode reproduction remains available and is
expected to fail on the pinned full browsers:

```sh
MCP_TEST_ENABLE_BFCACHE=1 npx vitest run tests/history-downloads.integration.test.ts -t 'back navigation'
```

The opt-in probe logs `pageshow.persisted` and the observed Playwright frame list
after each back operation. Headless-shell passes with no observed restores do not
establish BFCache support.

## Persistent-profile downloads (#230)

The same test file launches two separate browser instances against one newly
created disposable profile. It verifies profile reuse with persisted local
storage, exact saved download bytes, a live browser connection, a subsequent MCP
snapshot, and an MCP ping. An isolated-context case repeats the sequence and
checks that storage is not reused. Only fixture-owned temporary profiles are
removed. These tests use the MCP server in process; they do not test an external
stdio server process's lifetime.

Both Linux headless-shell cases passed on the versions above. Hosted
[diagnostic run 35692199642](https://github.com/JustasMonkev/mcp-accessibility-scanner/actions/runs/35692199642)
confirmed native browser crashes on the second persistent-profile launch:

| Browser | Platform | Observed native exit |
| --- | --- | --- |
| Chromium 153.0.8010.12 | Linux | SIGSEGV (signal 11), native stack captured |
| Chromium 153.0.8010.12 | Windows | Access violation, exit 3221225477 (0xC0000005) |
| Chrome 153.0.8010.53 | Windows | Access violation, exit 3221225477 (0xC0000005) |
| Edge 153.0.4234.48 | Windows | Access violation; this control passed the earlier run, so failure is intermittent |

The fixture received HTTP 200 and a Playwright download event before browser
disconnection; `saveAs()`/`path()` rejected with target-closed errors and no file
was saved. First launches and isolated controls passed. This confirms a native
failure in these conditions, without identifying its C++ root cause or claiming
that another browser version is safe. [Issue #230](https://github.com/JustasMonkev/mcp-accessibility-scanner/issues/230)
and the [upstream report](https://github.com/microsoft/playwright/issues/42831)
remain relevant; no browser flags, profiles, browser defaults or dependency pins
are changed to work around the crash.

The local fix is failure reporting: previously the tool returned a successful
response still saying “Downloading” after `saveAs()` had failed. Failed saves now
produce a named tool error in the current or next response, even if the page has
closed or the next tool itself fails because no page exists. Failed history
entries show failure rather than an ongoing download or a saved artifact. Closing
an explicit session reports any save failure alongside the completed session
close. The context retains at most 20 bounded error messages between responses,
with an explicit count of additional omitted failures.

The regression still requires exact saved bytes and a live browser for every
first launch, isolated context, headless-shell control and unlisted version. Only
the exact platform/channel/version tuples above, paired with Playwright and
playwright-core 1.63.0 on the second persistent launch, may instead verify the
known native failure contract: download event and target-closed failure, closed
page and disconnected browser, no artifact, a named `isError` response, and a
successful MCP ping. Such an outcome logs `known-native-crash-reported`; it is
**not a successful download or a fixed native crash**. Removing the retained-error
drain makes the closed-tab reporting regression fail.

`--isolated` is an explicit alternative whose two-launch controls passed; it
does not preserve profile state between launches. Use recorded storage state if
that mode needs an authenticated starting session. Do not reset a real profile
or silently switch browsers to work around this failure.

## Running the focused checks

```sh
npm ci
npx playwright install chromium
npx vitest run tests/history-downloads.integration.test.ts
```

`MCP_TEST_BROWSER_CHANNEL` selects `chromium` (default), `chrome`, or `msedge`.
Those channels must be installed. For a restricted Linux container that supports
only the bundled headless shell, the explicit control is:

```sh
MCP_TEST_BROWSER_CHANNEL=chromium-headless-shell npx vitest run tests/history-downloads.integration.test.ts
```

The headless-shell control does not substitute for the full Chromium or Windows
matrix. No production browser-channel or profile defaults were changed.

## Load-time dialogs and accessible names (#235)

The paired 1.63.0 dependencies reproduce both local defects. Navigation previously
waited for DOMContentLoaded behind an alert, confirm or prompt. The MCP navigation
tool now returns the pending dialog, leaves it untouched, and permits the dialog
handling tool to finish the action. Crawlers still wait for document readiness
and retain their navigation timeout, except when a dialog opens (see below). An already-open modal rejects a new
navigation before clearing collected state. Regression tests cover subsequent
navigation, downloads, late failures and listener cleanup. Removing the modal
race makes the real alert regression fail.

The actual AI snapshot renderer emits literal names such as `/` and `/docs/`
unquoted. The screen-reader audit parser now preserves those names, including
backslashes, quotes and YAML-quoted keys, without consuming reference metadata or
inline text. Real Chromium snapshots and a parser mutation verify the behavior.
All 86 nearby screen-reader tests and 161 navigation/crawler tests passed on the
pinned dependencies and Chromium headless shell 153.0.8010.12.

A later re-check of `audit_site` over a local site (Chromium headless shell, navigation
timeout 3 s) found the crawl's single tab was the weak point. A page raising `alert()`
while it was parsed, from a `DOMContentLoaded` listener, or as a `confirm`/`prompt` left
that dialog open in the crawl tab, so every later, healthy page timed out on `page.goto`
and was reported as failed (4 pages took 9.3 s and only the first was scanned). A dialog
raised from a `load` listener or a timer stalled the crawl for good, because the page's
`evaluate` never returns while a dialog is open. The crawl still answers no dialog, but it
now gives up on a page the moment its dialog opens, reports it with the dialog named, and
continues in a fresh tab after closing the frozen one; the same run scans every other page
in about 1 s. The tab the tool was called from is never touched. Regression tests in
`tests/navigation-dialogs.test.ts` fail without the change. The crawl navigation timeout
still applies to pages that stall without a dialog. Separately, a navigation timeout that
expired behind an unanswered dialog was delivered by `browser_console_messages` with a
stack frame into this server's own files; it is now the message alone.

## Client certificates and proxy routing (#235)

Disposable local certificates and an HTTP recording proxy reproduced the
Playwright 1.63.0 routing defects: isolated contexts with certificates ignored a
launch-only proxy, while certificate interception ignored bypass rules in both
isolated and persistent contexts. The persistent no-bypass control used its proxy.
The HTTPS fixture confirmed the disposable client certificate reached the origin.

Merged configuration now carries the configured launch proxy into fresh contexts
when client certificates are present, preserving an explicit context proxy
override. A nonblank effective bypass list is rejected before browser creation;
the upstream interceptor cannot honor it on this pin. Eight post-fix HTTP/HTTPS
routing cases passed, including isolated and persistent contexts and no-certificate
controls. Run `npm run build && node tests/client-certificate-proxy-probe.mjs`
with OpenSSL and the pinned Chromium installed to repeat this matrix. All 103
configuration tests passed; removing either proxy propagation or bypass rejection
fails its regression. No real credentials or user profiles were used.

## Linux WebKit (#235)

On Ubuntu 24.04.3 x86_64, the pinned WebKit 26.6 revision 2359 bundles libsoup
3.6.5. The upstream report also involves a different Ubuntu/architecture setup. Local execution is blocked
by missing system libraries; dependency installation cannot complete in this
restricted container. This confirms the affected library version, not a local
crash or vulnerability.

`node tests/webkit-network-probe.mjs` runs a bounded HTTPS/WebSocket stress probe
on the pinned browser. CI installs WebKit and its system dependencies first.
Hosted run 35691616856 completed all 200 rounds on WebKit 26.6 with 268
cancelled subresources, open holder WebSockets and no recorded network errors.
This means no crash was observed in that probe; it does not establish that the
upstream native race is absent. No library preload, browser switch, profile
reset or dependency upgrade is included.

## Combined validation

`npm run lint`, `npm run build` and `npm run knip` pass. With the explicit
`MCP_TEST_BROWSER_CHANNEL=chromium-headless-shell` control, the full Vitest suite
passes **54 files / 1,252 tests, with no skips**. This environment selection is
confined to the history/download fixture; production browser defaults are intact.

## CDP attach and numpad keys (#244)

**Upstream status on 2026-09-27.** npm `latest` is still Playwright 1.63.0, and
`next` is `1.64.0-alpha-2026-09-27`. The alpha's `playwright-core` bundle was
inspected without being installed. It contains
[#42913](https://github.com/microsoft/playwright/pull/42913) (`isKeypad` on
Chromium key events). It does not contain
[#42936](https://github.com/microsoft/playwright/pull/42936) (no
`Inspector.enable` during page initialization) or
[#42927](https://github.com/microsoft/playwright/pull/42927) (`NumpadDecimal`
still has key `"\0"`). Both PRs are still open upstream. The paired
`playwright`/`playwright-core` pins stay at 1.63.0: there is no alpha
dependency and no vendored browser internals.

**CDP attach with a tab without a renderer.** A disposable browser, launched
with `--remote-debugging-port`, gets one healthy tab and one tab crashed through
`chrome://crash`. Then the attach is retried. This container cannot install
Playwright's bundled browser. Local runs therefore used the preinstalled
Chromium 141.0.7390.37 (full and headless shell) with the paired 1.63.0
dependencies. In CI, the regression tests below showed the same hang on the
bundled Chromium 153.0.8010.12 headless shell. Observed behavior:

| Attach | Result on 1.63.0 |
| --- | --- |
| `connectOverCDP`, `timeout: 3000` | `TimeoutError` after ~3s; the call log reaches `<ws connected>` |
| `connectOverCDP`, `timeout: 0` | Still pending after an 8s guard (unbounded hang) |
| Endpoint that accepts TCP but never answers | `TimeoutError` without `<ws connected>` |
| Refused endpoint | Immediate `ECONNREFUSED` |

The user's tabs were unchanged after every failed attempt: the same URLs and
titles appeared in `/json/list`. A Memory Saver discard was not reproduced
locally, because it needs a headed browser with internal debug pages. The
upstream PR's tests show that discarded tabs go through the same
renderer-less path.

The server cannot make such a tab attach without reloading or closing it,
which it must not do. Neither `noDefaults` nor `--isolated` skips the
initialization. Instead, the failure is now bounded and explained:

- `--cdp-endpoint` rethrows Playwright's timeout error, call log included. When
  the call log shows `<ws connected>`, it appends a note naming the crashed or
  discarded tab and the remedy.
- `--cdp-launch` previously said only `Timed out waiting for CDP endpoint …`,
  although the endpoint had answered. It now appends the same note when an
  attempt timed out after the WebSocket connected.
- `--cdp-launch` also awaited each attach attempt in full before checking its
  startup deadline. A hung attach could therefore outlast
  `--cdp-launch-startup-timeout` by a longer `--cdp-timeout`, or hang forever
  with `--cdp-timeout 0`. Each attempt is now capped at the remaining startup
  budget, and at `--cdp-timeout` when that is positive.
- Unreachable endpoints keep their unchanged errors; they are not blamed on a
  tab.

`tests/cdp-attach.integration.test.ts` covers the direct Playwright attach
and both MCP paths. The endpoint test uses `cdpTimeout: 2000`. The launch
tests use `startupTimeoutMs: 3000` with `cdpTimeout` 1000 and 0, where the
"launched application" forwards to the prepared browser. On 1.63.0 each MCP
attach must fail with the note well inside the configured budgets: ~2.2s and
~3.3s locally, against a 15s bound far below Playwright's 30s default. The
`cdpTimeout: 0` launch hung before the cap. The launched
application must be stopped, and the browser's tab list must be unchanged.
Removing the note makes both MCP tests fail. On any other Playwright version,
all three tests require the fixed contract: the attach succeeds, the healthy
tab is listed, and the crashed tab is omitted but not closed. An upgrade
therefore has to prove #42936. The note's wording names 1.63.0; revise it
together with the upgrade.

**Numpad keys through `browser_press_key`.** The test in
`tests/numpad-keys.integration.test.ts` presses each key through the MCP tool
into a focused textarea. It records `key`, `code`, `location` and `keyCode`
for `keydown`/`keyup`, plus the typed value. The expected model is
Playwright's US layout: NumLock-off keys, Shift yields the digit or decimal
point, and every event is at `DOM_KEY_LOCATION_NUMPAD` (3).

Recorded with Playwright 1.63.0. Chromium 153.0.8010.12 (the bundled build, CI)
and Chromium 141.0.7390.37 (local) produced identical events. Firefox 155.0 and
WebKit 26.6 ran on Linux in the `keyboard-controls` CI job. Values are
`key`, `keyCode`, `location` for keydown → keyup, then the typed value:

| Press | Chromium 153 / 141 | Firefox 155.0 | WebKit 26.6 |
| --- | --- | --- | --- |
| `NumpadSubtract` | `-`, 109, 3 → **1**; types `-` | `-`, 109, 3 → 3; types `-` | `-`, 109, 3 → 3; types `-` |
| `NumpadDecimal` | **`"\u0000"`**, 46, 3 → **1**; types nothing | **`"\u0000"`**, 46, 3 → 3; types nothing | **`"\u0000"`**, 46, 3 → 3; types nothing |
| `Shift+Numpad1` | `1`, **35 (End)**, 3 → **1**; **types nothing** | `1`, 35, 3 → 3; types `1` | `1`, 97, 3 → 3; types `1` |
| `Shift+NumpadDecimal` | `.`, **46 (Delete)**, 3 → **1**; **types nothing** | `.`, 46, 3 → 3; types `.` | `.`, 110, 3 → 3; types `.` |

Bold marks a deviation from the modeled events, which expect key `Delete` for
`NumpadDecimal` and location 3 on every event. Firefox's `keyCode` for shifted
digits is also the unshifted value, but it still types the digit. On Linux,
WebKit typed nothing for `NumpadDecimal`: no U+0000 was inserted.

These results match the upstream diagnoses. The Chromium keyup location is
#42913. `NumpadDecimal` in every engine, and the Chromium shifted digits, are
#42927. The server forwards keys unchanged; remapping them locally would diverge
from Playwright's layout. The test pins exactly these deviations per
`1.63.0/<engine>`. Any other Playwright version, or an engine without an entry,
must deliver the modeled events.

Focused checks:

```sh
npx vitest run tests/cdp-attach.integration.test.ts tests/numpad-keys.integration.test.ts
MCP_TEST_BROWSER_NAME=firefox npx vitest run tests/numpad-keys.integration.test.ts
MCP_TEST_BROWSER_NAME=webkit npx vitest run tests/numpad-keys.integration.test.ts
```

## WebKit nested details visibility (#246)

Playwright's injected visibility check uses `Element.checkVisibility()` except
in WebKit, where a manual fallback inspects only the nearest `details` or
`summary`. The shipped `playwright-core` 1.63.0 bundle contains that fallback,
so an open `<details>` nested inside a closed one, and everything in it, counts
as visible to AI snapshots and `getByRole`. The upstream fix,
[microsoft/playwright#42951](https://github.com/microsoft/playwright/pull/42951),
checks every ancestor instead. It is unmerged, and 1.63.0 is still the latest
stable release; only `1.64.0-alpha` builds follow it.

`tests/details-visibility.integration.test.ts` resolves the server's own
`--browser <engine> --isolated --headless --caps verify` configuration and
drives it over MCP with the upstream fixture. With the outer details closed it
checks the `browser_navigate` snapshot, `browser_find`,
`browser_verify_element_visible` and `browser_verify_text_visible`. It then
opens the outer details by clicking its summary with `browser_click`, and
requires the inner summary and button to be discoverable through all four.

Every engine and version must hide the nested contents while the outer details
is closed, except WebKit with exactly `playwright` and `playwright-core` 1.63.0.
That pin must instead reproduce the known defect: the closed-state snapshot,
find result and both verifications all expose the hidden button, and the run
logs `known-webkit-nested-details-leak`. This is **a reproduced upstream defect,
not a fix**. Changing either package's version makes the WebKit check demand
the correct behavior, so an upgrade fails unless the new release contains the
fix. Once a stable release does, upgrade `playwright` and `playwright-core`
together and install its browsers. No snapshot filtering, dependency patch or
alpha pin is included.

Hosted [run 36325621479](https://github.com/JustasMonkev/mcp-accessibility-scanner/actions/runs/36325621479)
on Linux, Node 24.21.0 and the paired 1.63.0 dependencies, before the text
verification was added:

| Browser | Outer details closed | After opening |
| --- | --- | --- |
| Chromium 153.0.8010.12 | Hidden from snapshot, find and verification | Discoverable |
| Firefox 155.0 | Hidden from snapshot, find and verification | Discoverable |
| WebKit 26.6 | Button exposed with a reference, found and verified (`known-webkit-nested-details-leak`) | Discoverable |

Locally, the pinned dependencies with Chromium 141.0.7390.37 also passed; this
container cannot download the pinned browser builds. `MCP_TEST_BROWSER_NAME`
selects `chromium` (default), `firefox` or `webkit`, as for the numpad test. The
default Chromium case skips when the bundled Chromium is not installed, like
the other real-browser tests; an explicitly selected engine never skips.
`npm test` runs the Chromium case in CI. The `webkit-regressions` job runs
WebKit and a Firefox control:

```sh
npx playwright install --with-deps webkit firefox
MCP_TEST_BROWSER_NAME=webkit npx vitest run tests/details-visibility.integration.test.ts
MCP_TEST_BROWSER_NAME=firefox npx vitest run tests/details-visibility.integration.test.ts
```

The fixture uses light DOM only. It does not show whether Axe or the custom
audit tools share the defect.
