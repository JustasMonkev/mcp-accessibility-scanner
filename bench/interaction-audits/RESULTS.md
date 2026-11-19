# Interaction-audit benchmark

## GPT-6 Luna MCP results

| Custom scenario, two runs each | Before | Final changed build |
|---|---:|---:|
| Existing keyboard activation | 2/2 | 2/2 |
| Text entry and editing | 0/2 | 2/2 |
| Keyboard form event sequence | 0/2 | 2/2 |
| Unreachable field stops before submit | 0/2 | 2/2 |
| **Total** | **2/8** | **8/8** |

These are actual Luna-driven MCP executions, not subagent opinions. The review-fixed build also scored **8/8** in a separate single run; the preceding 8/8 build and all earlier runs are retained in the evidence. See [Luna evidence](luna-evidence.md) and [machine-readable run evidence](luna-evidence.json). An intermediate changed build scored **7/8**: Luna first sent an out-of-range timeout, then recovered. The harness still counted that run as failed. That run is retained in [intermediate evidence](luna-interim-evidence.md); the final run was performed after the additional delayed-focus fix, not merely retried to improve the score. This small result is not a reliability estimate for the model on arbitrary tasks.

## Measured external results

| Check | Before | Final changed build |
|---|---:|---:|
| ACT label agreement, 6 mapped cases × 3 repeats | 13/18 | 18/18 |
| Violations detected, 5 positive cases × 3 repeats | 10/15 | 15/15 |
| Nonviolation classified correctly, 1 case × 3 repeats | 3/3 | 3/3 |
| Static form snapshots classified, 4 cases × 3 repeats | 0/12 | 0/12 |
| Static form snapshots reported incomplete | 12/12 | 12/12 |
| Median keyboard-scenario call duration | 520.3 ms | 1,798.7 ms |

The latest run includes the PR review fixes. The preceding build’s [18/18 result](external-pre-review.json) is retained.

Evidence: [baseline summary](external-before.json), [final summary](external-after.json). All repetitions are retained, including the baseline's intermittent detection of a delayed trap. The latency is descriptive for these scenarios and this machine, not a throughput benchmark; other verification processes ran concurrently, so it is not an isolated performance comparison; final-state observation intentionally waits longer. The benchmark's 500 ms window is the same in both revisions.

Only **6 of the 20 selected external cases** received a classification: four executed cases were incomplete and ten had rejected/inapplicable mappings. The 18/18 figure is not 100% coverage of the selected cases, let alone the full dataset.

## Build and test evidence

Both builds passed. The baseline suite passed **2,204 tests with 20 skipped**; the final suite passed **2,241 with 20 skipped**. Final lint/typecheck passed. Both direct built-CLI audit harness scenarios passed before the review fixes; the external and Luna MCP runs were repeated on the review-fixed build. Logs and final runtime-source hashes are recorded in [build-evidence.json](build-evidence.json). The active checkout's suite excludes two unrelated ignored archived checkouts; no runner settings or test skips were changed.

Knip retains two pre-existing findings (`tests/transportFixture.ts` and the `filterAutoAttach` export). The simplification scan retained two reviewed findings: a selector-validation catch returns an explicit false that rejects preflight, and a partial `Context` fixture assertion is backed by real browser and MCP tests. Neither is a production success fallback.

## Scope and method

The baseline is commit `060bfb19fe84a381a0ea6bfef3e98050b650aaec`, before keyboard-driven form entry and keyboard text/edit steps. Both revisions were built locally and exercised through the published `cli.js` MCP stdio entrypoint, not a duplicate implementation. Node, Playwright and Chromium versions are recorded in [build-evidence.json](build-evidence.json).

Two separate experiments answer different questions:

- **Luna integration:** the same four custom scenarios, repeated twice, using `gpt-6-luna` with `xhigh` reasoning through the existing Codex MCP harness. These are regression scenarios, not external accessibility labels. The frozen prompts are [luna-prompts.tsv](luna-prompts.tsv).
- **External scenario mapping:** unmodified InterA11y conformance fixtures, including W3C ACT-derived keyboard examples, pinned to commit `8dcf06e258df88a8f39a3e37ebfce060c45a1cdd`. Each download is SHA-256 verified. The same scenario arguments run three times per revision. A keyboard assertion failure is a scenario-level proxy for the external violation label; a form semantic gap is also only a proxy. Neither is a general WCAG verdict.

The external selection was frozen before execution: all 16 ACT-derived SC 2.1.2 cases in the dataset, plus the first two positive and first two negative InterA11y-generated SC 3.3.1 cases in CSV order. No fixture content, JavaScript, or source label was changed. We did not add handlers to make static forms submit successfully. Fixture scripts are served at their original relative paths.

## Coverage and rejected mappings

The audited [manifest](external-cases.json) retains all 20 selected cases:

| Disposition | Cases | Reason |
|---|---:|---|
| Executed keyboard cases | 6 | Five violation labels, one nonviolation label |
| Executed form snapshots | 4 | Two violation labels, two nonviolation labels |
| Inapplicable | 4 | No applicable focusable target |
| Unsupported escape scenario | 3 | Requires Ctrl+M, outside this tool's key enum |
| Conflicting source label | 1 | InterA11y labels a violation; W3C says passed |
| Invalid DOM-only focus oracle | 2 | Leaving the document does not reliably make `body` the active element |

The last two mappings were rejected during independent review after the pilot, not silently dropped. The original manifest, pilot summaries, and raw MCP responses are retained locally in `test-results/interaction-audits-benchmark/` (ignored runtime artifacts, not shipped code). Both revisions were rerun with the identical audited manifest. Browser-chrome focus remains outside the tool's observation surface.

This is a small, inspected regression corpus, not an untouched held-out evaluation. It does **not** reproduce the paper's 197-case expert evaluation or establish its reported precision/recall for this MCP. Repeats are not independent examples. No actual ARIA-AT/screen-reader run was performed: this repository has no configured AT-Driver harness. VoiceOver/NVDA speech, reading mode and end-to-end disabled-user task completion remain unverified.

## What the experiment exposed

The initial changed build had the same detection limitation as the baseline: a focus assertion could pass during the first few milliseconds before a delayed focus trap reclaimed focus. Two ACT fixtures schedule that reclaim after 10 ms. The retained local `interim-external-after.json` preserves those misses (9 true positives, 6 false negatives and 3 true negatives over the 18 keyboard repetitions; 12 form repetitions incomplete). The baseline caught one of these intermittently, illustrating timing sensitivity rather than reliable trap detection.

The final fix observes each step at the end of the requested `timeoutMs` window instead of returning at its first passing sample. A zero window remains an immediate sample. This is bounded observation, not a guarantee against later focus changes; it deliberately increases successful-step latency. The fix was developed after inspecting these cases, so improved results here are regression evidence, not a generalization claim.

The four form fixtures are static post-error snapshots. Their real submit action navigates/reloads, and the audit returns incomplete. They are retained as unclassified outcomes, never counted as clean forms. Correct evaluation of these snapshots would require a separate observation-only evaluator and message-quality judgment, not fake submission handlers.

## Reproduce

Build each revision first. The runner does not build implicitly. Use a new path for `--output` on every run. The runner creates the directory and rejects an existing path before opening the benchmark server.

```sh
npm run build
node bench/interaction-audits.mjs \
  --server-root . \
  --fixtures /tmp/a11y-fixtures \
  --download \
  --manifest bench/interaction-audits/external-cases.json \
  --output /tmp/a11y-new-run \
  --repeats 3
```

Run the same command with `--server-root /path/to/built/baseline`, a different `--output`, and the same manifest. Omit `--download` to reuse hash-checked local fixtures. The runner writes raw MCP responses, tool reports and `summary.json`. Committed summaries retain every observation; full generated reports stay in local output directories. Its aggregate conservative detection rate counts positive unclassified attempts as undetected; standard precision/recall are reported only among classified results, with coverage separately. Prefer the separate keyboard/form cohorts above to an aggregate across these different tasks.

For Luna, from each checkout with its own built CLI:

```sh
MCP_HARNESS_RESULTS_DIR=/tmp/luna-new-run \
  node .codex/run-mcp-tool-loop.mjs \
  --prompts /absolute/path/to/bench/interaction-audits/luna-prompts.tsv \
  --concurrency 2 --timeout 180
```

Do not retry or change prompts to hide a model/tool failure. The harness treats even a recovered invalid tool call as a failed run. Raw JSONL and final model judgments must be inspected separately.

## Sources

- [InterA11y paper](https://arxiv.org/abs/2610.39488) and [pinned replication repository](https://github.com/jszh/InterA11y/tree/8dcf06e258df88a8f39a3e37ebfce060c45a1cdd).
- [W3C ACT test cases](https://www.w3.org/WAI/standards-guidelines/act/report/testcases/) and [no-keyboard-trap rule](https://www.w3.org/WAI/standards-guidelines/act/rules/80af7b/).
- [W3C AT-Driver](https://github.com/w3c/at-driver): actual assistive-technology control and speech evidence are a separate layer.

Third-party fixture bytes are downloaded, not vendored into this repository. Source attribution and hashes are in the manifest; the pinned dataset includes its ACT license notice.

## PR review fixes

Six review threads are covered: closed-disclosure feedback, delayed ARIA state, exclusive interactive-audit admission within a routed MCP context, file-URL decoding in the test helper, composed shadow/slot feedback text, and direct-mode value verification immediately before submission. Conflicting calls are rejected, not queued; independent contexts and ordinary-call concurrency remain supported. Added browser/MCP regressions cover cancellation release and both sides of the 10,000-node bound.
