# Tab title refresh timeout design

## Context

Playwright upstream PR [microsoft/playwright#41733](https://github.com/microsoft/playwright/pull/41733) prevents one discarded or unresponsive CDP tab from blocking tab-header rendering while `page.title()` never resolves.

This repository already bounds page-state reads through `Tab._withPageStateTimeout()`, but `Tab.updateTitle()` currently uses the full configured default timeout. A user-configured timeout longer than five seconds can therefore delay every response that refreshes tab titles beyond the upstream cap.

## Design

- Allow `Tab._withPageStateTimeout()` to receive an optional timeout override.
- In `Tab.updateTitle()`, use the shorter of the current page-state timeout and five seconds.
- Preserve the existing configured timeout for `captureSnapshot()` and other page-state reads.
- Keep the current failure behavior: log the timeout and retain the last known tab title.

This reuses the existing timeout helper and introduces no new configuration, dependency, or public API.

## Validation

Add a focused unit test proving that an unresolved title read stops after five seconds even when the runtime default timeout is longer. Keep the existing tests proving that shorter configured timeouts and runtime timeout updates remain effective.

Run the focused tab and response tests first, followed by lint, build, the full test suite, and `git diff --check` before publishing.

## Documentation

No README update is needed because tool schemas, commands, configuration, and visible output remain unchanged.
