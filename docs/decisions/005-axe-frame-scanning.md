# ADR-005: Scan frames with axe runPartial and finishRun

## Status

Accepted for #361, 2026-11-21. Replaces the `axe.run` and frame-messaging integration in `src/tools/axe.ts`. The rationale here used to sit in code comments, which a lint ratchet now bans in the affected files.

## Context

`axe.run` reaches child frames over `postMessage`. That required every injected copy to accept messages from any origin (`allowedOrigins: ['<unsafe_all_origins>']`). It also skips frames that do not answer its ping without saying so. About 260 lines re-implemented axe's frame selection to guess which frames had been skipped, and the guess missed sandboxed frames. Re-injecting on every scan also stacked message listeners, so each repeat scan of a tab was slower than the last.

## Decisions

**Axe chooses the frames, Playwright drives them, Node merges.** In each document, `axe.utils.getFrameContexts` returns the child frames axe would scan, with the context for each. That applies axe's own scope, visibility and shadow-DOM rules. The server runs `axe.runPartial` in each of those frames through Playwright and merges the results with `axe.finishRun` in Node. At most four frames do their own resolve, install and `runPartial` work at once across the whole scan, and the closed-shadow coverage reads (below) share the same four slots. A frame releases its slot before its descendants start, so a deep tree cannot deadlock.

`finishRun` needs no DOM. Running it in Node rather than in a page keeps findings from cross-origin frames away from third-party page script. The scan never chooses frames by walking Playwright's frame list. That list is consulted only to find frames axe could not see (below), and to find a child frame when Playwright's `contentFrame()` cannot resolve an element.

**A private axe global, installed without relying on `window.axe`.** The bundle runs with a local `module` (and an undefined `define`), so its instance is captured from `module.exports` rather than read back from `window.axe`. A page that locks `window.axe` (non-writable or getter-only) is therefore still scannable. `window.axe` is restored or deleted afterwards, and the instance is kept under `window.__mcpAccessibilityScannerAxe`. Each instance gets a no-op `frameMessenger`, which removes the `message` listener its load registered: neither `runPartial` nor a plain run with `iframes: false` uses frame messaging, and repeated scans would otherwise keep every earlier instance alive.

**Frame elements are captured at selection.** `getFrameContexts` identifies frames by positional selectors (`iframe:nth-child(2)`). The iframe elements are resolved in the same in-page task that selects them, and each child is reached through its own element handle. Resolving the selectors later could land on a different frame once an earlier sibling is removed, which would file that frame's findings under the wrong slot.

Two resolution steps are done by hand, because the library calls fail in XHTML documents:
- **Selector lookup.** axe's selector is an ancestry path (`html > body > iframe:nth-child(2)`) generated from the frame's document or shadow root. It is followed step by step from exactly that root, honouring `:nth-child` and comparing axe's lowercased qualified node name (`h:div`, `foreignobject`). `shadowSelect` is not used. It runs the path as CSS, which finds nothing when the case differs, and also accepts any matching suffix: an `html > body` nested in an SVG `foreignObject` earlier in the document would win, attributing one frame's findings to another.
- **Element to frame.** Playwright's `contentFrame()` recognises frames by an uppercase `nodeName`, which XHTML does not report. When it returns null, the child frame whose own element is the captured element is used.

A frame that is genuinely detached still resolves to nothing and is reported.

**One page call per frame; a plain run when there is nothing to visit.** `scanInPage` either returns a partial result, or, for the top frame only, a finished `axe.run` report when axe names no frame to visit. A child frame's result cannot stand alone, because `finishRun` needs it. `axe.run` builds node selectors only for the nodes it reports, whereas `runPartial` serializes every node it touched, so the plain run is cheaper.

The plain report is projected in the page to the fields the scanner returns, by the same `projectReport` that projects `finishRun`'s report in Node. Check details and the nodes of passing and inapplicable rules never cross the protocol: about a third of the payload on a page with 250 failing images.

Whether a document may contain frames is decided in the page, in the same task as frame selection, so the answer cannot go stale. `window.length` counts the frames in the document tree but not those in shadow trees, so open shadow roots are also searched for `iframe` and `frame` elements. Only when both find nothing does the scan skip `getFrameContexts`, which would rebuild axe's whole flattened tree just to find none. A frame count read from Node beforehand could miss a frame inserted before the page call. The top frame would then run with `iframes: false` and silently skip it, and a child's `runPartial` could find more frames than were recorded and fail the scan.

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

A descendant that hangs costs only itself; its parent and siblings keep their findings. The probe exists because a `sandbox` without `allow-scripts` accepts injected code but never fires timers, so `runPartial` would never settle there. It schedules a zero-delay timer that sets a per-probe token, then polls the token with short reads, each of which returns at once. Awaiting the timer inside one evaluation would leave a Playwright call pending forever in such a frame, one more on every scan of the tab. Replacing this timing heuristic is tracked in #365.

**Handles are released as soon as they are read.** Every array slot returned by `getProperties()` is its own handle, and Playwright keeps a handle's value until it is disposed. Every slot except the iframe elements passed on to the walk is disposed after reading, including on failure. Otherwise each scan would pin its result strings, megabytes on large pages, for the life of the tab.

**Frames in closed shadow roots are checked separately.** Axe cannot see into a closed shadow root, so a frame there is skipped without axe ever deciding to skip it. After a frame is scanned, the server reads the iframe element of each child frame axe did not visit. It lists one as unscanned when all of these hold:

- it sits in a closed shadow root, judged on the *tree path* (parents, then shadow hosts), which decides whether axe could see it;
- the browser renders it (`checkVisibility()`). The browser's answer is final: a `<summary>` slotted into a closed `<details>` through a `<slot>` is not the details' own summary, so it stays collapsed even though the light DOM suggests otherwise;
- no ancestor on the *composed path* (which also follows slot assignment, as assistive technology does) is `aria-hidden="true"`;
- no ancestor up to and including the nearest enclosing modal dialog is `inert`. A modal dialog escapes the inertness of its ancestors, so `inert` above it does not count;
- it is inside an open modal on its composed path, when modals are open. Every element outside the active modal is inert, with no attribute to show for it. With a single open modal that decides it. A pointer hit test is no evidence of keyboard reach: a slotted child is not a DOM descendant of its modal, and `pointer-events: none` hides a modal from hit testing while its content stays focusable.

  With several open modals, the frame's modal is ruled out only on positive evidence that another modal covers it, meaning a hit at its centre lands inside a different open modal or its backdrop. An inconclusive hit keeps the frame in scope. Modals are searched in the document, every open shadow root, and the closed roots on the frame's own path;
- for top-level frames, it is in scope by axe's own rule. The closest matching `includeSelectors` ancestor must be at least as close as the closest matching `excludeSelectors` ancestor, and include wins a tie. Selectors are resolved with `document.querySelectorAll` in the top document, exactly as the scan resolves them, so a selector that matches only inside a shadow root scopes nothing. Inside a frame axe already scanned, everything is in scope.

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
