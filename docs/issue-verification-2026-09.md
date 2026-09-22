# September 2026 browser verification

## History references (#231)

`tests/history-downloads.integration.test.ts` exercises direct Playwright APIs and
the MCP protocol through an in-process transport, both over CDP and through a
normally launched browser. Its local pages cover an initial plain reference,
four consecutive back-navigation cycles using returned main-frame and iframe
references, and preservation of the form value and history length. No reload or
replacement navigation is used to recover references. The CDP fixture enables
back/forward caching and reports observed `pageshow.persisted` restores.

On Linux, Node 24.19.0, paired Playwright/playwright-core 1.63.0 and bundled
Chromium **headless shell** 153.0.8010.12, all four history cases passed. No bfcache
restores were observed, so this verifies ordinary history traversal only.
The full Chromium executable could not launch in this container: its native
ProcessSingleton socket was denied (`Operation not permitted`, SIGABRT), before
any page or snapshot operation. This is an environment limitation, not a
reproduction of stale references. Full Chromium and installed-browser results
must come from the CI browser matrix before concluding the report is resolved.

## Persistent-profile downloads (#230)

The same test file launches two separate browser instances against one newly
created disposable profile. It verifies profile reuse with persisted local
storage, exact saved download bytes, a live browser connection, a subsequent MCP
snapshot, and an MCP ping. An isolated-context case repeats the sequence and
checks that storage is not reused. Only fixture-owned temporary profiles are
removed. These tests use the MCP server in process; they do not test an external
stdio server process's lifetime.

Both Linux headless-shell cases passed on the versions above. **Windows has not
been verified locally.** The CI matrix runs the same cases on Windows with
bundled Chromium, Chrome, and Edge, and on Linux with full bundled Chromium.
Each run prints its exact browser and dependency versions; failed native launches
retain Playwright's browser exit diagnostics. Do not treat the Linux controls as
evidence that the Windows crash is fixed.

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
and retain their navigation timeout. An already-open modal rejects a new
navigation before clearing collected state. Regression tests cover subsequent
navigation, downloads, late failures and listener cleanup. Removing the modal
race makes the real alert regression fail.

The actual AI snapshot renderer emits literal names such as `/` and `/docs/`
unquoted. The screen-reader audit parser now preserves those names, including
backslashes, quotes and YAML-quoted keys, without consuming reference metadata or
inline text. Real Chromium snapshots and a parser mutation verify the behavior.
All 86 nearby screen-reader tests and 161 navigation/crawler tests passed on the
pinned dependencies and Chromium headless shell 153.0.8010.12.

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
A clean run means no crash was observed in that probe; it does not establish that
the upstream native race is absent. No library preload, browser switch, profile
reset or dependency upgrade is included.

## Combined validation

`npm run lint`, `npm run build` and `npm run knip` pass. With the explicit
`MCP_TEST_BROWSER_CHANNEL=chromium-headless-shell` control, the full Vitest suite
passes **54 files / 1,246 tests, with no skips**. This environment selection is
confined to the history/download fixture; production browser defaults are intact.
