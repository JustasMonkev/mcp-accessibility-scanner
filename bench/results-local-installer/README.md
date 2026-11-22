# Reusing the stock axe installer: before and after

Both scanner revisions ran the public stdio `scan_page {}` tool with unmodified npm `axe-core@4.14.0`. This compares end-to-end scanner latency, not a fork or a change to the axe rule engine.

| End-to-end traversal | Before | After | Less time |
|---|---:|---:|---:|
| First scan after navigation | 3,216.65 ms | 3,159.47 ms | 1.78% |
| Repeat scan on same document | 3,072.89 ms | 1,585.43 ms | 48.41% |
| Navigation + first scan | 4,355.25 ms | 4,300.67 ms | 1.25% |

Each total sums the 17 page medians (10 observations per page/phase/arm). For navigation + first scan, the two durations are added per observation **before** taking the median. Browsers/servers stay alive; “first” means first on the newly navigated document, not a fresh CLI start. Each `scan_page` duration starts at the client call and ends on receipt of the complete result, before benchmark verification/artifact writing.

## Output parity

All 680 timed calls completed. All 340 paired full MCP results matched, including the complete text and metadata (not just violation counts). The only normalization was the loopback fixture origin; no timestamp, finding, target, file reference, or metadata field was dropped. All results were inline text. The raw rows refer to 17 unique [archived response bodies](paired/reports.json.gz). This demonstrates parity for tested responses, not comprehensive accessibility accuracy.

## Inputs and measurements

- Baseline `da84370f17e7a7abb2b56eeddd965d81dfad7b5a`; candidate `189598169630b5c4d068fd323e62db8a11e9a3bb`. Both package locks and installed minified bundles matched. `axe.min.js` SHA-256: `20c09fe157a8a34a30e241aaa1fcdade657734f08ab379ecfbeb7d45cc46e878`; `axe.source` SHA-256: `a5fcf3b78743edaddb1f38548e125c8673f7140671e0da78ed52d15e969d66c0`.
- Node v26.5.0, Playwright 1.65.1, bundled Chromium 159.0.8154.6, Apple M4 Pro (arm64, darwin 27.2.0); in-page `window.axe.version` was `4.14.0` on both. The [manifest](paired/environment.json) records revisions, transitive fixture checkout, input hashes, CLI arguments, runtime user agents, and run times.
- The corpus contains 12 offline snapshots (including large MDN, React, and iframe pages) and five local fixtures. One isolated headless browser per arm, same loopback origin, external origins not allowed, service workers blocked, 1280×800 viewport. For each page/iteration the first arm alternates; each arm navigates, scans, and rescans the same document. No two calls run concurrently.
- [Raw samples](paired/samples.jsonl) · [All page medians and p95](paired/summary.json) · [Full-result archive verifier](verify.py). Nearest-rank p95 is the maximum at n=10. The preliminary [baseline-only smoke](baseline-smoke/summary.json) is not part of the paired timing.

Candidate validation: [full test log](../../docs/performance/stock-axe-installer-validation/scanner-test.log) · [commit checks](../../docs/performance/stock-axe-installer-validation/commit-check.log).

### Slower per-page medians

Only observed regressions are listed. These are ten-sample same-machine measurements, not significance tests.

- First scan after navigation: `example` +5.96 ms (8.58%), `cern` +4.38 ms (6.78%), `bad-home` +3.33 ms (3.19%), `bad-news` +1.51 ms (1.44%), `bad-tickets` +0.72 ms (0.64%), `good-home` +4.90 ms (5.03%), `deque-mars` +0.45 ms (0.18%), `todo-react` +1.25 ms (1.69%).
- Repeat scan on same document: none.
- Navigation + first scan: `example` +5.74 ms (6.57%), `cern` +4.03 ms (4.94%), `bad-home` +3.27 ms (2.24%), `bad-news` +3.20 ms (2.21%), `bad-tickets` +0.66 ms (0.43%), `good-tickets` +0.53 ms (0.37%), `good-home` +6.62 ms (5.11%), `deque-mars` +1.12 ms (0.33%), `todo-react` +1.56 ms (1.67%), `frame-examples` +3.25 ms (1.26%).

## Reproduce

Build both scanner revisions with their own `npm ci` and `npm run build`; install the locked Playwright Chromium if necessary. The runner takes a separate prepared fixture checkout: scanner corpus revision `2e8667cd88be42f3c6985c12db370b6fa4762a63`, with `fast-axe/engine` providing the frozen MDN and integration assets at `4a20e0b516ceb0e9449582d3fb75e1fe4c1bdd21`. Only HTML/fixture assets and the fixture HTTP server are used from that checkout, never its JavaScript scanning engine. The runner rejects a linked axe dependency. Pass a fresh directory for a new run:

```sh
node "$candidate/bench/stock-axe-installer.mjs" \
  --baseline "$baseline" --candidate "$candidate" \
  --corpus "$fixture_checkout/fast-axe/bench" --iterations 10 --out "$new_output"
python3 "$candidate/bench/results-local-installer/verify.py" "$new_output"
```

For the original run’s exact paths and startup commands, see `command` and `arms.*.args` in the [manifest](paired/environment.json). To verify these checked-in results without starting a browser, run `python3 bench/results-local-installer/verify.py bench/results-local-installer/paired` from the candidate checkout.
