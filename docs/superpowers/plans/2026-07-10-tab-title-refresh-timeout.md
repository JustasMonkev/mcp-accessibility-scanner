# Tab Title Refresh Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure an unresponsive CDP tab cannot delay tab-title refreshes for longer than five seconds, even when the configured Playwright timeout is higher.

**Architecture:** Reuse `Tab._withPageStateTimeout()` with an explicit timeout override for `Tab.updateTitle()`. Preserve the existing configured timeout everywhere else so snapshot behavior and public configuration remain unchanged.

**Tech Stack:** TypeScript, Playwright 1.61.0, Vitest 4.1.7

---

### Task 1: Cap tab-title refreshes

**Files:**
- Modify: `tests/tab.test.ts:149`
- Modify: `src/tab.ts:149`

- [x] **Step 1: Write the failing regression test**

Add this test inside the existing `describe('updateTitle')` block:

```ts
it('caps unresponsive title refreshes at five seconds', async () => {
  vi.useFakeTimers();
  mockContext.config.timeouts.defaultTimeout = 30_000;
  mockPage.title = vi.fn().mockReturnValue(new Promise(() => {}));
  const tab = new Tab(mockContext, mockPage as any, onPageClose);
  let finished = false;

  const updatePromise = tab.updateTitle().then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(4_999);
  expect(finished).toBe(false);

  await vi.advanceTimersByTimeAsync(1);
  await updatePromise;

  expect(finished).toBe(true);
  expect(tab.lastTitle()).toBe('about:blank');
});
```

- [x] **Step 2: Run the test and verify it fails**

Run:

```bash
npm test -- tests/tab.test.ts -t "caps unresponsive title refreshes at five seconds"
```

Expected: FAIL because `updateTitle()` still waits for the configured 30-second timeout.

- [x] **Step 3: Implement the minimal timeout override**

Update `Tab.updateTitle()` to cap only title refreshes:

```ts
this._lastTitle = await this._withPageStateTimeout(
    callOnPageNoTrace(this.page, page => page.title()),
    'reading page title',
    Math.min(this._pageStateTimeoutMs(), 5000),
);
```

Update the helper to accept the resolved timeout:

```ts
private async _withPageStateTimeout<T>(
  promise: Promise<T>,
  description: string,
  timeoutMs = this._pageStateTimeoutMs(),
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms while ${description}.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId)
      clearTimeout(timeoutId);
  }
}
```

- [x] **Step 4: Run focused tests and verify they pass**

Run:

```bash
npm test -- tests/tab.test.ts tests/response.test.ts
```

Expected: both files pass, including the new five-second cap and existing shorter-timeout coverage.

- [x] **Step 5: Commit the focused implementation**

```bash
git add src/tab.ts tests/tab.test.ts docs/superpowers/plans/2026-07-10-tab-title-refresh-timeout.md
git commit -m "fix: cap tab title refresh timeout"
```

### Task 2: Validate and publish

**Files:**
- Verify: `src/tab.ts`
- Verify: `tests/tab.test.ts`

- [ ] **Step 1: Run repository validation**

Run:

```bash
npm run lint
npm run build
npm test
git diff --check origin/main...HEAD
```

Expected: every command exits successfully.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin agent/cap-tab-title-refresh-timeout
```

Expected: the branch is created on `origin` and configured for tracking.

- [ ] **Step 3: Open the draft pull request**

Open a draft PR against `main` titled `fix: cap unresponsive tab title refreshes`. The body must link https://github.com/microsoft/playwright/pull/41733, summarize the upstream discarded-tab hang, explain the local configured-timeout gap, and list the validation commands.
