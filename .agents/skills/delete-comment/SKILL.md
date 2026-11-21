---
name: delete-comment
description: Audit and remove implementation comments in mcp-accessibility-scanner. Use for /delete-comment, a comment cleanup PR, or a no-new-comments lint failure.
---

# Delete a comment

1. Take the requested file or directory, or choose a small batch from the remaining inventory. Run `node scripts/lint-comments.mjs --inventory` at the repository root. The tab-separated fields are path, starting line, kind, removable physical lines, and quoted text. Group adjacent lines that express one thought, keeping each original line traceable.
2. Read each prose comment with its implementation, callers and nearest tests. Preserve copyright notices, interpreter directives, functional annotations and consumer-facing declaration documentation. Verify stale claims against the current implementation.
3. Record the original path, line, category and action in the PR. Delete **Tautology** when the code already says it. Delete **Stale** when the implementation contradicts it. For **Excuse**, identify the specific workaround, find or open a GitHub issue with the affected behavior and acceptance criteria, link it, then remove the comment. For **Decision Record**, move the rationale and trade-off into the relevant file in `docs/decisions/` or create the next numbered ADR. Keep test descriptions, generated snippets and literal fixture content intact.
4. Sum the removable-line column for the selected entries before editing. Compare it with the actual source diff. Inline comments can save zero lines. Report the remaining estimate separately from added ADR, lint or test lines.
5. Run `npm run lint`, `npm run test:scripts`, the affected tests and the pre-push checks in AGENTS.md. Compare the PR against its actual base with `COMMENT_BASE_REF=<base-sha> npm run lint:comments`. A deleted comment reduces the next PR's allowance automatically.
