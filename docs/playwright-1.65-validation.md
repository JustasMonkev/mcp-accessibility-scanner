# Playwright 1.65 stable validation — 2026-11-06

Baseline: `c13bb16d2b6a4ac95c0ed97163c2d7733a20cb00` (`main`). Both `playwright` and `playwright-core` are pinned exactly to `1.65.0`; unrelated lockfile entries, including native `libc` metadata, are preserved. CI container images are paired at `v1.65.0-noble`. The runtime/package/binary/tool names and Node engine contract are unchanged.

## Scope and method

The issue inventory enumerated 323 GitHub items: 84 issues, of which 13 were open. Every open issue relates to Playwright upgrade validation. Closed dependency-related issues remain regression gates; an upstream source inclusion or a passing synthetic fixture is not a runtime pass for the original issue.

Local environment: Debian 13 x64, Node 24.22.1, npm 11.9.0, paired Playwright 1.65.0. Bundled Firefox 159.0 launches. Chromium 158.0.8127.18 / r1254 archive downloads return invalid archives. The system Chromium 156.0.8078.79 cannot launch because the execution sandbox rejects its Unix socket. Bundled WebKit 27.2 downloads but initially lacks system libraries. Native Windows, macOS and genuine Memory Saver behavior cannot be established by Linux unit tests.

## Current issue matrix

| Issue | Checked behavior | Local result / remaining evidence |
| --- | --- | --- |
| [#230](https://github.com/JustasMonkev/mcp-accessibility-scanner/issues/230) | Persistent download reuse, idle relaunch, interruption, exact saved bytes | Strict existing suite attempted; Chromium launch blocked. Linux and Windows Chromium/Chrome/Edge CI remain required. |
| [#235](https://github.com/JustasMonkev/mcp-accessibility-scanner/issues/235) | Load dialogs, literal slash names, certificates/proxy/bypass, Linux WebKit network stress | Dialog/name regression coverage retained. Expanded certificate routing matrix and WebKit stress probe included. Firefox isolated client-certificate routing passes bypass on/off; persistent Firefox omits the client certificate even through direct upstream APIs, so this issue is not fully resolved. Engine/platform results must be recorded separately. |
| [#244](https://github.com/JustasMonkev/mcp-accessibility-scanner/issues/244) | Healthy/crashed CDP attach and numpad events | Firefox numpad passes with no deviations. Chromium attach blocked locally; genuine Memory Saver discard is a separate headed check. |
| [#257](https://github.com/JustasMonkev/mcp-accessibility-scanner/issues/257) | Unrendered names, no-JS retry, consumed response body | Firefox passes unrendered/slotted controls and native form retry with/without JS. 50k/5M bodies preserve bytes, 15M eviction is explicit, valid empty body remains empty, and each URL is requested once. |
| [#271](https://github.com/JustasMonkev/mcp-accessibility-scanner/issues/271) | Recorder API/lifecycle, screenshots/touch/scroll and device screen | Recorder migrated to `_startRecording`/`_stopRecording`; 124 unit tests pass, mutation demonstrates coalesced-fill regression detection. Real Chromium recording and screenshot gates await runnable engine. Device descriptor screen values continue to flow through configuration. |
| [#284](https://github.com/JustasMonkev/mcp-accessibility-scanner/issues/284) | Cached proxy 407 followed by hostile website 401 | Firefox 159 passes all eight launch/context proxy, isolated/persistent and explicit origin-credential scenarios; no proxy credential reaches the website. Chromium validation remains required. |
| [#292](https://github.com/JustasMonkev/mcp-accessibility-scanner/issues/292) | Native Windows ARM64 stable/beta Chrome installation | Not a runtime pass: the shipped installer scripts still select x64 MSI URLs. Native ARM64/emulated PowerShell and x64 controls remain required. |
| [#293](https://github.com/JustasMonkev/mcp-accessibility-scanner/issues/293) | Reflected and shadow-root ARIA labels | New cross-engine regression included; Firefox reflected-label/shadow controls pass. |
| [#295](https://github.com/JustasMonkev/mcp-accessibility-scanner/issues/295) | Read-only installer cache latency and Windows network regression | Real UID1000 read-only cache rejects with EACCES in 1,378 ms and MCP follow-up works. This does not validate Windows WSAENOBUFS behavior. |
| [#296](https://github.com/JustasMonkev/mcp-accessibility-scanner/issues/296) | Iframe fallback, interception transitions, process cleanup/ownership | Firefox SW allow/block routing transitions pass three rounds. Chromium policy setup/sibling teardown fixture included. Existing lifecycle/ownership tests pass. CLI stdin/SIGINT/SIGTERM dispatch cleanup; SIGHUP does not, and parent IPC disconnect leaves HTTP process alive. Those local lifecycle gaps are unchanged by the dependency bump. |
| [#298](https://github.com/JustasMonkev/mcp-accessibility-scanner/issues/298) | Fallback iframe snapshot/find/refs and ordinary/empty controls | Firefox snapshot/find/child-ref action checks pass for populated fallback and ordinary iframes; empty child snapshots intentionally retain fallback text upstream. Other engines remain separate gates. |
| [#303](https://github.com/JustasMonkev/mcp-accessibility-scanner/issues/303) | Terminated worker/second CDP client and mixed-case ARIA | Synthetic orphan-target guard passes with usable follow-up. This does not prove real shared-worker lifecycle or native-crash recovery; real Chromium fixture is included. Firefox mixed-case controls pass. |
| [#325](https://github.com/JustasMonkev/mcp-accessibility-scanner/issues/325) | Stable upgrade, named snapshots/audits and inert actions | Paired stable upgrade and compatibility code complete. Firefox inert click/type/select time out with clear errors and recover. All nine new Firefox accessibility regressions pass, including named containers, the separate distilled-name audit, inert controls, iframe fallback, reflected labels and mixed-case ARIA. The existing audit workaround is retained. |

Closed regressions include #218/#224/#226 (recording and safe storage), #246 (nested details), #251 (frame tree, fonts, navigation and Firefox focus/crash), and #309 (form dialogs/chooser). Existing 1.63 native-crash allowances are not expanded to 1.65.

## Safety decisions

- Keep existing-context storage imports rejected: snapshot capture no longer executes service-worker-served scripts, and Map/Set round-trips pass Firefox, but `setStorageState` removes service-worker registrations that rollback cannot recreate.
- Keep `restoreDistilledNames`. Identifying container names now survive upstream AI distillation, while some control names still require measurement.
- Remove the obsolete authenticated-proxy warning and certificate bypass restriction with the paired dependency update; behavioral probes enforce the replacement contracts.
- Keep finite navigation/attachment bounds, sibling suppression, buffering and ownership rules. Do not work around browser failures by clearing user profiles, broadening crash exceptions, disabling policy or substituting reload for history.

## Commands and validation

```sh
npm ci
npx playwright install --with-deps chromium firefox webkit
npm run lint
npm run build
npm run knip
npm test
node tests/authenticated-proxy-probe.mjs
node tests/client-certificate-proxy-probe.mjs
node tests/webkit-network-probe.mjs
MCP_TEST_BROWSER_NAME=firefox npx vitest run tests/playwright-165-accessibility.integration.test.ts tests/playwright-165-network.integration.test.ts tests/storage-upgrade.integration.test.ts tests/numpad-keys.integration.test.ts tests/details-visibility.integration.test.ts tests/browser-upgrade-controls.integration.test.ts
```

The first local full-suite attempt (while some agent fixtures/docs were still being finalized) reported **1,815 passed, 95 failed, 78 skipped**. Most failures were missing Chromium executables. It also captured a temporary investigation fixture, one docs pin assertion before the docs edit, a WebMCP validation timeout under parallel load, and browser-backed cases with no usable Chromium. It is diagnostic evidence, not an all-green final gate.

Focused source checks pass lint/typecheck and build. Recorder/session unit gate: 124/124. Config/program/factory gate: 282/282. Process/factory/backend lifecycle gate: 150/150. Counts overlap and must not be added together. Final broad non-integration run: **1,703 passed, 0 failed, 41 skipped** (browser-backed screen-reader, keyboard and navigation suites excluded and run separately). The docs pin and parallel-load WebMCP checks were rechecked serially: 90 passed, 4 skipped. New network Firefox gate: 5 passed, one Chromium-only skip. New accessibility Firefox gate: 9/9 passed. Existing Firefox controls pass numpad, focus/Alt and navigation recovery. The Firefox crash-retention probe cannot inspect the reported browser PID through this sandbox's `/proc`, so it never reaches its signal stage.

An existing Firefox screen-reader own-heading measurement case crashes the page, and the Firefox navigation suite exposes an unrelated session-loss expectation. These failures remain recorded; no assertion is relaxed. Hosted Chromium and supported native OS CI are required before merge. This change closes no issue automatically.
