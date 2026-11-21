# ADR-006. Respect the boundaries of Playwright adapters

Accepted on 2026-11-21 for the existing configuration, extension, recorder and evaluation paths.

| Boundary | Decision and consequence |
| --- | --- |
| Client-certificate proxy | Playwright's certificate interceptor matches domain suffixes against a lowercased hostname. Normalize bypass entries to lowercase and reject unsupported browser-specific syntax before launch. Silently accepting those patterns could send traffic through a proxy the caller intended to bypass. |
| Extension tab discovery | Forget a debugger-detached tab until the extension announces its availability again. Retaining it as an attach candidate would let auto-attach race the extension's ownership transition. |
| Input recording | Share one programmatic recording per client connection. Playwright starts it in recording mode with call tracking omitted and rejects a second recording on the same connection. |
| Evaluation results | Use JSON for values it can faithfully represent. Non-finite numbers and negative zero lose their meaning, some JS values disappear, and bigints and cycles can throw. Track ancestors along the current path so repeated sibling references can still render as JSON. Use inspection for the other values. |

The configuration, extension protocol, recorder and evaluation tests pin these observable behaviors.
