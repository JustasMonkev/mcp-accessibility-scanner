# ADR-008. Collect each test suite once

Accepted on 2026-11-21 for the existing test discovery configuration.

Agent worktrees can live inside a checkout and carry full copies of its tests. Vitest excludes both current and legacy worktree locations so a run exercises the active checkout once. The standalone check scripts use Node's test runner and run through `npm run test:scripts`. Vitest excludes their directory to keep the two discovery paths independent.
