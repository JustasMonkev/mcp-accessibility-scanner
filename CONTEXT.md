# Accessibility scanning and browser automation

The server exposes browser automation and accessibility audits through MCP.
Browser state, measured accessibility facts and page-provided actions have distinct ownership.

## Language

**Browser provider**: A connection mode that supplies a browser context, such as a launched browser, CDP attachment, extension or VS Code connection.

**Browser context**: The Playwright browsing environment containing tabs, cookies and storage, which may be server-owned or externally shared.

**Browser session**: A server-scoped browsing lifetime, either the default session or an explicit session selected by an opaque handle.
_Avoid_: MCP session when referring to browser state.

**Tab**: A page tracked within a browser session for browser actions and accessibility audits.

**Screen-reader measurement**: DOM facts gathered for accessibility-tree elements, including accessible names, geometry and whether the elements are reachable by a screen reader.

**Frame coverage**: The set of frames actually evaluated by an accessibility scan, with omitted frames recorded separately from findings.

**Page-registered tool**: A WebMCP action supplied by a live page registration and identified within its browser session, frame and document.

## Relationships

- A **Browser provider** supplies **Browser contexts**; an attached context can outlive the server's connection to it.
- An explicit **Browser session** owns a separate **Browser context**; modes that only share an external context reject explicit sessions.
- A **Browser session** contains **Tabs** and outlives individual stateless MCP requests.
- **Screen-reader measurement** produces facts for a **Tab**; unresolved elements and unmeasured names are not evidence of a clean audit.
- A **Page-registered tool** belongs to one live document and registration; browser-session routing is outside its page-owned arguments.

## Example dialogue

> **Dev:** Does closing an MCP request close its explicit browser session?
> **Maintainer:** No. The browser session is host-scoped; the request releases its use of that session, while an explicit close or idle expiry ends it.

## Flagged ambiguities

- Browser-context ownership is not connection ownership: disconnecting CDP must not close an external shared context.
- A measurement timeout stops waiting, not renderer work; late work still owns its slot and element handles until it settles.
