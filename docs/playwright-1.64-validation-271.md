# Playwright 1.64.0 migration validation (#271)

## Decision — 2026-10-08

This is a **draft migration**, not approval to change the stable default in
`main`. Both dependencies and their lockfile entries move together from exact
1.63.0 to exact 1.64.0. Keep the PR unmerged until the missing browser/platform
gates pass and the #257 ARIA result is resolved or explicitly assessed.

The recorder hub uses `_startRecording({ language: 'javascript' }, sink)` and
`_stopRecording()` with no old-name fallback. The published 1.64.0 runtime was
inspected: starting an active recorder rejects, the client has one event sink,
and consecutive fills on the same selector emit `actionUpdated`. The hub starts
once, preserves shared ownership and the 500 ms drain, retains fills that span
recording restarts, and excludes new fills after stop begins. Sibling-tool
updates retain the existing attribution buffer. `tracing.start()` now returns a
disposable; the readiness type follows that return type, while explicit shared
trace stop/refcount ownership remains unchanged.

`--device` and `--mobile` retain the new device `screen` emulation. This gives
more faithful screen dimensions and device-size media queries, and can change
responsive scan results. Explicit screen sizes remain supported, with unchanged
configuration precedence. No browser engine is patched and no 1.63.0 test
allowance is extended to the candidate.

## Environment and results

Linux x64, Node **24.19.0**, TypeScript **7.0.2**, Vitest **5.0.1**, exact paired
Playwright **1.64.0**. Installed browser metadata: Chromium/headless shell r1248
(156.0.8078.4), Firefox r1555 (157.0), WebKit r2370 (27.2).
Only Firefox actually executed page tests successfully. WebKit macOS 14
revision overrides still select r2251; the local Linux bundle does not validate
that frozen platform bundle.

| Check | Result / limits |
| --- | --- |
| `npm run lint`, typecheck, build | Passed. |
| Recorder/context/session/factory/config/Axe unit gate | 369 passed, 4 skipped across seven files. The skipped Axe checks require a real browser. |
| Full default `npm test` | 1497 passed, 84 failed, 62 skipped; 51 files passed, 12 failed, 6 skipped. Failures require missing Chromium/Chrome executables, including extension discovery assertions. This is not a green upgrade gate. |
| Firefox explicit four-suite run | 10 passed, 1 failed (#257 ARIA), 4 skipped: Chromium-only CDP/fonts, unsupported Firefox mobile, and macOS-only WebKit setup. |
| Mutation check | Removing the restarted-fill insertion made the new lifecycle test fail (`[]` instead of `['final fill']`); restored code passed. |
| Real Firefox recorder | Stateless explicit-session stop/restart, ephemeral rejection and repeated fills with `--save-session` passed. Chromium shared-CDP/sibling-client recorder gate remains unexecuted. |
| Firefox numpad (#244) | All four key combinations passed key, code, typed character and numpad location checks, with zero deviations. |
| Firefox device screen (#271) | Desktop screen 1920×1080, matching device-size media query and explicit 900×1100 override passed. Mobile Chromium/WebKit screen remains pending. |
| Firefox smooth-scroll retry (#235) | Fixed-header click completed with at most two scroll events. Mobile touch preservation after full-page/oversized-element capture remains pending. |
| Firefox visibility/navigation/focus | Nested-details snapshot/find/verification, Option-key no-text insertion, nested frame focus, delivered abort, bounded stall and subsequent usability passed. |
| Firefox CSS overlay (#257) | JavaScript-disabled/enabled retry and unobstructed controls passed. This does not prove Chromium behavior. |
| Firefox ARIA (#257) | **Failed intended behavior**: unslotted text produced `button "LightShadow"`; closed details exposed `Hidden direct text`. The strict regression stays failing, with no new known-deviation exemption. Upstream #42982 was closed without merging when checked. |
| Firefox crash probe (#251) | Attempted; blocked by `ENOENT` reading the launched browser PID under `/proc`. No memory-retention or native-window conclusion. |
| Chromium/headless shell | Installer exhausted retries; downloads were invalid/truncated ZIPs (`End of central directory record signature not found`). Runtime checks fail for missing r1248 executables. |
| WebKit | Bundle downloaded, but page tests fail because host libraries are missing. `playwright install-deps firefox webkit` failed on container UID/group operations. No WebKit runtime result. |
| Chrome | Explicit channel history/download and upgrade gates attempted; executable is unavailable. Edge and Windows/macOS controls remain pending on appropriate runners. |

Firefox initially crashed on page creation because the container cannot create
its content-process user namespace. The successful **local fixture-only** run
used `MOZ_DISABLE_CONTENT_SANDBOX=1`. This is a validation-environment setting,
not a repository/browser default change. Repeat on an ordinary supported runner.

## Restrictions and checks still required

- **#244:** run crashed/discarded-tab raw CDP and endpoint/launch attachment,
  shared-CDP recorder attribution, and Chromium/WebKit numpad contracts.
- **#230 / #231:** persistent-profile download/relaunch and idle-release bytes,
  history/ref controls on bundled Chromium, Chrome and Edge. Keep BFCache guidance.
- **#235:** mobile touch/pointer properties after full-page and oversized-element
  screenshots plus navigation, on Chromium and WebKit.
- **#246 / #251:** WebKit nested-details/list-box controls, preloaded CDP frame
  tree, Chromium actual fonts/geometry, WebKit navigation stress and actual macOS
  14 page creation. macOS Option/focus and Windows channel checks need their own
  runners; Linux Firefox passing is not evidence for those platforms.
- **#224 / #259:** keep existing-context storage imports rejected. Recheck
  service-worker snapshot execution, IndexedDB Map/Set capture and both restore
  paths, and failed-import rollback on each engine before lifting the guard.
- **#235 certificate/proxy routing:** keep nonblank effective `proxy.bypass`
  rejected with client certificates. The existing probe verifies rejection and
  non-bypass routes; allowing bypass needs a real HTTP/HTTPS/certificate routing
  probe of the candidate before changing config validation.
- **#257:** ARIA failure remains actionable. Chromium no-JavaScript retry and
  non-refetchable evicted response-body/error/no-extra-request and valid empty
  response controls remain untested.

The existing `knownAttachHang`, `knownWebKitLeak`, numpad tables, font/frame-tree
allowances and native-download-crash signatures still apply only to their exact
old 1.63.0 pins/builds. They do not grant candidate passes. Unit tests verify the
retained storage/proxy restrictions; error messages now describe pending 1.64.0
validation instead of claiming the old defect is present in the current pin.

## Rerun

```bash
npm ci
npx playwright install --with-deps chromium firefox webkit chrome
npm run lint
npm run build
npx vitest run tests/recorder.integration.test.ts tests/context.test.ts tests/browserSessions.test.ts tests/browserContextFactory.test.ts tests/tools-recorder.test.ts tests/sessionLog.test.ts
npx vitest run tests/cdp-attach.integration.test.ts tests/cdp-frame-tree.integration.test.ts tests/numpad-keys.integration.test.ts tests/browser-upgrade-controls.integration.test.ts tests/history-downloads.integration.test.ts tests/browser-failures.integration.test.ts
MCP_TEST_BROWSER_NAME=firefox npx vitest run tests/recorder.integration.test.ts tests/numpad-keys.integration.test.ts tests/details-visibility.integration.test.ts tests/browser-upgrade-controls.integration.test.ts
MCP_TEST_BROWSER_NAME=webkit npx vitest run tests/recorder.integration.test.ts tests/numpad-keys.integration.test.ts tests/details-visibility.integration.test.ts tests/browser-upgrade-controls.integration.test.ts
MCP_TEST_BROWSER_CHANNEL=chrome npx vitest run tests/history-downloads.integration.test.ts tests/browser-upgrade-controls.integration.test.ts
MCP_TEST_BROWSER_CHANNEL=msedge npx vitest run tests/history-downloads.integration.test.ts tests/browser-upgrade-controls.integration.test.ts
node tests/client-certificate-proxy-probe.mjs
npm test
```

Run the crash probe only on a disposable Linux runner, as described in
[browser-upgrade-validation-251.md](browser-upgrade-validation-251.md). CI's
existing browser-controls matrix now also runs the real recorder suite, so
candidate runtime behavior is exercised outside the main Chromium job.

Slop-check reviewed the changed TypeScript: one `any` finding remains on the
partial unit-test session-log mock, consistent with the surrounding fixture.
Production recorder calls use a narrow, runtime-verified private contract.
