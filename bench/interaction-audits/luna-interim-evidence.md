# Interim GPT-6-Luna MCP interaction-audit run (not final)

These are **custom regression prompts**, not an external benchmark. They exercise the existing keyboard-operation flow, text replacement/editing, keyboard-only form entry/submission, and truthful incompletion for a `tabindex=-1` field. Each fixed prompt ran twice per revision at concurrency 2. Raw Codex JSONL, tool responses, final model answers, and reports are preserved in `/tmp` paths below.

## Reproducibility

- Model/reasoning: GPT-6-Luna, `xhigh` (the existing `.codex/run-mcp-tool-loop.mjs` harness configuration).
- Frozen prompts: [luna-prompts.tsv](./luna-prompts.tsv), SHA-256 `d5ddcc1c7d5e4d5881b2402c0ad54748cb1c33121f53fdd3c3a7f42ab78b9480`.
- Baseline archive: `/tmp/a11y-before-060bfb1`, built archive at pre-change `060bfb1` (`060bfb19fe84a381a0ea6bfef3e98050b650aaec`).
- After revision: same Git HEAD with the active, uncommitted source changes; build completed per `/tmp/a11y-after-build.log` before the run.
- Both runs used `--concurrency 2 --timeout 180`, `EXEC_TIMEOUT_SECONDS=180`, and the same prompt bytes. Baseline used a `/tmp/codex-skiprepo` shim to add `--skip-git-repo-check` to `codex exec` because the supplied archive has no `.git`; it did not alter prompt, server, or source. The after run used the workspace harness directly.

Baseline command:

```sh
MCP_HARNESS_RESULTS_DIR=/tmp/mcp-luna-baseline-results EXEC_TIMEOUT_SECONDS=180 CODEX_BIN=/tmp/codex-skiprepo node /tmp/a11y-before-060bfb1/.codex/run-mcp-tool-loop.mjs --prompts /tmp/mcp-luna-interaction-prompts.tsv --concurrency 2 --timeout 180
```

After command:

```sh
MCP_HARNESS_RESULTS_DIR=/tmp/mcp-luna-after-results EXEC_TIMEOUT_SECONDS=180 node .codex/run-mcp-tool-loop.mjs --prompts /Users/justas/Desktop/mcp-accessibility-scanner/bench/interaction-audits/luna-prompts.tsv --concurrency 2 --timeout 180
```

## Run records

| Revision | Run ID | Started UTC | Finished UTC | Elapsed | Harness totals |
|---|---|---:|---:|---:|---|
| Baseline | `20261116T172153Z-15459-9kcc99` | 17:21:53.774 | 17:24:35 | ~161s | 2 PASS, 6 FAIL |
| After | `20261116T172600Z-24246-wh59ao` | 17:26:00.952 | 17:29:35 | ~214s | 7 PASS, 1 MCP_TOOL_FAILED |

Elapsed time is computed from harness `startedAt` and summary file modification time (second precision on finish). All 16 Codex processes exited successfully and made real calls to the intended MCP audit tools; harness failures below reflect tool-call or check results, not Luna/network startup failures.

## Results by scenario

| Custom scenario | Baseline repeat 1 / 2 | After repeat 1 / 2 | Observed change |
|---|---|---|---|
| Existing key operation (Tab then Enter toggles `aria-expanded`) | PASS / PASS | PASS / PASS | Both revisions passed both steps and returned JSON reports. |
| Text editing (Tab, select all, enter `Revised 🌿`, assert value) | MCP_TOOL_FAILED / MCP_TOOL_FAILED | MCP_TOOL_FAILED / PASS | Baseline rejected the new `ControlOrMeta+A` and `text` step schema. After implementation, the scenario itself passed all 3 steps twice and snapshot showed the exact final value. On after repeat 1, Luna first supplied `timeoutMs > 1000` (rejected), retried without it and passed; the harness marks any failed MCP call as `MCP_TOOL_FAILED` despite the successful retry/final PASS. Repeat 2 passed on first call. |
| Keyboard-only form trace (replace field, Enter submit, observe DOM event trace) | MODEL_FAIL / MODEL_FAIL | PASS / PASS | Baseline tool completed with direct `input/click/submit` trace and no `keydown`; after output reported keyboard mode and trace contained keyboard events, input, and submit with expected field/error state. |
| `tabindex=-1` field must be incomplete without submission | MODEL_FAIL / MODEL_FAIL | PASS / PASS | Baseline reported completed with 2 findings and no incomplete reason; after both reports said `outcome=incomplete`, `target-not-reached`, `submitAttempted=false`, and no findings. |

The after harness total is not a clean 8/8 because its policy considers any failed MCP attempt a failed prompt, even if Luna subsequently retries the same scenario successfully. Raw responses make that distinction explicit; results were not rerun or prompt-tuned.

## Raw evidence locations

- Baseline: `/tmp/mcp-luna-baseline-results/mcp-tool-loop-results/20261116T172153Z-15459-9kcc99/`
- After: `/tmp/mcp-luna-after-results/mcp-tool-loop-results/20261116T172600Z-24246-wh59ao/`
- Prompt source used for baseline: `/tmp/mcp-luna-interaction-prompts.tsv` (byte-identical to the frozen repo prompt file).
