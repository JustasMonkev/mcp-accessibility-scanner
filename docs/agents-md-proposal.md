# AGENTS.md (proposed)

> Draft to replace the current `AGENTS.md`. The checks it names exist (`npm run check`, see
> `docs/checks-benchmark-2026-11.md`).

Node.js + TypeScript (ESM, TypeScript 7, Node `^24.15 || >=26`) MCP server for accessibility audits
(axe-core 4.14 plus custom audits) and browser automation on Playwright 1.65.1. Published as
`mcp-accessibility-scanner`, binary `mcp-server-playwright`.

Read next, when the task touches them:

- `CONTEXT.md`: domain language. A browser session is not an MCP session.
- `CODING_STANDARDS.md`: review judgment that lint cannot settle.
- `docs/decisions/`: ADRs. Read every ADR for the area you change, in full, before designing.
- `.codex/skills/pre-push-review/SKILL.md`: required self-review before every commit.
- `docs/releasing.md`: releases.

## Commands

While iterating:

- One test file: `npx vitest run tests/<name>.test.ts`
- One test: `npx vitest run tests/<name>.test.ts -t "<test name>"`
- Types: `npm run typecheck`

Before reporting any code change (full output, fix every error and warning):

- `npm run check`: oxlint, tsc, knip, pinned and runtime dependencies, DEPS.list boundaries
- `npm run test:scripts` when you change `scripts/`
- `npm test`

Also run when you touched:

- `cli.js`, packaging, or `src/program.ts`: `npm run build && npm run test:mcp`
- `Dockerfile` or process cleanup: `npm run test:docker`
- a tool's hot path: `npm run build && npm run bench:compare`

`tests/*.integration.test.ts` for other browsers and operating systems run in CI (`.github/workflows/ci.yml`).
If you could not run one locally, say so by name. Do not claim it passed.

## Modules and boundaries

`src/**/DEPS.list` lists what each directory may import. `npm run check:deps-list` enforces it; type-only imports
are exempt.

| Directory | Owns | May value-import |
| --- | --- | --- |
| `src/utils/` | Leaf helpers: URLs, redaction, timeouts, errors, logging | nothing in `src/` |
| `src/mcp/` | MCP server, HTTP transport, tool policy, proxy relay | `utils/` |
| `src/tools/` | One MCP tool family per file, plus measurement modules | `utils/`, its own directory |
| `src/extension/`, `src/vscode/` | Browser providers for the extension and VS Code | `mcp/`, `utils/`, the root modules in their `DEPS.list` |
| `src/*.ts` | Composition: config, context, tabs, sessions, context factories, program | anything above |
| `lib/` | Generated build output | never edit |

If the import you need is forbidden, the code is in the wrong module. Move the shared part down (into `utils/`, or a
type) instead of editing `DEPS.list`. Changing `DEPS.list` is an architecture decision: ask first.

## Code rules that lint does not cover

- Read a file in full before editing it. Do not design from search snippets.
- Before designing a fix, check how the sibling implementations handle the same concern (the other browser providers,
  the other audit tools, both proxy adapters) and follow that pattern. If you deviate, say why.
- One concept per file, named after it. Split by concept, not by size; a second concept is the reason to split. Do not
  add a new concept to a file over 800 lines (`src/tools/auditSite.ts`); extract it.
- Comment only where the code cannot explain itself: a non-obvious why, a format or edge case, a usage line for a
  script. Never restate what the next line does, and add no doc comments by default. Tool-required comments stay
  (license headers, `@internal` for knip).
- Functions longer than about 40 lines need a reason. No boolean parameters that switch behaviour: use two functions
  or a tagged value. (`max-params: 5` is linted.)
- Use tagged unions for states and results. Results keep clean, partial, failed and unevaluated apart
  (CODING_STANDARDS section 3).
- Validate only at trust boundaries: zod tool input schemas, CLI, config and environment parsing, CDP and WebSocket
  messages, values returned from page evaluation. Do not add `typeof` or `instanceof` guards on values that are
  already typed. Put any constraint that zod can express in the schema, not in the handler.
- No `any`. A cast needs a one-line comment saying why it is safe.
- Use top-level imports. The existing dynamic imports (`src/config.ts`, `src/vscode/main.ts`) break cycles or load
  the user's Playwright. Do not add more without the same reason.
- Reuse `src/utils/` before writing a helper. Inline a one-line helper that has one caller.
- Never remove or downgrade code to fix a type error. Ask before removing behaviour that looks intentional.
- Use named Playwright type imports for `Request` and `Response`, never `playwright.Request`.
- Do not rename the package, the binary, or published tool names unless asked.
- Runtime dependencies are pinned exactly (`check:pinned-deps`). Every bare import in `src/` is declared in
  `dependencies` (`check:runtime-deps`). Change `package-lock.json` only when the task is a dependency change; the pre-commit hook
  (`.githooks/pre-commit`) asks for `ALLOW_LOCKFILE_CHANGE=1` and refuses lockfiles that drop `os`, `cpu` or `libc`.

## Definition of done, by kind of issue

Every kind of issue:

1. Re-read every changed file top to bottom, as a stranger would.
2. Work through `.codex/skills/pre-push-review/SKILL.md` against the diff.
3. Run `npm run check` and `npm test`.
4. Report each command with its result, and list anything you could not verify.

Never delete, skip or weaken an existing test to get a green run.

**Bug**

1. Reproduce on `main` first with a test that fails. Show the failure. Name the issue in the test (`// #<issue>`).
2. Fix the root cause.
3. Show the test passes with the fix and fails without it.

**Feature**

1. Write a brief first, in the issue or the PR: the tool surface (names and zod schema), every browser mode and
   transport it affects (pre-push-review section 1), the files to change, the tests, and the README changes.
2. Stop for approval when the brief adds a tool name, an option, or an output format.
3. Implement it, with a test for each affected mode, then update `README.md`.

**Playwright or browser upgrade**

1. Bump `playwright` and `playwright-core` together, to the same exact version.
2. Update every `mcr.microsoft.com/playwright:v…` image reference (`grep -rn "playwright:v" .github Dockerfile`).
3. Check that the `playwright-core/lib/coreBundle` typings in `src/external-modules.d.ts` still match.
4. Run `npm run build`, `npm test`, `npm run test:mcp` and `npm run test:docker`.
5. Record the CI matrix results in `docs/browser-upgrade-validation-*.md`.

**Dependency bump**

1. Read the release notes for the target version first.
2. Name any behaviour change that affects this server.

## Git and PRs

- One issue per branch and per PR. The PR body says `Closes #<n>`, lists the commands with their results, and names
  what was not verified.
- Commit messages follow the existing style: `fix: …`, `feat: …`, `docs: …`, `chore: …`.
- Stage explicit paths. Never `git add -A`, `git add .`, `--no-verify`, or a force push to a shared branch.

## Boundaries

- Always: run the checks above, add a regression test for a bug, and update `README.md` when tools, options or
  output change.
- Ask first: editing `DEPS.list`, removing behaviour, adding a runtime dependency, changing a published tool's schema
  or output format.
- Never: edit `lib/`, commit secrets or `.mcp.json` paths, or merge your own PR.
