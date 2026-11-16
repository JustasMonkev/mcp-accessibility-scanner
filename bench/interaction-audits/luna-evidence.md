# GPT-6-Luna interaction-audit comparison

These are **custom regression prompts**, not an external benchmark. The frozen set exercises an existing keyboard operation, text editing, a keyboard-only form event trace, and an unreachable `tabindex=-1` form field. Each ran twice at concurrency 2 against the pre-change build, interim build, and final build.

- Prompt file: [luna-prompts.tsv](./luna-prompts.tsv)
- Prompt SHA-256: `d5ddcc1c7d5e4d5881b2402c0ad54748cb1c33121f53fdd3c3a7f42ab78b9480`
- Machine-readable run/scenario evidence: [luna-evidence.json](./luna-evidence.json)
- Model/reasoning: `gpt-6-luna` / `xhigh`

## Summary

| Scenario (custom) | Baseline | Interim | Final |
|---|---:|---:|---:|
| Existing key operation | 2/2 PASS | 2/2 PASS | 2/2 PASS |
| Text editing/replacement | 0/2 PASS | 1/2 harness PASS* | 2/2 PASS |
| Keyboard-only form event trace | 0/2 PASS | 2/2 PASS | 2/2 PASS |
| Unreachable form → incomplete, not completed | 0/2 PASS | 2/2 PASS | 2/2 PASS |
| **Harness total** | **2/8 PASS** | **7/8 PASS** | **8/8 PASS** |

`*` The interim text-edit scenario succeeded on retry, but Luna's first tool call supplied `timeoutMs > 1000`, which the MCP server rejected. The harness counts any failed MCP call as a prompt failure. That initial invalid call is preserved in interim evidence; no runs were deleted or tuned.

Final raw MCP results show all scenarios meeting their requested observable outcomes: both keyboard operation steps passed; text editing reached the exact `Revised 🌿` value; form validation reported keyboard interaction and the event trace contained keyboard/input/submit events; `tabindex=-1` returned `incomplete` with `target-not-reached`, `submitAttempted=false`, and no findings. All final Codex processes exited 0 and the harness reported 8 PASS, 0 FAIL.

## Run metadata and reproduction

| Run | Build | Run ID | Started UTC | Approx. elapsed | Harness |
|---|---|---|---:|---:|---:|
| Baseline | `/tmp/a11y-before-060bfb1`, pre-change commit `060bfb19fe84a381a0ea6bfef3e98050b650aaec` | `20261116T172153Z-15459-9kcc99` | 17:21:53.774 | 161s | 2/8 |
| Interim | Built changes before final keyboard fix | `20261116T172600Z-24246-wh59ao` | 17:26:00.952 | 214s | 7/8 |
| Final | Final built changes after keyboard fix (`/tmp/a11y-after-build.log`) | `20261116T173142Z-32170-gdiuip` | 17:31:42.791 | 190s | 8/8 |

Baseline command (the supplied archive has no `.git`, so the temporary shim adds only `--skip-git-repo-check` to `codex exec`):

```sh
MCP_HARNESS_RESULTS_DIR=/tmp/mcp-luna-baseline-results EXEC_TIMEOUT_SECONDS=180 CODEX_BIN=/tmp/codex-skiprepo node /tmp/a11y-before-060bfb1/.codex/run-mcp-tool-loop.mjs --prompts /tmp/mcp-luna-interaction-prompts.tsv --concurrency 2 --timeout 180
```

Final command:

```sh
MCP_HARNESS_RESULTS_DIR=/tmp/mcp-luna-final-results EXEC_TIMEOUT_SECONDS=180 node .codex/run-mcp-tool-loop.mjs --prompts /Users/justas/Desktop/mcp-accessibility-scanner/bench/interaction-audits/luna-prompts.tsv --concurrency 2 --timeout 180
```

Full raw Codex JSONL and direct MCP tool responses remain in `/tmp` (paths are also recorded per scenario in the JSON evidence):

- Baseline: `/tmp/mcp-luna-baseline-results/mcp-tool-loop-results/20261116T172153Z-15459-9kcc99/`
- Interim: `/tmp/mcp-luna-after-results/mcp-tool-loop-results/20261116T172600Z-24246-wh59ao/`
- Final: `/tmp/mcp-luna-final-results/mcp-tool-loop-results/20261116T173142Z-32170-gdiuip/`
