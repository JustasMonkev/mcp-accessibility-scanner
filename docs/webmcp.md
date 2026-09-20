# Page-registered WebMCP tools

This integration follows [Playwright #42671](https://github.com/microsoft/playwright/pull/42671) ([upstream implementation](https://github.com/microsoft/playwright/commit/78ff426)), adapted for the scanner's independent tool registry and explicit browser sessions. It lets an agent prepare application state before an accessibility audit; it does not replace the audit itself.

## Discovery and scope

After navigating to a page, request MCP `tools/list`. A supported `document.modelContext` or `navigator.modelContext` API contributes dynamic tools alongside the built-in tools. The server does not install a polyfill, enable browser flags, launch a browser solely to list tools, or upgrade Playwright.

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

In that example, `42` and `"page-owned argument"` are passed unchanged to the page. They never select a server session. Discovery does not enumerate session handles, and an unknown handle does not fall back to the default session. Explicit-session identities survive new per-request backends while their shared registry context remains alive.

## Notifications and caching

A stateful backend observes the scope of its last completed `tools/list` request. It checks again one second after a completed refresh and after tool calls, coalesces overlapping reads, and emits `notifications/tools/list_changed` only when the advertised descriptors change. This includes page registrations made between MCP calls. Notifications are hints to re-list, not tool definitions themselves.

A stateless response does not retain an observer. Shared stateless provider clients have no persistent notification recipient. Browser and proxy backends do not inherit a factory's old one-hour cache hint; clients should re-list using the conservative zero-TTL result. Both the direct and VS Code proxies forward listing metadata and cancellation. Explicit sessions remain host-routed after VS Code provider switches, while page arguments cannot change the destination. Owned stateful clients forward list-change notifications.

## Trust and bounds

Page names, schemas, descriptions, titles, results and thrown errors remain untrusted. The server advertises page tools with `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false` and `openWorldHint: true`, regardless of page claims. Registration is not permission to perform a consequential action.

Discovery considers at most 32 frames through the existing four-worker pool, with a five-second overall deadline. It returns at most 128 tools, caps each schema at 16 KiB, each description at 2,048 characters and each title at 256 characters. Malformed, oversized, unsupported, detached or timed-out registrations are omitted. Therefore an empty or partial listing is not a completeness claim about the page. Large data-URL payloads in frame labels and descriptions are shortened.

Invocation checks the active tab, live frame/document and registration descriptor again before executing. Arguments and results are limited to 256 KiB. Waiting is bounded by the tab's operation timeout and the MCP request's cancellation signal. Timers and cancellation listeners are removed on completion. A timeout or cancellation only stops the server waiting: a started page action may still finish and is never retried automatically. Modal-blocked calls fail rather than reporting a successful no-op.

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

The browser fixture verifies real Playwright evaluation/serialization, frame isolation, navigation invalidation, timeout and cancellation using a deterministic page-provided API fixture. It does **not** establish native WebMCP conformance across browser versions. That requires separately exercising native registrations on the supported browser builds.
