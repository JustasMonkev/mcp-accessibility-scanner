# Playwright alpha validation — October 26, 2026

Both `playwright` and `playwright-core` are pinned to
`1.65.0-alpha-2026-10-25`. This is an explicitly requested prerelease upgrade.
Historical September reports remain historical; this report records the new
measurements, not a claim that every browser issue is fixed.

## Environment

Local real-browser tests ran on macOS 26 arm64 with Node 26.5.0 and the matching
downloaded builds:

| Engine | Version | Revision |
| --- | --- | --- |
| Chromium / headless shell | 157.0.8103.15 | 1252 |
| Firefox | 158.0 | 1564 |
| WebKit | 27.2 | 2380 |

CI now installs browsers and system dependencies from the locked package on
Ubuntu runners, rather than using the old 1.63.0 browser image. Linux, Windows,
branded-browser and macOS 14 jobs were not executed by this local validation.
Docker was unavailable locally.

## Compatibility changes

- `tracing.start()` now returns a disposable. The shared tracing readiness
  promise accepts its result; existing reference-counted `tracing.stop()`
  ownership is retained.
- Recording now uses `_startRecording({ language: 'javascript' }, sink)` and
  `_stopRecording()`. An already-armed shared hub is not started again: the new
  runtime rejects duplicate starts. Existing session logging, sibling action
  filtering and buffered-event draining remain required contracts. Coalesced
  same-textbox fills are preserved when a recording joins or restarts; the
  actual-browser regression failed before this compatibility fix and passes
  afterward (109 targeted recorder/session tests pass).
- Removed the obsolete proxy credential warning and client-certificate bypass
  rejection. Explicit launch-proxy propagation to fresh certificate contexts
  remains, including configuration used with remote browsers.
- Retained the restriction on importing storage state into existing contexts.
  The reason is now service-worker registration loss, not the fixed snapshot
  script-execution defect.

## Measured fixes

| Area | Result |
| --- | --- |
| Crashed-renderer CDP attachment (#244 / upstream #42936) | Direct attachment, endpoint and launch modes succeed without removing existing tabs. |
| Preloaded CDP frame selection (#251 / #42955) | Both attachment modes evaluate the top document and report the expected top-page Axe violation. |
| Numpad events (#42913, #42927) | Chromium, Firefox and WebKit satisfy the intended key, location and inserted-text assertions. |
| Nested closed details (#246 / #42951) | Chromium, Firefox and WebKit keep nested contents hidden until the outer details opens. |
| Persistent-profile downloads (#230) | Second-launch byte downloads, isolated controls, interrupted downloads and idle release pass on bundled Chromium. |
| Screenshot touch properties (#42617) | Full-page and oversized element captures retain touch support, maxTouchPoints and coarse pointer, including after navigation. |
| Smooth-scroll retries (#42626) | Fixed-header MCP click succeeds with two instantaneous scroll positions; page smooth-scroll CSS remains unchanged. |
| Firefox Option key and focus (#42958) | No unexpected `a` insertion; nested frame focus assertions pass. |
| Navigation failure recovery | Abort/stall errors remain bounded and later navigation succeeds; WebKit completes 350 fresh navigations without aborts/timeouts. |
| Client certificate proxy routing | All eight cases pass, including direct bypass with zero proxy requests and verified client certificates. |
| Authenticated proxy credential isolation (#43482) | All eight cases pass after a real `407` challenge/cache: proxy credentials never answer an origin `401`; explicitly supplied origin credentials work. |
| IndexedDB Map/Set (#224 / #42707) | Chromium preserves types and entries through capture and both fresh-context and `setStorageState()` restoration. |
| Snapshot service-worker execution (#42664) | Chromium snapshot capture and import do not execute the worker-served mutation script. |

The five Chromium CDP/history/details/numpad suites passed 26 tests. Firefox
and WebKit each passed their two details/numpad tests. Proxy probes each passed
eight cases. These results apply to the measured builds/platform, not untested
branded browsers or older operating systems.

## Unresolved issues and restrictions

1. **Chromium full-page screenshots still change fonts/layout on macOS
   (#42962).** All five generic font families changed in the headless-shell
   fixture; some changed geometry. Viewport capture is the passing control.
   `tests/browser-upgrade-controls.integration.test.ts` keeps its strict
   assertion and fails on this alpha. No new expected-failure exception or
   browser patch hides the failure. This affects screenshot-producing tools,
   including keyboard audit and annotated scans.
2. **Explicitly enabled BFCache remains unsupported (#231).** Six CDP history
   cases fail with missing iframe contents or invalid frame references after
   confirmed cache restoration; six normal launched controls pass. Normal
   Playwright launches retain `--disable-back-forward-cache`. The server does
   not rewrite flags on an existing attached browser.
3. **Existing-context storage import remains unsafe to roll back.** Although
   the measured Map/Set and snapshot-execution bugs are fixed,
   `setStorageState()` removes an existing service-worker registration
   (registration count changes from one to zero). A storage-state snapshot
   cannot restore it. The server still rejects existing-context imports
   before snapshot/reset and supports fresh contexts instead.
4. **macOS 14 WebKit is not locally verified.** The alpha browser manifest
   still selects the frozen r2251 build for macOS 14. The previous
   `Unknown setting: PushAPIEnabled` failure must be checked on that OS; a
   passing macOS 26 test does not settle it.
5. **Browser installer integrity behavior is unchanged.** The installed
   downloader checks response length and extracts the archive without an
   independent checksum/signature check. Existing download-source guidance
   remains applicable.

## GitHub issue scope

This validation is not a claim that all open GitHub issues are resolved.

- #284: proxy credential isolation verified on the tested Chromium paths.
- #230: bundled Chromium persistent-profile downloads verified locally; branded
  Windows/Edge and hosted CI results remain outstanding.
- #244: crashed-renderer attachment and three-engine numpad checks pass;
  genuine Memory Saver-discarded tabs still need a headed-browser check.
- #271: recorder migration and touch/scroll gates pass; the full-page screenshot
  failure remains, and the device-descriptor `screen` change needs explicit
  validation/documentation before this upgrade gate is complete.
- #235: certificate/proxy routing passes; Linux WebKit bundle validation remains.
- #257, #292, #293, #295, #296 and #298 were not specifically validated in this
  upgrade pass. No issue is automatically closed by the proposed change.

## Repository checks

- Final full Vitest run: **1,805 passed, 1 failed, 5 skipped** (76 files).
  The only failure is the macOS full-page screenshot font/layout regression
  described above; it was not skipped or relaxed.
- Build, lint/typecheck and Knip pass.
- The direct MCP harness passes 33 checks; browser installation is intentionally
  skipped (matching browsers were installed separately).
- Native WebMCP integration passes all three tests.
- Slop-check retains two reviewed private recorder API `any` casts: Playwright
  does not publish these methods in its types; their installed runtime contract
  is verified by the real-browser recorder tests.
- Docker smoke was attempted and could not start: `docker: command not found`.
- The extra `tsconfig.all.json` check hits the existing `rootDir: src` versus
  included-test-files configuration error; the supported build/typecheck pass.

## Reproduce

```bash
npm ci
npx playwright install chromium firefox webkit
npm run build
npm run lint
npm run knip
npm test
node tests/client-certificate-proxy-probe.mjs
node tests/authenticated-proxy-probe.mjs
MCP_TEST_BROWSER_NAME=firefox npx vitest run tests/details-visibility.integration.test.ts tests/numpad-keys.integration.test.ts tests/browser-upgrade-controls.integration.test.ts
MCP_TEST_BROWSER_NAME=webkit npx vitest run tests/details-visibility.integration.test.ts tests/numpad-keys.integration.test.ts tests/browser-upgrade-controls.integration.test.ts
```

Run the full suite without excluding the screenshot regression: an alpha bump
must not be reported as all-green while this failure remains.
