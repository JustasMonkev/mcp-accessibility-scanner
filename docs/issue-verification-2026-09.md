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
