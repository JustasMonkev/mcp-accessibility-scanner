# ADR-003: Concentrate browser and audit lifetimes

## Status

Accepted for the local architecture refactor on October 2, 2026.

## Context

Browser factories duplicate shared-connection ownership rules, the screen-reader
audit handler manages renderer work alongside report production, and both proxy
adapters coordinate downstream discovery and invocation independently. These
lifetimes are necessary, but callers should not reconstruct their ordering rules.

## Decision

- Concentrate shared-browser acquisition and release in the existing factory
  module. Keep provider-specific context creation and context ownership distinct.
- Put the complete screen-reader measurement lifecycle behind an audit-oriented
  module. The audit handler consumes measured facts and explicit limitations;
  scheduling and delayed handle cleanup belong to measurement.
- Share downstream tool forwarding and discovery-notification ordering between
  direct and VS Code proxy adapters. Provider selection and host-owned browser
  session routing stay with the adapters.

These changes do not alter published tool names, accepted configuration, report
formats or dependency versions. The [domain language](../../CONTEXT.md) separates
browser sessions from MCP requests and context ownership from connection ownership.

## Constraints

- Pending acquisitions and live holders both protect a shared browser. Old
  disconnects and failed acquisitions must not evict a successor connection.
- Closing a connection must not close an externally owned CDP context. Owned
  context cleanup must finish before the last holder disconnects the browser.
- A measurement timeout ends the wait, not renderer work. Late work retains its
  page-scoped slot and handles until settlement; overlapping audits share the limit.
- Unresolved elements, unmeasured names and omitted frames remain distinct from
  clean results. Screen-reader scheduling is not interchangeable with Axe scan
  scheduling.
- Discovery responses precede buffered catalog-change notifications. Obsolete
  clients and closed requests do not receive notifications.
- [ADR-001](001-webmcp-adoption.md) and [ADR-002](002-tool-filtering.md) remain in
  force: page-owned arguments are untouched, explicit sessions are host-routed,
  uncertain invocations are not retried, and both proxies enforce tool blocking.

## Alternatives

Keeping duplicated lifetime rules requires each adapter and its tests to encode
the same races. A generic lifetime or audit framework would expose unrelated
policies through more configuration. Both are rejected in favor of domain-focused
modules with real callers and behavioral tests.

## Verification

Retain provider, audit-tool and MCP transport regressions. Add focused behavior
checks at the deepened interfaces and use targeted fault injection to establish
that concurrency, cleanup and routing assertions detect regressions.
