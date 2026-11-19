# Investigating MCP latency regressions

OpenAI's Performance Factory keeps a record for each regression, delegates bounded investigations to coding agents, and checks whether latency recovers after a change ships. The dispatcher can resume the investigation when new evidence arrives. OpenAI describes its cloud-task API as internal. The public article gives an architecture and evaluation examples. [How OpenAI Performance Factory keeps ChatGPT fast](https://openai.com/index/how-openai-performance-factory-keeps-chatgpt-fast/)

## Why this scanner

A caller waits for a round trip through MCP, Playwright and Chromium. A local parser benchmark can isolate expensive string handling, but it cannot tell us how much of that cost the caller sees. The previous heavy-page Axe comparison reported 2.19 s versus 1.60 s, yet an earlier baseline measured 1.49 s. Attributing browser variance to whichever utilities changed in a PR would send an agent to fix the wrong thing. [Previous browser and utility measurements](2026-11-19-utils.md)

This pilot uses a historical case with a known outcome. The slow revision predates the healthy reference. The console fixture logs four raw SVG data URLs, each with a run of 1,024 spaces. Its oracle checks the truncated prefix and the text after each payload. A heavy-page Axe scan with identical builds exercises the decision rule under browser variance. This control checks successful tool calls and latency. It does not compare accessibility findings across revisions.

## Replay a case

Use a full Git checkout, the project's supported Node version, its development dependencies, and the pinned Playwright browser. The checkout must contain every commit in the manifest. Build and run only trusted revisions. Each revision is compiled locally and its scanner CLI runs with the current user's permissions.

```sh
npm ci
npx playwright install chromium
mkdir -p /tmp/scanner-investigation
cat > /tmp/scanner-investigation/case.json <<'JSON'
{"workload":"console","reference":"5e681ab","suspect":"9ec0e20","repair":"c486456"}
JSON
node bench/latency-case.mts /tmp/scanner-investigation/case.json
```

Use `console` or `scan` and commit SHAs. Omit `repair` for initial triage. Set `CHROME_HEADLESS_SHELL` to an installed Chromium executable to reproduce a specific browser. The pilot builds each distinct revision in a disposable Git worktree and uses the current checkout's dependencies. It rejects revisions with a different dependency lock blob. The fixed harness and fixture come from the checkout running the pilot.

Each launch opens a fresh MCP server and browser. Navigation, fixture setup and one warm-up precede three timed tool calls. A block compares the median call time from each revision's launch. Two-revision cases use four blocks with balanced ordering. Three-revision cases rotate all three launch positions across three blocks. An alert requires the suspect to exceed the paired reference by both 25% and 10 ms in every block. A repair must be within that budget in every block to verify recovery. Mixed blocks return `inconclusive`. These are pilot thresholds with no estimated false-positive rate.

Every complete run writes the same JSON to stdout and to a new file under `latency-cases/<case-id>/` beside the manifest. Reruns and different proposed repairs preserve earlier evidence under the same ID. Files include ordered samples, revision SHAs, environment, fixture and harness hashes, the decision and the next action. A completed comparison exits zero even when it finds a regression. Automation should read `state`. Invalid inputs, builds or measurements exit nonzero.

## Investigation handoff

1. On `needs-investigation`, inspect the triggering workload, the raw launch samples, and the diff between the two revisions. Reproduce the failing fixture before proposing a change.
2. Choose one suspected cause and transfer only that change onto the slow revision. Keep the healthy reference, suspect and workload fixed. Add the proposed repair SHA and rerun the case.
3. On `still-regressed`, review the failed hypothesis. On `inconclusive`, repeat on an idle runner and retain both reports. On `no-alert`, archive the evidence.
4. On `recovery-verified`, review correctness tests and the patch. Release verification requires an independent measurement against the shipped package. A local source replay establishes build-level recovery.

The pilot starts when a contributor supplies a case. It writes a handoff for a human or agent to review. Hosted agent dispatch, subscriptions and monitoring the published npm package are outside this prototype.

For this case the original patch changed eight utility files. The old data URL parser visited each space individually, repeatedly checking where raw markup ended. The candidate scanner recognizes a run of whitespace in one boundary match. To isolate that file on a fresh checkout, create a disposable local commit with the commands below. Use its SHA as `repair`. Git author and timestamp differences can give the same file tree a different commit SHA.

```sh
workdir=$(mktemp -d)
git worktree add --detach "$workdir/replay" 9ec0e20
git -C "$workdir/replay" restore --source=5e681ab --staged --worktree -- src/utils/dataUrl.ts
git -C "$workdir/replay" commit -m 'Isolate the historical data URL change'
git -C "$workdir/replay" rev-parse HEAD 'HEAD^{tree}'
git worktree remove "$workdir/replay"
rmdir "$workdir"
```

## Results

| Case | Reference (ms) | Suspect (ms) | Repair (ms) | Decision |
| --- | ---: | ---: | ---: | --- |
| Historical detection | 4.20 | 72.11 | — | needs-investigation |
| Candidate on main | 5.44 | 68.59 | 4.47 | recovery-verified |
| Unchanged slow repair | 3.38 | 75.62 | 79.44 | still-regressed |
| One-file repair | 5.39 | 77.96 | 4.55 | recovery-verified |
| Same-build Axe control | 1,071.73 | 1,006.00 | — | no-alert |

Values are the median of launch medians, in milliseconds. Each decision uses the individual paired blocks. The five primary cases comprise 43 launches and 129 timed calls. The evidence also contains the initial detection and two exploratory runs where the one-file replay and Axe control overlapped. Both were rerun sequentially for the table. [All raw timings, order, environment and revisions](performance-factory-poc.json)

The isolated repair uses tree `db0e4c20b1ea818518d826c4b31a3dde0f446f09`. Its only changed path relative to the slow commit is `src/utils/dataUrl.ts`. Returning the slow build as its own repair kept the case open. The same-build control tests one host and workload, so it cannot establish a general false-alert rate.

## Adoption scorecard

Scores run from 1 (high friction) to 5 (favorable). The scores describe this repository pilot.

| Criterion | Score | Basis |
| --- | ---: | --- |
| API simplicity | 4/5 | One manifest, two workloads, fixed policy. An investigator still has to choose a representative healthy commit. |
| Type safety | 4/5 | Strict TypeScript, runtime schemas for input and timings, and exhaustively mapped decision states. Git, the compiler and the browser remain process boundaries. |
| Testability | 4/5 | The decision policy runs without a browser. Historical recovery, wrong-repair and same-build controls exercise the real tools. Browser variance limits precision. |
| Cyclomatic complexity | 3/5 | ESLint classic complexity on the type-stripped runner finds ten functions including callbacks. The orchestration peaks at 10 and classification at 8. Production scanner functions are untouched. |
| Documentation | 3/5 | OpenAI explains the lifecycle and evaluation approach. Reproduction and state contracts for this adaptation are above. Operating the internal cloud service would require additional documentation and access. |
| Deployment effort | 5/5 for the pilot | Runs on demand in a contributor checkout. No new dependency, token, service, image or release step. A hosted version would need independent runners, persistent case storage, dispatch and release signals. |

**Recommendation.** Use the pilot as an advisory check on performance-sensitive changes. Keep the individual caller-visible fixtures and raw evidence with the PR. Calibrate thresholds on a dedicated runner using more known regressions and healthy pairs before making it a merge gate. A production rollout would also need release-level telemetry and a separate post-release check. The historical replay establishes neither scanner-wide speedup nor production recovery.
