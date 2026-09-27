# Coding standards

Use this document during code review. It covers judgment calls that linting and typechecking cannot settle. Apply the sections touched by the diff; support findings with a concrete input, execution path, or failure sequence.

These standards derive from the repository's [recorded review findings](.codex/skills/pre-push-review/references/codex-findings-catalog.md), not a new audit of the implementation. The [pre-push checklist](.codex/skills/pre-push-review/SKILL.md) owns the detailed edge cases and verification procedure.

## 1. Make accepted configuration mean the same thing across modes

Review an option as an end-to-end contract, from merged configuration to the runtime consumer. Each affected browser mode, transport, and proxy path must either deliver the advertised behavior or reject an unsupported combination clearly. A value reaching a factory is not evidence that the browser uses it.

Judge compatibility by observable behavior: defaults, explicit values, runtime updates, errors, and downstream consumers. A refactor that narrows behavior needs an explicit product decision, not just passing tests for the new path.

**Review evidence:** identify the affected consumers and tests demonstrating the behavior or rejection in each supported path. See checklist sections 1 and 9.

## 2. Preserve the user's state on rejected operations

Place validation before the first side effect it can prevent. Restoring viewport or media settings does not undo navigation, lost form input, or application mutations. Distinguish invalid requests from failures encountered while executing a valid request.

**Review evidence:** an invalid-input test demonstrates both the error and the absence of the relevant side effect. See checklist section 2.

## 3. Report what was actually evaluated

Keep clean, incomplete, failed, and unevaluated outcomes distinguishable in both human-readable and structured results. A zero finding count is meaningful only with evidence of evaluation. Reported artifacts must remain usable when the response reaches the caller.

Review output transformations across all channels carrying the same data. Privacy or size limits on one channel are insufficient if another leaks the payload; truncation must preserve the surrounding structure needed by downstream tools.

**Review evidence:** exercise an unevaluated or partial-result case, and check agreement between summaries, fields, and artifacts. For transformations, include bypass inputs and ordinary text that must survive unchanged. See checklist sections 3, 4, and 7.

## 4. Give concurrent work explicit ownership

Judge cleanup by what an operation owns, not what happens to be newest or visible in shared state. Cancellation, failure, and out-of-order completion must preserve sibling calls, sessions, and in-flight artifacts. A timeout is not sufficient if the underlying work continues mutating shared state after the caller returns.

**Review evidence:** trace resource ownership through acquisition, failure, cancellation, and release; use a regression test for the changed overlap or failure sequence. See checklist section 5.

## 5. Evaluate accessibility semantics, not convenient proxies

Assess a heuristic against the user experience it claims to measure. DOM structure, CSS properties, hit-testing, painted visibility, and the accessibility tree are different sources of evidence; substituting one for another needs justification.

Treat false positives as correctness defects alongside missed violations. Accept a detection ceiling only when its tradeoff is supported by measurements or representative examples and its limitation is documented. Scope tests to the browser environments the changed heuristic encounters.

**Review evidence:** include a true violation and a similar valid case, plus relevant boundary fixtures from checklist section 8. Consult the catalog's owner-rejected findings when weighing a detection tradeoff.

## 6. Make verification sensitive to the claimed defect

Choose tests that fail when the user-visible regression returns. Assertions about helper calls alone do not establish correct behavior through a CLI, transport, browser factory, or report consumer. For a refactor, preserve the existing contract tests and cover any affected paths they missed.

Keep mechanical rules in executable tooling. When a new finding can be detected deterministically, extend the existing lint, test, or CI checks instead of adding a prose prohibition here. Use [package scripts](package.json), [lint configuration](.oxlintrc.json), and [CI](.github/workflows/ci.yml) as the authority for commands and configured enforcement; verify that a relevant rule actually runs.

**Review evidence:** name the checks run, their results, and any remaining unverified paths. See checklist sections 11 and 12 for documentation and harness consistency.
