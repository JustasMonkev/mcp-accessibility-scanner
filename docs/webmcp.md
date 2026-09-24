# Page-registered WebMCP tools

This integration follows [Playwright #42671](https://github.com/microsoft/playwright/pull/42671) ([upstream implementation](https://github.com/microsoft/playwright/commit/78ff426)), adapted for the scanner's independent tool registry and explicit browser sessions. It lets an agent prepare application state before an accessibility audit; it does not replace the audit itself.

## Discovery and scope

After navigating to a page, request MCP `tools/list`. A supported `document.modelContext` or `navigator.modelContext` API contributes dynamic tools alongside the built-in tools. The server does not install a polyfill, enable browser flags, launch a standalone browser solely to list tools, or upgrade Playwright. Stateless extension and non-isolated CDP requests reconnect to their configured shared browser when listing or calling page tools. Cancelling such a request releases it at once; an attachment still in progress never opens a page for it afterwards and is released with the request's browser context.

Names have the shape `webmcp_<sanitized name>_<identity hash>` and are at most 64 characters. Use the returned name verbatim. The identity is stable across enumeration changes within one browser-session scope and live frame/document, but changes with navigation or registration metadata/schema changes. Identical names in different frames or sessions cannot be substituted for one another. A stale or wrong-scope name fails before invocation.

The default session is selected when routing metadata is absent. For an explicit session, use the handle from `browser_session_open` in request metadata on **both** listing and invocation. The following are method parameters, not complete protocol envelopes; retain any other metadata required by the negotiated MCP revision.

`tools/list` parameters:

```json
{
  "_meta": { "browserSessionId": "bs_your_handle" }
}
```

`tools/call` parameters:

```json
{
  "name": "webmcp_exact_name_returned_by_tools_list",
  "_meta": { "browserSessionId": "bs_your_handle" },
  "arguments": { "browserSessionId": 42, "_meta": "page-owned argument" }
}
```

In that example, `42` and `"page-owned argument"` are passed unchanged to the page. They never select a server session. With `--save-session`, such a call records its handle in a separate `Metadata` block of `session.md`, so the logged arguments stay exactly as the page received them. Discovery does not enumerate session handles, and an unknown handle does not fall back to the default session. Explicit-session identities survive new per-request backends while their shared registry context remains alive. Stateless shared-browser defaults use a factory-scoped identity and a document-local marker, so reconnecting Playwright wrappers preserves names until the document or registration changes.

## Notifications and caching

A stateful backend observes the scope of its last completed `tools/list` request. It checks again one second after a completed refresh and after tool calls, coalesces overlapping reads, and emits `notifications/tools/list_changed` only when the advertised descriptors change. This includes page registrations made between MCP calls. A frame evaluation that exceeds the discovery deadline is not reissued until the original protocol request settles, preventing hung pages from accumulating pending browser requests. Notifications are hints to re-list, not tool definitions themselves.

A stateless response does not retain an observer. Shared stateless provider clients have no persistent notification recipient. Browser and proxy backends do not inherit a factory's old one-hour cache hint; clients should re-list using the conservative zero-TTL result. Both the direct and VS Code proxies forward listing metadata and cancellation. Explicit sessions remain host-routed after VS Code provider switches, while page arguments cannot change the destination. Owned stateful clients forward list-change notifications.

## Trust and bounds

Page names, schemas, descriptions, titles, results and thrown errors remain untrusted. The server advertises page tools with `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false` and `openWorldHint: true`, regardless of page claims. Registration is not permission to perform a consequential action.

Discovery considers at most 32 frames through the existing four-worker pool, with a five-second overall deadline. The 128-tool budget is divided across the enumerated frames before browser serialization (unused per-frame slots are not redistributed). This also bounds the aggregate registrations transferred during each refresh, rather than merely truncating the final list. It caps each schema at 16 KiB, each description at 2,048 characters and each title at 256 characters. Descriptors are checked with the MCP SDK’s tool schema before publication, so malformed `required` or `properties` fields cannot invalidate the complete tool list. Each input schema is also walked at every subschema location, following local `#/…` `$ref` targets, and compiled with the validator that later checks call arguments, so a malformed nested schema is omitted instead of being advertised as an unusable tool. `pattern` and `patternProperties` are rejected wherever they define a subschema, because the server would run the page's regular expressions; the same words inside annotation data such as `default` or `examples` are accepted. Non-local `$ref`s, `$dynamicRef`, `$recursiveRef` and nested `$id`s are unsupported. A page can replace any global that code running inside it uses, so in-page checks only spare the discovery budget and transfer: each frame returns one length-bounded string, discovery failures stay in the page, and the server repeats every check on what arrives. Malformed, oversized, unsupported, detached or timed-out registrations are omitted. Therefore an empty or partial listing is not a completeness claim about the page. Large data-URL payloads in frame labels and descriptions are shortened.

Invocation checks the active tab, live frame/document and registration descriptor again before executing. Arguments and results are limited to 256 KiB, and page errors to 2 KiB of UTF-8. The page measures results and errors with operations it cannot override before they cross the browser connection, and the server checks results again. Waiting is bounded by the tab's operation timeout and the MCP request's cancellation signal. Timers and cancellation listeners are removed on completion. A timeout or cancellation only stops the server waiting: a started page action may still finish and is never retried automatically. Modal-blocked calls fail rather than reporting a successful no-op.

## Verification

With the repository's dependencies installed:

```bash
npm test -- tests/webmcp.test.ts tests/webmcp-backend.test.ts tests/webmcp-proxy.test.ts
npm run lint
npm run build
```

For the browser-boundary fixture, install the pinned Chromium build, then run:

```bash
npx playwright install chromium
WEBMCP_BROWSER_TEST=1 npm test -- tests/webmcp-browser.test.ts
```

`WEBMCP_BROWSER_EXECUTABLE_PATH` can select an already-provisioned Chromium executable. `WEBMCP_BROWSER_NO_SANDBOX=1` is only for an isolated test container that requires it; it is not a recommended production browser setting.

The browser suite includes a deterministic API fixture for timeout/cancellation and a native Chromium test using `document.modelContext.registerTool`. The native case runs through the real MCP SDK and browser backend, verifying discovery, invocation, same-name frame isolation and stale-name rejection. It explicitly enables Chromium’s `WebMCP` feature for the test; production launch flags remain user-controlled. Other browser versions and Firefox are not covered by this native test.
