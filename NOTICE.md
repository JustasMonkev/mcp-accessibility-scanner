# NOTICE

## mcp-accessibility-scanner

Copyright (c) 2024 Justas Monkev

This project is licensed under the MIT License.

## Third-Party Code Attribution

This project includes code adapted from:

### Microsoft Playwright MCP
- Copyright (c) Microsoft Corporation
- Licensed under the Apache License, Version 2.0
- Original source: https://github.com/microsoft/playwright-mcp

Adapted code has been modified to:
- Convert from ESM to CommonJS module format
- Integrate with axe-core accessibility scanning
- Work with existing Playwright instances rather than spawning new ones

### pi
- Copyright (c) 2025 Mario Zechner
- Licensed under the MIT License
- Original source: https://github.com/earendil-works/pi

`scripts/check-pinned-deps.mjs`, `scripts/check-runtime-deps.mjs`,
`scripts/check-lockfile-commit.mjs` and `scripts/sourceImports.mjs` are adapted
from pi's `scripts/` checks.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
