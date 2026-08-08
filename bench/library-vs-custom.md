# Hand-rolled helpers vs. libraries

Where could a published package replace code this repo maintains itself, and
would that actually be faster? Every number below comes from
`npm run bench:libs` (`bench/library-vs-custom.mjs`), with end-to-end context
from `npm run bench` (`bench/mcp-bench.mjs`).

Measured on Linux, Node v22.22.2. `package.json` requires Node >=24; the ratios
are stable across the two, but re-run before quoting absolute figures.

## Summary

| Site | Library considered | Faster? | Verdict |
| --- | --- | --- | --- |
| `src/tools/snapshot.ts`, `src/tools/auditSite.ts` | `re2` (already a dependency) | No — 30–32x slower | **Keep it anyway** |
| `src/utils/jsSource.ts` | `acorn` | No — 19x slower | Keep the hand-rolled lexer |
| `src/mcp/manualPromise.ts` | `Promise.withResolvers` (built-in) | Yes — 1.36x | Optional cleanup, not a perf win |
| `src/utils/fileUtils.ts` | `sanitize-filename` | No — 2.7x slower | Keep; also not equivalent |
| `src/tools/network.ts` | `content-type` | Yes — 1.4–2x | Not worth a dependency |
| `src/utils/dataUrl.ts`, `src/utils/ariaCompression.ts` | none exists | — | Nothing to swap in |
| `package.json` | `mime`, `dotenv`, `@cfworker/json-schema` | — | Declared but never imported |

The short answer: **in six of seven cases the hand-rolled code is already the
faster option, and the one library that is unambiguously worth keeping — `re2` —
is kept precisely because it is slower.**

## `re2` vs. the built-in `RegExp`

`buildExcludePathPatterns` in `src/tools/auditSite.ts` and `compileRegex` in
`src/tools/snapshot.ts` compile patterns that arrive as tool arguments. Both use
the `re2` native addon rather than `new RegExp`.

| Operation | `RegExp` | `re2` | Ratio |
| --- | --- | --- | --- |
| Compile 5 crawl exclude patterns | 1.18 µs | 72.1 µs | 61x slower |
| Match 7 URLs against 5 patterns | 817 ns | 26.1 µs | 32x slower |
| Search a 1,000-line snapshot | 33.2 µs | 1.07 ms | 32x slower |
| Search an 8,000-line snapshot | 288 µs | 8.57 ms | 30x slower |
| Cold `require` over an empty-module baseline | 0 ms | ~0 ms | — |
| Install footprint (standalone) | 0 | 29 MB, 2,656 files, ~3 s | — |

Loading the addon is free in practice: a cold `require('re2')` measured 11.21 ms
against an 11.27 ms baseline for requiring an empty file, so the cost is this
sandbox's fixed module-resolution overhead rather than the package.

Compile timings are the noisiest measurement here; across runs a single pattern
landed anywhere between 13 µs and 37 µs.

Against the end-to-end numbers, the match cost is real but small: `browser_find`
has a 37.4 ms median, so the ~1.1 ms `re2` spends searching a typical page's
snapshot is roughly 3% of the call. On a large page it grows to ~9 ms, or about
a fifth of the call. `audit_site` over 6 pages takes 2.39 s, against which the
exclude-pattern work does not register.

What buys that back is the worst case. The patterns are user input, and on
`/^(a+)+$/` against `"a"×n + "b"`:

- `re2`: **0.075 ms** at n=30, and linear from there.
- `RegExp`: **3,690 ms** at n=29, doubling with every additional character.

That is not a slow tool call, it is a hung server, and V8 offers no regex
timeout to bound it. Trading a consistent ~1 ms for the removal of an unbounded
stall is the right trade. **Keep `re2`** — while noting it is 29 MB and 2,656
files of the install, and the only native addon in the tree.

One free improvement: `browser_find` compiles the same pattern twice, once in
the zod `.refine()` validator via `isValidRegex` and once in the handler via
`compileRegex`. At `re2` compile prices that is worth removing, even though it
is small next to the search itself.

## `src/utils/jsSource.ts` vs. `acorn`

`isFunctionSource` is ~190 lines of hand-written scanner deciding whether a
source string is a function literal. `acorn` answers the same question with a
real parser, and the file's own comment says a parser would be more exact — so
the interesting result is that it is not.

Over 23 adversarial sources — grouping parens, comments before the arrow head,
`(a = "=>") => a`, a regex literal in a parameter default:

| | Time (23 sources) | Wrong answers | Cold load over baseline |
| --- | --- | --- | --- |
| `src/utils/jsSource.ts` | 5.9 µs | 0/23 | 0 ms |
| `acorn.parseExpressionAt` | 114.8 µs | 0/23 | +8.7 ms |

19x slower, a new dependency, and ~8.7 ms added to a cold start that a stdio MCP
server pays on every launch — for no correctness gain on the cases that matter.
**Keep the lexer.**

(`acorn` does need `preserveParens: true` to get `(() => 1)` right; without it
the parse ends at the inner arrow and the whole-source check rejects a valid
function literal. Worth knowing if this is ever revisited.)

## `ManualPromise` vs. `Promise.withResolvers`

`src/mcp/manualPromise.ts` subclasses `Promise` to expose `resolve`/`reject`.
Node has shipped `Promise.withResolvers()` since v22, and `package.json` already
requires >=24, so the platform now covers most of what the class exists for.

Per 100 deferreds: `ManualPromise` 5.03 µs, `Promise.withResolvers` 3.69 µs —
**1.36x faster**, or about 13 ns saved per deferred. At the rate this repo
creates them that is unmeasurable.

The case for switching is not speed. It removes a `Promise` subclass and its
`Symbol.species` override, which is the sort of thing engines deoptimise. The
case against is that `ManualPromise` also carries `isDone()`, and
`LongStandingScope` relies on the instances being promises, so a replacement
needs a small wrapper rather than a find-and-replace. **Optional cleanup.**

## `sanitizeForFilePath` vs. `sanitize-filename`

Not a drop-in: 4 of 5 fixture names come out different. The repo's version
collapses runs of unsafe characters to a single `-` and sanitises the extension
separately, which is what the report filenames depend on; `sanitize-filename`
strips instead, and enforces a 255-byte limit the repo's version does not.

It is also **2.7x slower** (5.51 µs vs 2.07 µs over 5 names). Different
behaviour and worse performance. **Keep.**

## `contentTypeOf` vs. `content-type`

The one case where a library both matches and wins. `content-type@2.0.0` is a
char-code scanner with no validation, so it agrees with the five-line inline
parser in `src/tools/network.ts` on all 7 fixture headers — including the
malformed ones, where 1.x would have thrown — and is **1.4x to 2x faster**
across runs (1.08 µs vs 2.20 µs over 7 headers on the run recorded here).

That saves around a microsecond on a tool call measured in tens of milliseconds,
in exchange for a dependency, and the inline version still has to do the
comma-splitting for joined headers first. **Not worth it** — on value, not on
speed.

## No library to swap in

`src/utils/dataUrl.ts` (find and truncate data URLs inside arbitrary snapshot
text) and `src/utils/ariaCompression.ts` (collapse repeated ARIA subtrees) solve
problems specific to this repo; there is nothing published that does either.
`mergeConfig` in `src/config.ts` looks like a generic deep merge but is not — it
forces `browserName`, drops `channel` for non-Chromium and strips `undefined`
per level, so a generic merge would change behaviour. `src/mcp/http.ts` builds
on `node:http` and the MCP SDK's transport rather than a framework, which for
two routes is the cheaper choice.

## The other direction: libraries nothing imports

Three of the twelve runtime dependencies are not imported by any file in `src/`:

| Dependency | On disk | Notes |
| --- | --- | --- |
| `mime` | 0.15 MB | Direct only — removing it drops the package |
| `dotenv` | 0.10 MB | Direct only; `src/external-modules.d.ts` still declares its types |
| `@cfworker/json-schema` | 0.17 MB | Also pulled in by `@modelcontextprotocol/sdk`, so the direct entry is redundant |

Worth noting that `mime` would not have helped the one place that looks like its
job: `isTextualMimeType` in `src/tools/network.ts` classifies a media type as
textual or binary, while `mime` maps extensions to types.
