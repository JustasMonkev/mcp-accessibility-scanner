# Checks automation cannot make

Axe, together with this server's heuristic audits, gives evidence for only some WCAG success criteria. List the criteria below under "Not covered" in a report, unless you checked them by other means, and say how you checked them.

## Perceivable

- **1.1.1 Non-text content**: whether alt text is *accurate and meaningful*. Axe checks only that it is present. Decorative images should have empty alt text.
- **1.2.x Time-based media**: whether captions, audio description and transcripts exist and are accurate.
- **1.3.1 Info and relationships**: whether the heading structure matches how the content is organized visually, and whether data tables have the right headers.
- **1.3.3 Sensory characteristics**: instructions that depend only on shape, position or sound ("click the round button on the right").
- **1.4.1 Use of color**: whether information is shown by color alone (required fields, chart series, link text inside body text).
- **1.4.5 Images of text**: text that is part of an image.
- **1.4.10 Reflow**: whether the page works at 320 CSS px wide with no horizontal scrolling. The `zoom-200` and `mobile` variants of `scan_page_matrix` only approximate this.
- **1.4.13 Content on hover or focus**: whether tooltips and popovers can be dismissed without moving focus, can be hovered over themselves, and stay visible until dismissed.

## Operable

- **2.1.1 Keyboard**: whether every piece of functionality works by keyboard. `audit_keyboard` checks reachability, and `audit_keyboard_operation` checks only the scenarios you script. Neither tool, nor Axe, flags a click handler on an element that cannot take focus, such as `<div onclick>` posing as a button. Look in `browser_snapshot` for controls that look clickable but are missing from the tab order.
- **2.2.x Enough time**: session timeouts, and whether moving, auto-updating or carousel content can be paused, stopped or hidden.
- **2.3.1 Three flashes**: content that flashes.
- **2.4.4 / 2.4.9 Link purpose**: whether link text makes sense in its context or on its own.
- **2.4.5 Multiple ways**: whether pages can be found in more than one way (navigation, search, sitemap).
- **2.4.6 Headings and labels**: whether headings and labels *describe* their content. `audit_screen_reader` flags only generic names.
- **2.5.1 / 2.5.2 Pointer gestures and pointer cancellation**: multipoint or path-based gestures that have no single-pointer alternative.
- **2.5.7 Dragging movements**: whether every drag action has a single-pointer alternative.

## Understandable

- **3.1.2 Language of parts**: passages in a different language that are not marked with `lang`.
- **3.2.x Predictable**: changes of context on focus or input, and whether navigation and naming stay consistent across pages.
- **3.3.3 Error suggestion / 3.3.4 Error prevention**: whether error messages say how to fix the error, and whether legal or financial submissions can be reviewed, confirmed or undone. Use `audit_form_validation` for evidence.
- **3.3.7 Redundant entry / 3.3.8 Accessible authentication**: whether users must re-enter information, and whether sign-in relies on a cognitive test.

## Robust

- **4.1.3 Status messages**: whether status updates are actually announced. `audit_form_validation` checks whether a live region is present, but not whether a screen reader announces it.

## Assistive technology

No automated tool can stand in for a session with a real screen reader (NVDA, JAWS, VoiceOver or TalkBack) or with speech input. For critical flows, recommend a manual pass with assistive technology.
