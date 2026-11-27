---
name: accessibility-audit
description: Run a WCAG accessibility audit of a web page, user flow, or whole site with this server's Axe and Playwright tools, then report the findings by severity with fixes. Use when asked to check, audit, scan, or test a site or page for accessibility, WCAG 2.x / Section 508 conformance, keyboard or screen reader support, color contrast, focus order, text spacing, reflow or zoom, or accessible forms.
---

# Accessibility audit

This skill is a plan for auditing with this MCP server's tools. Each tool's schema lists its full parameters. Some tools may be disabled by the server's tool policy, so use only the tools that are in the tool list.

Automated checks find only part of the WCAG problems on a page. Report what the tools found, and say which criteria were not checked. Do not report a page as "accessible" or "WCAG compliant" just because a scan came back clean.

## 1. Set the scope first

Before you run anything, settle these. Ask the user only when the request does not answer them.

- **Target**: one page, one flow (sign in, checkout, a form), or a site crawl.
- **Standard**: the default Axe tags cover WCAG 2.0, 2.1 and 2.2 at A, AA and AAA, plus Section 508. Most requests mean WCAG 2.2 AA. To report against that, pass `violationsTag: ["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22a","wcag22aa"]`.
- **State**: pages behind a sign-in, a cookie banner or a modal need to be put into the right state with the browser tools before scanning.
- **Session**: on a stateless connection (MCP 2026-07-28 over HTTP, with no `initialize` session), each request runs in a fresh default browser, so a page you navigate to is gone by the next call. Call `browser_session_open` first and pass its `browserSessionId` to every browser tool call in the audit. If it is rejected (modes that share one live browser, such as `--extension` or CDP attach), keep using the default session, but `retainFindings` is unavailable there: rely on the inline findings and say in the report when a rule was cut off at `maxNodesPerViolation`. A stateful connection can use the default session as it is.

## 2. Single page

1. `browser_navigate` to the URL. Then call `browser_snapshot` to confirm the page is the one you meant to load (not an error page, a sign-in wall or a consent screen).
2. `scan_page`. This is the Axe scan, and its result is the core of the report.
   - Keep `includeIncomplete` on. "Incomplete" results are checks Axe could not decide, such as contrast over an image. Inspect each one yourself with `browser_snapshot` or `browser_take_screenshot` before you report it.
   - Use `excludeSelectors` for third-party widgets the user does not own, such as chat bubbles or ad iframes. Say in the report what you excluded.
   - Only `maxNodesPerViolation` nodes per rule (10 by default) are shown inline. When the report needs every affected node, set `retainFindings: true` on this first scan. Then page through `get_scan_findings` with the returned `scanId` (follow `nextOffset` until it is `null`). Retention cannot be switched on afterwards: if a scan without it was cut off, scan again with `retainFindings: true`.
   - Set `annotateScreenshot: true` when the user wants a visual. It costs a full-page screenshot.
3. `audit_keyboard` covers what Axe cannot: tab order, visible focus, focus traps, skip links, focus obscured (WCAG 2.4.11) and target size (WCAG 2.5.8).
4. `audit_screen_reader` checks accessible name quality and whether reading order matches the visual layout.
5. `audit_text_spacing` checks WCAG 1.4.12: whether text is clipped or overlaps under the required spacing overrides.
6. When responsive or user-preference behavior matters, run `scan_page_matrix`. Its variants cover mobile, desktop, forced colors, reduced motion and 200% zoom, each compared with the baseline.

## 3. User flows and interactive states

Many problems appear only after an interaction: opened menus, dialogs, error states, or content loaded later.

- Drive the page into the state with `browser_click`, `browser_type`, `browser_fill_form`, `browser_press_key` and `browser_select_option`. Then run `scan_page` again.
- Use `audit_form_validation` to submit invalid values and check that errors are shown, linked to their fields and announced. It changes the page and may submit the form, so use it only on test data, or when the user agrees.
- Use `audit_keyboard_operation` to check that a widget works by keyboard. Script the keys (open a menu with Enter, move with the arrow keys, close with Escape) and state the focus, visibility or state you expect after each one. It does not restore the page's state.

## 4. Whole site

Use `audit_site` instead of calling `scan_page` once per URL.

- `strategy: "sitemap"` with `pageSelection: "representative"` gives broad coverage of a large site with few pages: it picks one page per URL template.
- `strategy: "links"` crawls from `startUrl` up to `maxDepth`. `strategy: "provided"` scans the exact `urls` you give it.
- Keep `maxPages` small (the default is 25) unless the user asks for more, and leave `excludePathPatterns` excluding logout links.
- Group site-wide results by rule. When one rule fails on every page, it usually comes from a shared template or component, so it needs one fix, not one per page.

## 5. Write the report

Lead with what matters most to users, not with the raw tool output.

1. **Summary**: what was tested (URLs, states, viewports), against which standard, and with which tools. Give counts by impact level.
2. **Findings**, most severe first (`critical`, `serious`, `moderate`, `minor`). For each finding, give:
   - the Axe rule id and the WCAG success criterion;
   - who is affected and how, for example "screen reader users hear 'button' with no name";
   - where it occurs: a selector or a snapshot ref, and how many nodes;
   - a concrete fix, ideally as a corrected HTML snippet;
   - the remediation link the tool returned.
3. **Needs manual review**: every incomplete result you could not resolve, and the heuristic findings from the keyboard, screen reader and text spacing audits that need a person to confirm them.
4. **Not covered**: list the criteria automation cannot check. See [references/manual-checks.md](references/manual-checks.md).

Combine duplicates: one finding per rule per component, with every place it occurs listed under it. Never invent a finding the tools did not produce. Label anything you only judged by eye as a reviewer observation.

## 6. Finish

- Close extra sessions opened with `browser_session_open` by calling `browser_session_close`.
- When the user asked for files, give them the paths of the report files the tools wrote (`reportFile`, screenshots).
