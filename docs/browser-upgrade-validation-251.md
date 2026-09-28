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
| [WebKit lost navigation abort #42957](https://github.com/microsoft/playwright/issues/42957) | Launch, page creation, COOP+COEP navigation, intercepted abort, a 3-second stalled navigation, and subsequent navigation pass through MCP. An additional 350 fresh-page COOP+COEP navigations completed without failure (93.6 seconds). The abort is delivered without a timeout; the deliberately stalled request reports the configured timeout. | **The exact provisional-load-before-document-request ordering was not reproduced.** A route abort is a control, not a replay of that engine race. A containing stable release still needs the reported order (including a document request that never arrives) plus these controls. |
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
`Unknown setting: PushAPIEnabled` rejection; the initial test budget expired at
30 seconds. The fixture now gives that identical error assertion a 60-second test
budget. Ubuntu WebKit r2359 also completed **350** fresh-page COOP+COEP
navigations in **141.1 seconds**, plus abort, timeout and recovery controls,
without reproducing the reported ordering failure.
The macOS 14 job asserts the exact known page-setup failure on 1.63.0; subsequent
page-dependent controls are explicitly skipped there. Other versions must create
a page and pass the navigation/keyboard controls. Local macOS 26 results must not
be substituted for macOS 14, Linux crash retention or Linux font measurements.

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
3. Reproduce #42957's exact event ordering and test prompt rejection, normal
   navigation, bounded stalls, and subsequent usability.
4. Run actual macOS 14 page setup/navigation against its selected bundle or keep
   an explicit platform limitation; macOS 26 is not a substitute.
5. Compare Linux crash/non-crash cycles, inspect native retained windows, and
   verify persistent-browser survival and final cleanup.
6. Also run the existing recorder, screenshot, keyboard, context, and CDP suites;
   #235, #244 and #246 cover different defects and remain separate gates.
