# ADR-007. Keep output optimizations faithful to their inputs

Accepted on 2026-11-21 for the existing scanner utilities.

| Operation | Constraint and trade-off |
| --- | --- |
| ARIA snapshot compression | Count possible siblings under the same parent before parsing every line. The indentation precheck must agree with the full parser, including tabs and Unicode whitespace. Protect ancestors of interactive subtrees even when surrounding siblings repeat. |
| Data URL truncation | Raw payloads can contain markup with characters that look like delimiters. Base64 has a fixed alphabet and unconditional end markers, so the common alphabet run can be skipped in one pass while retaining the separate raw-payload boundary checks. |
| UTF-8 byte limits | A JavaScript string's code-unit length bounds the prefix worth encoding. Use the encoder's consumed-unit and written-byte counts for multibyte characters and lone surrogates. Equal counts allow an ASCII copy. A retained download error can outlive a much larger input, so detach the prefix and preserve its original UTF-16 code units. |
| Timestamp filenames | For a 24-character ISO timestamp only colons need replacing. Expanded years still need the general filename sanitizer. |
| Random identifiers | Batch cryptographic random bytes to amortize allocations and generator calls. Each identifier consumes a fresh slice, and the buffer is refilled before a slice would overrun it. |
| Representative URL selection | Sort query entries stably by code unit without writing them back through the URL serializer. Retain the solver's choices so reconstruction walks the selected branches without paying for a second merge. |

Regression coverage includes `tests/utils.test.ts` and `tests/representativeUrls.test.ts`.
