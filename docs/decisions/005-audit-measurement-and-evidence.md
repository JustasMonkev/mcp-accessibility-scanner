# ADR-005. Preserve what each audit actually measured

Accepted on 2026-11-21 for the existing text-spacing, form-validation and crawl implementations.

## Text spacing

Playwright serializes functions passed into a frame. Keep measurement, stylesheet installation and cleanup independently executable in the page. Pass the override values as data. Apply the four WCAG 1.4.12 settings in a named cascade layer so important declarations can override unlayered important author styles. Check the computed result, including paragraph margins on paragraphs whose text is entirely inside child elements.

A second audit of the same page could take its baseline while the first audit's overrides are active. Hold a per-page lock through measurement, screenshot and cleanup. Bound waits because background tabs throttle animation frames and an unresponsive child can prevent restoration. A layout read forces layout once the frame responds. Attempt cleanup even after an evaluation times out. Only publish a styled screenshot when reapplication succeeds across the measured frames. Preserve completed measurements when capture fails.

## What counts as text loss

Compare before and after geometry using a fresh style and clipping cache in each phase. Scrollable content can remain reachable while being invisible outside the scrollport. Use reachable line area for loss and painted line boxes for overlap. Cap the per-element line sample only for overlap. To report new clipping, require both a two-percentage-point increase in hidden area fraction and an area increase of at least one quarter of the squared font size.

Walk the containing-block chain for positioned text. An absolutely positioned descendant can escape an intervening overflow ancestor. Account for paint containment, including that implied by content visibility, and viewport-propagated root/body overflow. Skip boxless and inapplicable inline or table boxes as clippers. For display-contents text, test the owner's inherited visibility and check the rendering ancestor separately because descendants can restore visibility. Prefer CSS Typed OM when suggesting a fix. It preserves an author’s `auto` sizing, which a pixel reading from `getComputedStyle` can conceal.

## Evidence across DOM changes

The form-validation audit can observe a feedback element for the first time after submission. Capture the baseline live-region owners by DOM identity when the target is absent. That lets the later read distinguish an established announcement region from a newly inserted one.

During a crawl an outgoing document can open a dialog before navigation commits, while a queued cookie check later observes the new URL. Attribute that session check to the pre-navigation URL. This keeps reported session loss associated with the document that raised the dialog.

Relevant regressions live in `tests/tools-auditTextSpacing.test.ts`, `tests/tools-auditFormValidation.test.ts` and `tests/tools-auditSite.test.ts`.
