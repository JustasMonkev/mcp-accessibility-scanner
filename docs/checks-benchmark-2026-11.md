# Pi's checks, replayed over this repo's history

Date: 2026-11-16. Question: if pi's code checks had run on every change to this repo, what would they have caught,
what would they have cost, and what do they miss?

## What was ported

| Check | Source in pi | What it does here | Time |
| --- | --- | --- | --- |
| `npm run check:pinned-deps` | `scripts/check-pinned-deps.mjs` | Every dependency in `package.json` uses an exact version | 0.05 s |
| `npm run check:runtime-deps` | `scripts/check-runtime-deps.mjs` | Every package `src/` imports at runtime is in `dependencies` | 0.6 s |
| `npm run check:deps-list` | `scripts/check-entry-graphs.mjs` (the import walker), with Playwright's `DEPS.list` format | `src/**/DEPS.list` module boundaries, type-only imports exempt | 0.6 s |
| `.githooks/pre-commit` | `.husky/pre-commit` and `scripts/check-lockfile-commit.mjs` | Blocks a staged `package-lock.json` unless `ALLOW_LOCKFILE_CHANGE=1`; then runs `npm run check` | under 0.1 s, plus the check |
| `npm run check` | pi's root `check` script | `oxlint`, `tsc`, `knip --strict`, then the three checks above | 9.5 s |

`npm run test:scripts` runs 13 tests (`scripts/checks.test.mjs`) that show each check passes clean code and fails a
violation. CI runs `npm run check` and `npm run test:scripts` in place of the old typecheck and lint steps.

Not ported: `check-ts-relative-imports.mjs`, because this repo imports `.js` and oxlint already enforces it;
`biome-check.mjs`, because this repo uses oxlint; `check-package-install.mjs`, skipped by decision.

## Method

- **History replay.** `node bench/checks-history.mjs --out history.jsonl` takes all 299 changes that landed on
  `main` (first-parent commits, 214 of them PR merges). For each change it runs today's check scripts on the tree
  before and after, and records which violations the change introduced and which it removed. A full replay takes
  70 seconds.
- **Issues.** All 86 issues are closed. 46 of them link to a merged PR (a closing keyword in the PR body or an
  `issue-N` branch name), across 38 PRs. Each issue was put into one kind by its title and labels: 27 decision or
  tracking issues, 11 Playwright upgrades, 5 features and 3 bugs.
- **User reports.** The bug reports filed by users (#12, #13, #45, #84, #195) were read in full and traced to their
  cause.
- **Review findings.** The 179 Codex review findings in `.codex/skills/pre-push-review/references/codex-findings-catalog.md`
  were sorted into those a deterministic check could catch and those that need a test or a reviewer.

## Results over 299 changes

| Check | Trees failing | Changes that introduced a violation | Real problems found |
| --- | --- | --- | --- |
| pinned-deps | 299 of 299 (never pinned) | 13 | It explains user bug #13 (below). Pinned since today. |
| runtime-deps | 52 | 3 | `zod` was imported but not declared from 2025-07-22 (#9) to 2025-12-12 (#25), across releases 2.0.0 to 2.0.3. It worked only because the MCP SDK happened to install it. |
| deps-list | 117 | 8 PRs: #170, #210, #255, #291, #313, #321, #323, #344 | Every `DEPS.list` boundary violation on `main`. The files have not changed since 2025-09-20 and nothing read them. |
| knip --strict (not replayed) | fails on `main` today | n/a | It isn't in CI, so it drifted: a test-only file and a test-only export were reported. Fixed in this change. |

Today's tree passes every check. The 11 existing boundary crossings are recorded as per-file exceptions in the
`DEPS.list` files. 8 of them are `src/mcp/` importing `src/utils/` (mostly `log.ts`), which is a decision to make,
not a bug.

**False positives: none.** Every failure in the replay was a real violation of the rule as written. The only noise
was a parsing bug in the harness (the pinned-deps fix hint was indented like a violation), fixed before the full
run.

## Results against issues

| Kind | Issues | PR added tests | Regression test names the issue | README updated | Structural check flagged the PR |
| --- | --- | --- | --- | --- | --- |
| Decision or tracking | 27 | 24 | 1 | 23 | 2 (#289 and #290, both via PR #291: deps-list) |
| Playwright upgrade | 11 | 10 | 3 | 10 | 0 |
| Feature | 5 | 5 | 0 | 4 | 0 |
| Bug | 3 | 3 | 1 | 2 | 0 |

The structural checks flag 1 of 38 issue PRs. That is expected: the issues were about behaviour (races, Playwright
changes, accessibility heuristics), which a static check cannot see. The process is already strong: 42 of the
46 issues came with tests and most updated the README. One gap stands out: only 5 of 46 regression tests name the
issue they cover.

## User-reported bugs: would a check have caught them?

| Issue | Cause | Caught by |
| --- | --- | --- |
| #12 `ERR_MODULE_NOT_FOUND` for `lib/program.js` after `npx` install | The published tarball was broken | Nothing. A tarball install test would; skipped by decision (2026-11-16). |
| #13 `locator._generateLocatorString is not a function` | `"playwright": "^1.54.1"` let users get a newer Playwright that removed a private API | **pinned-deps.** An exact pin keeps users on the tested version. |
| #84 `_evaluateFunction is not a function` | A private Playwright API removed in 1.59; the repo was pinned, the upgrade broke it | Nothing yet. A private-API contract test would (improvement 2). |
| #45 Docker image missing for amd64 | Image publishing | Not a code check |
| #195 missing accessible names on `<a><strong>Docs</strong></a>` | Playwright 1.62 changed AI snapshot naming | A test on the upgrade path, which is how it was fixed |

## Codex review findings a check could catch

Most of the 179 findings need a test or a reviewer. These can be checked mechanically:

| Finding (catalog section) | Check | Status |
| --- | --- | --- |
| Lockfile regenerated with another npm version dropped `libc` fields from native packages: #87, and #139, which merged 18 lost fields to `main` (section 9) | The lockfile guard now blocks any lost `os`, `cpu` or `libc` field, even with `ALLOW_LOCKFILE_CHANGE`. Replaying #139's lockfile through the guard fails it. | Added |
| README not updated for new tools (section 11) | `tests/readme-tools.test.ts`: every registered tool is named in README.md. On `main`, 11 to 30 tools were undocumented for 106 consecutive changes (2025-07-22 to 2026-06-25), until the doc audit in PR #97. | Added |
| Named ESM imports from the CommonJS `playwright-core/lib/coreBundle` (section 9, P1, #76) | oxlint `no-restricted-imports` with a message saying to use the default import | Proposed |
| Numeric schema fields that accept 1.5 or −1 (sections 2 and 6) | A test that walks every tool's input schema and requires integers and bounds on count-like fields | Proposed |
| `playwright`, `playwright-core` and `@playwright/test` on different versions (#124) | A version-alignment check, including the CI image tag | Low priority: 0 of 299 trees on `main` had a mismatch |

## What is missing, in priority order

1. **A contract test for private Playwright APIs (would have caught #84; the cause behind #13, #188 and #271).** 13
   uses of `playwright-core/lib/coreBundle` in 6 source files are typed by the hand-written `src/external-modules.d.ts`,
   so `tsc` passes even when Playwright removes a member. Add one test that loads `coreBundle` and checks that every
   member that file declares exists with the right kind. The Playwright upgrade playbook then fails right away
   instead of at runtime.
2. **Run the lockfile platform check in CI too.** The pre-commit hook guards local commits only, and #139 was merged
   on GitHub. Give the guard a `--base <ref>` mode and run it on pull requests against the base branch.
3. **Decide the `src/mcp/` boundary.** 8 of the 11 recorded exceptions are `mcp/` importing `utils/log.ts`,
   `terminal.ts`, `httpUrl.ts` and `urlRedaction.ts`. Either allow `../utils/` in `src/mcp/DEPS.list` or keep
   `mcp/` free of the app. The new check enforces whichever is chosen.
4. **Name the issue in regression tests.** 5 of 46 do today. A CI step can require that a PR saying `Closes #N`
   changes `tests/` and mentions `#N` there, unless it is labelled docs or decision.
5. **A Stop hook for agents.** Pi relies on its pre-commit hook. Agents here also work through PRs, so a Claude Code
   `Stop` hook running `npm run check` keeps a session from ending red. The git hook only runs once
   `git config core.hooksPath .githooks` is set (`npm install` does it through `prepare`).
6. **Keep exact pins on Dependabot updates.** There is no `.github/dependabot.yml`. If version updates are turned on,
   set `versioning-strategy: increase` so its PRs keep exact versions and pass `check:pinned-deps`.

## Limitations

- The replay runs today's scripts against old trees. It covers the dependency-free checks only: `tsc`, `oxlint`
  and `knip` need each commit's own `node_modules`, so they were not replayed.
- Issues were linked through PR bodies and branch names only. 40 of the 86 issues were closed without a linked PR,
  mostly tracking or decision issues.
- Issue kinds come from a heuristic over titles and labels.

## Reproduce

```bash
npm ci
npm run check
npm run test:scripts
node bench/checks-history.mjs --out /tmp/history.jsonl
```
