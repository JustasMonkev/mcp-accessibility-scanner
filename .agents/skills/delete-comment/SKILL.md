---
name: delete-comment
description: Audit and remove code comments in mcp-accessibility-scanner, moving real decisions into ADRs and turning workarounds into issues. Use for /delete-comment, a comment-cleanup PR, or a comments/no-comments lint failure.
---

# Delete comments

Comments in this repository rot: they restate code, outlive it, or excuse a workaround that then spreads. The `comments/no-comments` oxlint rule (`tools/oxlint/comments/`) bans them in the files listed in its `.oxlintrc.json` override, with a per-file ratchet for comments not yet removed. This skill removes comments without losing what they knew.

## 1. Pick the scope

Use the files or directory you were given. Otherwise use the files your branch changed (`git diff --name-only origin/main...HEAD`), or one file from the `comments/no-comments` baseline. Update to the latest `origin/main` first.

To list the comments, add the files to the `comments/no-comments` override in `.oxlintrc.json` without a baseline entry and run `npx oxlint <files>`: every comment is reported with its line. Licence notices, shebangs, `eslint-`/`oxlint-` directives, `@ts-expect-error` and `/** @public */` or `/** @internal */` annotations are exempt and must stay.

## 2. Categorise every comment

Read each comment next to the code it describes, its callers and its tests. Check every factual claim against the current code before trusting it. Put each comment in exactly one category:

| Category | Meaning | Action |
|---|---|---|
| **Tautology** | Repeats what the code, its names or its types already say. | Delete it. |
| **Stale** | Describes code or behaviour that no longer exists, or that the code now contradicts. | Delete it. |
| **Excuse** | Explains why a hacky, fragile or duplicated implementation is acceptable (a timing heuristic, a value configured in two places, a known gap). | Delete it, and file a GitHub issue to fix the implementation: what is hacky, the failure it can cause, the expected behaviour and acceptance criteria. Link the PR. |
| **Decision Record** | Records an important, non-obvious decision or constraint: why this approach, a protocol or browser fact the code relies on, a trade-off. | Move it into an ADR in `docs/decisions/`, either the ADR for that area or the next numbered one, using the existing ADR headings. Then delete it. |

Classify a test comment the same way. A test's name should carry its intent; if a comment explains a non-obvious test technique, that is a Decision Record.

Record every comment in the PR description as path, line, category and action. Link the issue or ADR section for each Excuse and Decision Record.

## 3. Delete

Remove the comments, and remove the line too when the comment stood alone on it. Change nothing else. Keep string literals, test descriptions and fixture content that only look like comments. When a deletion makes code unclear, rename or extract a function rather than keeping the comment.

## 4. Tighten the ratchet

For each file in the override, set its `baseline` entry to the number of comments that remain, or delete the entry when none remain. The rule fails when a file has more comments than its baseline, and also when it has fewer, so a baseline can only go down. Count individual comments: every `//` line is one. Add new files to the override with no baseline entry.

## 5. Report and verify

- Report the lines removed (`git diff --stat` on the touched files) separately from lines added to ADRs, the lint config and tests. Inline trailing comments remove no lines. Estimate what the remaining baseline would remove by summing the stand-alone comment lines.
- Run `npm run lint`, the affected tests and the checks in AGENTS.md before pushing.
