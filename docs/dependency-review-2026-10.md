# Dependency review, October 2026

Twelve investigators reviewed runtime imports, browser tooling, test and lint configuration, package reachability, and measurement options. Remove the unused development dependencies `happy-dom` and `@types/chrome`. Keep the remaining dependencies: their imports, configured commands, or peer requirements establish a current use.

## Removal scope

Tests use the Node environment or real Playwright browsers, not Happy DOM. The server's extension wire protocol declares local structural types instead of importing `@types/chrome`. Neither dependency is required by the supported build or test configuration.

Removing those two direct dependencies also removes seven exclusive transitive packages:

| Removed direct dependency | Exclusive transitive packages removed |
| --- | --- |
| `happy-dom` | `@types/whatwg-mimetype`, `buffer-image-size`, `entities`, `whatwg-mimetype` |
| `@types/chrome` | `@types/filesystem`, `@types/filewriter`, `@types/har-format` |

The nine removed package directories occupied 18,908 KiB (18.46 MiB) of allocated disk space and 9,896,354 logical bytes in the measured baseline installation. These are development-install savings, not production bundle or browser-download savings. The lockfile has 304 package entries, down from 313 including the root entry. Every retained package object is unchanged, including all 34 entries with native `libc` metadata.

## Retained dependencies

| Group | Reason to retain |
| --- | --- |
| Playwright packages | Browser automation and browser tests use them. Shared browser implementation packages are already deduplicated; removing a direct entry is not equivalent to removing that implementation. |
| MCP runtime packages | Server transports, tool registration, and runtime schema validation use them. |
| RE2 | Provides bounded regular-expression execution for user-supplied patterns. A native JavaScript replacement would change the safety properties. |
| `debug`, `ws`, and their type packages | Logging and WebSocket code import them directly; they remain needed after Happy DOM removal. |
| Axe and Commander | Accessibility scans and the published CLI depend on them. |
| ESLint plugins and ESLint | Oxlint loads the configured JavaScript plugins. ESLint also satisfies their peer requirements; absence from ordinary source imports does not make these packages unused. |
| Vitest UI and coverage packages | Existing UI and coverage commands use them. |
| JSON Schema types | Test code uses them to check tool schemas. |
| Remaining build, lint, test, and editor dependencies | Their configured workflows or direct imports require them. No additional removal was justified by the investigation. |

## Verification and performance

Before removal, lint, build, and Knip passed. Vitest passed 67 test files and 1,645 tests; two files and five tests were skipped.

Clean `npm ci` passed after removal, and neither removed direct dependency was installed. All 134 compiled-file SHA-256 hashes match the baseline.

The initial benchmark overlapped with concurrent tests and is not used in the comparison. The quiet before/after runs used five measured iterations per tool scenario after one warmup, plus 20 samples per microbenchmark. Both ran without concurrent tests on Node 26.5.0, npm 12.2.0, Playwright 1.63.0, and macOS arm64.

| Measurement | Before | After |
| --- | ---: | ---: |
| Sum of tool-scenario median latencies | 14,141.5 ms | 14,122.4 ms |
| Lockfile entries, including root | 313 | 304 |
| Compiled files | 134 | 134, identical hashes |

The latency aggregate changed by -0.14%, within ordinary timing noise. It sums independent scenario medians rather than measuring an entire workflow or server startup. Individual sub-millisecond scenarios show larger percentage fluctuations; these runs do not establish a speedup or a statistical no-regression bound.

Both removed direct dependencies are development-only and are not imported by the server. No runtime speedup is claimed. The expected benefit is a smaller development installation.

Post-removal lint, build, strict Knip, and `npm ls --all` passed. Vitest again passed 67 test files and 1,645 tests, with the same two files and five tests skipped. Five independent reviewers found no dependency-removal or contract regressions. Five implementation agents and five testing agents handled the changes and verification after the twelve-agent investigation.

Focused V8 coverage validation passed all 163 tests in `mcp-tool`, `extension-protocol`, and `tools-snapshot`. This validates the existing coverage provider and affected schema/protocol tests; it is not a full-suite coverage measurement.

The direct MCP harness passed all 34 tools, including `browser_install`, with no failures or skips against the changed worktree. The full Luna MCP suite also passed all 34 prompts with no failures, using `gpt-6-luna`, xhigh reasoning, and the unchanged 120-second per-prompt timeout. The first sandboxed Luna invocation could not bind its local fixture socket; the unchanged full suite passed with normal command escalation.

Reproduce the checks from the repository root:

```bash
npm ci
npm run lint
npm run build
npm run knip
npm ls --all
npm test
npm run test:coverage -- tests/mcp-tool.test.ts tests/extension-protocol.test.ts tests/tools-snapshot.test.ts
npm run test:mcp:install
npm run test:mcp:luna
```

No TypeScript or JavaScript implementation changed, so the lazy-clean checker inspected zero applicable files; the dependency diff received the manual simplification review. The corrected direct-harness run explicitly used the worktree's script and server directory; an earlier run against the original checkout was excluded from the evidence.
