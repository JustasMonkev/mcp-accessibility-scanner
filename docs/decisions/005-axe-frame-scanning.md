# ADR-005: Scan frames with axe runPartial and finishRun

## Status

Accepted for #361, 2026-11-21. Replaces the `axe.run` and frame-messaging integration in `src/tools/axe.ts`. The rationale here used to sit in code comments, which a lint ratchet now bans in the affected files.

## Context

`axe.run` reaches child frames over `postMessage`. That required every injected copy to accept messages from any origin (`allowedOrigins: ['<unsafe_all_origins>']`). It also skips frames that do not answer its ping without saying so. About 260 lines re-implemented axe's frame selection to guess which frames had been skipped, and the guess missed sandboxed frames. Re-injecting on every scan also stacked message listeners, so each repeat scan of a tab was slower than the last.

## Decisions

**Axe chooses the frames, Playwright drives them, Node merges.** In each document, `axe.utils.getFrameContexts` returns the child frames axe would scan, with the context for each. That applies axe's own scope, visibility and shadow-DOM rules. The server runs `axe.runPartial` in each of those frames through Playwright, at most four siblings at a time, and merges the results with `axe.finishRun` in Node.

`finishRun` needs no DOM. Running it in Node rather than in a page keeps findings from cross-origin frames away from third-party page script. The scan never chooses frames by walking Playwright's frame list. That list is consulted only to find frames axe could not see (below) and to skip the frame lookup in documents with no child frames.

**A private axe global.** axe installs under `window.__mcpAccessibilityScannerAxe`, and `window.axe` is restored afterwards. A page that ships its own axe-core, or replaces `window.axe`, can neither replace this build nor be replaced by it.

**Frame elements are captured at selection.** `getFrameContexts` identifies frames by positional selectors (`iframe:nth-child(2)`). The iframe elements are resolved in the same in-page task that selects them, and each child is reached through its own element handle. Resolving the selectors later could land on a different frame once an earlier sibling is removed, which would file that frame's findings under the wrong slot.

**One page call per frame; a plain run when there is nothing to visit.** `scanInPage` either returns a partial result, or, for the top frame only, a finished `axe.run` report when axe names no frame to visit. A child frame's result cannot stand alone, because `finishRun` needs it. `axe.run` builds node selectors only for the nodes it reports, whereas `runPartial` serializes every node it touched, so the plain run is cheaper. A document that Playwright reports as having no child frames skips `getFrameContexts`, which would rebuild axe's whole flattened tree just to find none.

**Payloads cross the protocol as JSON strings.** A string is about twice as fast as Playwright's structured serialization at partial-result sizes. A partial result stays a string until `finishFrameTree` parses it, because `finishRun` writes frame specs into its input. Each call therefore gets fresh objects, and no defensive deep copy is needed (that copy measured about 10 ms per frame).

**`finishRun`'s positional contract lives only in `axeFrameTree.ts`.** `finishRun` takes a flat array: each frame's partial, then its descendants depth-first, then its next sibling; a `null` for a frame that could not run, and nothing for that frame's descendants. A mistake does not fail. It attributes one frame's findings to another frame's selectors.

The walk builds a tree instead:
- an unscanned frame has no children by type;
- `scannedFrame` refuses a frame whose recorded child outcomes differ in number from the child frames axe selected (`partial.frames`).

**Budgets per frame.** Each limit is chosen to match `axe.run` or to bound a short call:

| Step | Limit | Basis |
|---|---|---|
| A child frame's own `runPartial` | 60 s | axe's default `frameWaitTime` |
| Injecting axe, resolving a child's element, reading an iframe element | 1 s | short single call |
| Liveness probe | 500 ms | axe's default `pingWaitTime` |

A descendant that hangs costs only itself; its parent and siblings keep their findings. The probe exists because a `sandbox` without `allow-scripts` accepts injected code but never fires timers, so `runPartial` would never settle there. Replacing this timing heuristic is tracked in #365.

**Handles are released as soon as they are read.** Every array slot returned by `getProperties()` is its own handle, and Playwright keeps a handle's value until it is disposed. Every slot except the iframe elements passed on to the walk is disposed after reading, including on failure. Otherwise each scan would pin its result strings, megabytes on large pages, for the life of the tab.

**Frames in closed shadow roots are checked separately.** Axe cannot see into a closed shadow root, so a frame there is skipped without axe ever deciding to skip it. After a frame is scanned, the server reads the iframe element of each child frame axe did not visit. It lists one as unscanned when all of these hold:

- it sits in a closed shadow root, judged on the *tree path* (parents, then shadow hosts), which decides whether axe could see it;
- the browser renders it (`checkVisibility()`). The browser's answer is final: a `<summary>` slotted into a closed `<details>` through a `<slot>` is not the details' own summary, so it stays collapsed even though the light DOM suggests otherwise;
- no ancestor on the *composed path* (which also follows slot assignment, as assistive technology does) is `aria-hidden="true"` or `inert`;
- it is not outside an open modal dialog. A modal makes everything outside it inert with no attribute, so modals are searched in the document, every open shadow root, and the closed roots on the frame's own path;
- for top-level frames, it lies inside `includeSelectors` and outside `excludeSelectors`. These are resolved with `document.querySelectorAll` in the top document, exactly as the scan resolves them, so a selector that matches only inside a shadow root scopes nothing. Inside a frame axe already scanned, everything is in scope.

A frame whose element cannot be read is not listed. Most unvisited frames are ones axe skipped on purpose, and an unreadable element usually means the frame detached mid-scan. Guessing would turn every detached frame into a false alarm.

**Tests use fake frames, the real `finishRun`, and real browsers.**
- **Fakes:** the unit fakes answer the protocol calls a frame receives. `finishRun` and the frame-tree flattening are never mocked.
- **Reference test:** a real-browser test compares the result with the replaced integration (`axe.run` plus `allowedOrigins`) on a nested frame tree. It includes `heading-order`, whose after-check only works once every frame's results are merged.
- **Path test:** a frame-free page and the same page with an empty, titled frame must report the same findings. The empty frame forces the `runPartial` and `finishRun` path.
- **Pinning:** axe-core is pinned exactly, because the rule catalogue, the injected source and the Node-side `finishRun` must be the same build.

## Alternatives

- **Keep `axe.run` and re-implement frame selection.** Rejected: the guess drifted from axe and reported sandboxed frames as scanned.
- **`axe.frameMessenger` over a Playwright bridge.** Rejected: it still routes results through each frame's `window`, and needs a messenger in every frame.
- **Run `finishRun` in a blank page,** as `@axe-core/playwright` does. Rejected: opening a page in the user's browser context creates a tab the server tracks, and Node needs no browser at all.
- **`structuredClone` partial results before `finishRun`.** Rejected: it costs about 10 ms per frame; keeping strings achieves the same with no copy.
- **Configure branding once.** Not possible while two code paths build reports; tracked in #366.

## Verification

`tests/tools-axe.test.ts` and `tests/tools-axeFrameTree.test.ts` cover the cases above. Deliberately breaking the depth-first order, or dropping a failed child in the walk, fails 4 and 18 tests respectively. The benchmarks and the end-to-end MCP run are recorded on #361.
