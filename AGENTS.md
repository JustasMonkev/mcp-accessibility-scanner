- This repository is a Node.js + TypeScript MCP server for automated accessibility scanning and browser automation.
- Runtime entrypoints are `cli.js` for the published CLI and `src/index.ts` / `src/program.ts` for source-level behavior.
- Built output lives in `lib/` and should be treated as generated artifacts.
- Keep changes focused and minimal; fix root causes instead of layering workarounds.
- Match the existing TypeScript and ESM style already used in `src/`.
- Do not rename the published package, binary name, or exported tool names unless explicitly requested.
- Update `README.md` when user-facing behavior, commands, configuration, or tool surfaces change.
- Prefer editing source files in `src/`; do not hand-edit generated files in `lib/`.
- `src/tools/`: MCP tool implementations, including accessibility scans and browser actions.
- `src/mcp/`: MCP transport/server helpers.
- `src/extension/` and `src/vscode/`: editor/extension integration code.
- `src/utils/`: shared utilities.
- Use nearby Vitest coverage when adding or changing behavior that is already tested.
- Install dependencies: `npm install`
- Build: `npm run build`
- Lint: `npm run lint`
- Test: `npm test`
- Coverage: `npm run test:coverage`
- Docker smoke test: `npm run test:docker`
- Tool latency benchmark: `npm run bench` (see the Benchmarking section of `README.md`; build first, and compare revisions with `npm run bench:compare`)
- Hand-rolled helper vs library benchmark: `npm run bench:libs` (build first; conclusions recorded in `bench/library-vs-custom.md`)
- TypeScript config is driven by `tsconfig.json` and `tsconfig.all.json`.
- Accessibility behavior centers around Axe + Playwright integrations in `src/tools/axe.ts`, `src/tools/auditSite.ts`, `src/tools/auditKeyboard.ts`, and related helpers.
- Keep output and report paths compatible with the current README and CLI expectations.
- Reuse existing helpers before introducing new abstractions.
- Prefer targeted validation first, then broader checks if needed.
- When touching build, lint, or test behavior, run the relevant npm script before finalizing.
- Before committing or pushing, self-review your diff against `.claude/skills/pre-push-review/SKILL.md` — a checklist of the recurring defect patterns automated PR review keeps finding in this repo.
- Avoid introducing ignored or generated artifacts into version control; `.gitignore` already excludes `lib/`, `coverage/`, Playwright reports, and similar outputs.

<!-- OPENWIKI:START -->

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with `openwiki/quickstart.md`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

OpenWiki pages are generated documentation. Do not hand-edit them unless explicitly asked; prefer updating source code/docs, then regenerate OpenWiki.

<!-- OPENWIKI:END -->
