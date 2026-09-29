# Browser upgrade validation (#251)

## Decision — 2026-09-28

Retain paired `playwright` / `playwright-core` **1.63.0**. The [latest stable
release](https://github.com/microsoft/playwright/releases/tag/v1.63.0) is still
1.63.0. The [Firefox r1553 roll](https://github.com/microsoft/playwright/pull/42958)
merged on September 28 at commit `8db08308251b88015f2b4019f821c9ac2ecfceda`,
**after** that release. It changes Option-key text insertion and frame focus,
not the separate crash-window retention path. The five bug reports below were
open when checked. No private engine patch, prerelease, default-browser change,
or downgrade is included.

This is a validation/platform-guidance response to [#251](https://github.com/JustasMonkev/mcp-accessibility-scanner/issues/251),
not a claim that the upstream defects have been fixed. Package names, binaries,
tools, and production runtime code are unchanged.

## Local environment and observations

macOS **26.5.2**, arm64, Node **26.5.0**, paired Playwright **1.63.0**:

| Browser | Bundle/version |
| --- | --- |
| Chromium and Chromium headless shell | r1243 / 153.0.8010.12 |
| Chrome channel | 153.0.8010.53, temporary profile |
| Firefox | r1543 / 155.0 |
| WebKit | r2359 / 26.6 |

Every browser/profile in the fixtures is disposable. Existing user tabs and
profiles are never navigated, reloaded, patched, or killed.

| Upstream report | Observed result | What remains unproved |
| --- | --- | --- |
| [CDP main-frame corruption #42955](https://github.com/microsoft/playwright/issues/42955) | **Reproduced** through endpoint and launch factories. `page.url()` and raw CDP still identify the top document; Playwright evaluation reaches `about:srcdoc`, `window.top !== window`, the top locator matches zero elements, and the scoped Axe scan rejects the missing top selector. A fresh context created after attachment evaluates, locates and scans the top document correctly. | Timing changes the signature: evaluation can reach the top before the later locator/scan is redirected. Upstream also reports destroyed execution contexts. |
| [Screenshot font changes #42962](https://github.com/microsoft/playwright/issues/42962) | **Reproduced** via `browser_take_screenshot`. Viewport capture preserves actual fonts and geometry. Headless-shell full-page capture changes all five generic families; Chrome changes monospace only, with unchanged measured geometry. Navigation restores the original metrics. | Other platforms/font installations need their own measurements. Chrome is not a universal unaffected control. |
| [WebKit lost navigation abort #42957](https://github.com/microsoft/playwright/issues/42957) | **Reproduced on hosted Linux/r2359**, with protocol evidence: `provisionalLoadFailed` precedes the document request for the same loader, then `goto` times out. Local macOS completed 350 fresh-page COOP+COEP navigations (93.6 seconds). MCP normal navigation, intercepted abort, bounded stall and recovery controls pass. | The race is intermittent; passing stress is not proof of a fix. The pin permits only a served-but-uncommitted timeout signature on Linux and requires same-page recovery. Future versions must succeed or deliver cancellation instead of losing it. The no-document-request variant still needs validation. |
| [WebKit macOS 14 #42964](https://github.com/microsoft/playwright/issues/42964) | Installed `browsers.json` confirms r2251 overrides for `mac14` and `mac14-arm64`; this host uses r2359 and passes page setup/navigation. | **Reproduced on hosted macOS 14.8.9 arm64/r2251** (see below); not a local macOS 26 result. Page-dependent controls cannot run on the affected bundle. No downgrade has been verified or recommended. |
| [Firefox retained crash windows #42956](https://github.com/microsoft/playwright/issues/42956) | An explicitly opted-in Linux fixture compares 10 normal and 10 crash/context-close cycles after warm-up, reports parent RSS, checks subsequent browser usability, and crashes the sole page of a fresh persistent profile before opening three new pages. | RSS is diagnostic, not a count of retained native windows. A future fix needs native-window/memory-report evidence as well; a closed Playwright context alone cannot prove cleanup. See hosted results below. |
| [Firefox Option-key/frame-focus roll #42958](https://github.com/microsoft/playwright/pull/42958) | **Option insertion reproduced:** MCP `Alt+a` sends keydown/keyup and an input event inserting `a` in Firefox; Chromium/Chrome/WebKit insert nothing. All tested engines report `[true,false,false]`, `[true,true,false]`, `[true,true,true]` for top/child/nested focus respectively. | No frame-focus failure reproduced in these controls. r1553 itself is not adopted or claimed tested. Recheck focused and unfocused controls on a containing stable release. |

### Headless-shell font measurements

Measurements use `CSS.getPlatformFontsForNode`, not only `getComputedStyle`.
The fixture is taller than the viewport; values below are before/after full-page
capture. Viewport capture leaves the entire sampled metrics object unchanged.

| Family | Actual heading font | Last paragraph Y (px) |
| --- | --- | --- |
| sans-serif | Helvetica-Bold → Arial-BoldMT | 1960.46875 → 1999.46875 |
| serif | Times-Bold → TimesNewRomanPS-BoldMT | 2000.46875 → 2000.46875 |
| monospace | Courier-Bold → Menlo-Bold | 1960.46875 → 1960.46875 |
| cursive | Apple-Chancery → TimesNewRomanPS-BoldMT | 2378.46875 → 2000.46875 |
| fantasy | Papyrus → Impact | 2337.46875 → 2042.46875 |

On hosted Ubuntu 24.04 x64, only headless-shell **monospace** changed:
`DejaVuSansMono-Bold` → `LiberationMono-Bold`, last paragraph Y **1960.46875 →
1959.46875 px**. Viewport captures and the other four families stayed unchanged.
Both Linux CDP factory paths also reproduced the wrong-document/empty-locator
signature. The first Linux run caught profile cleanup racing surviving Chromium
children; the fixture now sends `Browser.close` to its owned browser before
removing the profile, with bounded filesystem retries.

These font observations describe the measured machines, not every installation
of the same OS. On 1.63.0, full-page font/layout changes are diagnostic because
installed fonts and browser builds vary; viewport stability and restoration on
reload remain strict. A new paired version must preserve all sampled metrics
across both screenshot modes on the machine running the check.

## Rerun

```bash
npm ci
npx playwright install chromium firefox webkit
npm test -- tests/cdp-frame-tree.integration.test.ts tests/browser-upgrade-controls.integration.test.ts
MCP_TEST_BROWSER_CHANNEL=chrome npm test -- tests/browser-upgrade-controls.integration.test.ts
MCP_TEST_BROWSER_NAME=firefox npm test -- tests/browser-upgrade-controls.integration.test.ts
MCP_TEST_BROWSER_NAME=webkit npm test -- tests/browser-upgrade-controls.integration.test.ts
```

The Chrome command requires Chrome to be installed. These Vitest tests import
source and do not depend on uncommitted `lib/` output. The default run uses only
bundled Chromium; other engines are explicit. JSON observations are emitted in
test output. Missing explicitly requested browser bundles are failures, not
silently skipped coverage.

Known deviations are characterized only for the exact paired **1.63.0** pins.
Other package versions must satisfy the intended top-document, unchanged-font,
and no-Option-text behavior. CDP's recorded race signatures are allowed on the
pin, not arbitrary errors; fresh-context controls always require correct scans.
A passing characterization run means the observations match the known limitation,
**not** that the dependency is fixed.

WebKit stress reports successful first attempts separately from delivered aborts
and known lost-abort timeouts. Any handled abort must leave the page usable on
the next navigation. Timeouts are permitted only on the paired Linux 1.63.0 pin,
after the fixture served the unique request but the page remained `about:blank`;
other failures are not accepted. This is the observed failure signature, not a
replacement for the protocol evidence below.

Only on a **disposable Linux runner**, with the pinned Firefox installed:

```bash
MCP_TEST_FIREFOX_CRASH=1 npm test -- tests/firefox-crash.integration.test.ts
```

The crash probe walks descendants of the test-launched Firefox parent, rechecks
ancestry, and signals only its web-content children. The persistent parent is
identified by the exact temporary profile argument. No global `pkill`/`killall`
or user browser endpoint is used. The probe is skipped by default and refuses
explicit execution on non-Linux hosts. CI opts in in its Firefox job.

## Hosted platform results

[Initial hosted run](https://github.com/JustasMonkev/mcp-accessibility-scanner/actions/runs/36449725328):
Ubuntu 24.04 x64 / Firefox 155.0 completed the normal/crash comparison and
persistent-profile recovery. Parent RSS grew **21.18 MiB** over ten normal cycles
and **181.80 MiB** over ten crash cycles after two warm-up cycles. This supports
the retention report, but is not a native-window count. Firefox's Linux Option
and nested-focus controls passed without text insertion.

macOS 14.8.9 arm64 installed frozen WebKit **r2251** and produced the expected
`Unknown setting: PushAPIEnabled` error after the browser was closed. Increasing
the test budget from 30 to 60 seconds showed that page creation remained pending,
not merely slow. The fixture now bounds its owned browser at five seconds,
closes it if creation stalls, and asserts the original protocol error after
cleanup; a new paired version must create a usable page without that closure.
Ubuntu WebKit r2359 initially completed **350** fresh-page COOP+COEP navigations
in **141.1 seconds**, but later runs reproduced the intermittent lost abort.
The macOS 14 job asserts the exact known page-setup failure on 1.63.0; subsequent
page-dependent controls are explicitly skipped there. Other versions must create
a page and pass the navigation/keyboard controls. A macOS 14 Chromium job runs
the full-page screenshot font/geometry measurement on the platform where the
defect was reported; on 1.63.0 it is diagnostic, and a new paired version must
preserve every sampled metric. Local macOS 26 results must not be substituted
for macOS 14, Linux crash retention or Linux font measurements.

### WebKit event-order reproduction

The [instrumented Linux job](https://github.com/JustasMonkev/mcp-accessibility-scanner/actions/runs/36451930051/job/109028564797)
failed on fresh navigation **292**, after 291 successful attempts. Its
`DEBUG=pw:protocol` trace records page proxy `4681`, loader `4690`, original
target `page-4682`, and provisional target `page-4693` in this received order:

```text
16:36:54.677  SEND Playwright.navigate
16:36:54.683  RECV Target.targetCreated (page-4693, isProvisional: true)
16:36:54.684  RECV Playwright.provisionalLoadFailed (loader 4690, "Load request cancelled")
16:36:54.684  RECV Target.targetDestroyed (page-4693, crashed: false)
16:36:54.684  RECV Network.requestWillBeSent (page-4682, loader 4690, type: Document)
16:36:57.679  goto times out at 3000 ms; fixture closes the page
```

No document commit followed. This confirms the upstream ordering, rather than
inferring it from a slow CI timeout. The normal navigation, explicit abort,
deliberate stall and recovery controls had already passed in that job. Routine
CI does not retain the verbose protocol logging; use `DEBUG=pw:protocol` with
the WebKit rerun command above when investigating the order again.

## Repository checks

Local `npm test`: **1,407 passed, 5 skipped** (platform/opt-in cases).
`npm run test:coverage` passed: statements 78.91%, branches 68.47%, functions
84.23%, lines 79.18%. `npm run lint`, `npm run build`, `npm run knip`, strict
TypeScript checks of the three new test files, `git diff --check`, and
lazy-clean's slop-check all passed. `npm run test:mcp`: **33 passed**, installation
intentionally skipped. The initial hosted run also passed Docker smoke, Linux
Chromium history/downloads, Linux WebKit regressions, and Windows Chrome/Edge
history/downloads. See PR checks for the latest complete run.

## Stable upgrade gate

1. Identify a stable release containing each selected upstream fix; update both
   packages together only after verifying inclusion. r1553 does not fix #42956.
2. Rerun the real CDP endpoint/launch and fresh-context controls, font/geometry
   comparisons, and keyboard/focus controls. New versions cannot inherit the
   1.63.0 allowances.
3. Replay #42957's confirmed event ordering against the candidate and test prompt
   rejection, normal navigation, bounded stalls, and subsequent usability. Also
   cover the upstream variant where the document request never arrives.
4. Run actual macOS 14 page setup/navigation against its selected bundle or keep
   an explicit platform limitation; macOS 26 is not a substitute.
5. Compare Linux crash/non-crash cycles, inspect native retained windows, and
   verify persistent-browser survival and final cleanup.
6. Also run the existing recorder, screenshot, keyboard, context, and CDP suites;
   #235, #244 and #246 cover different defects and remain separate gates.
