/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// Structural test: every published tool is documented. Between July 2025 and June 2026, 11 to 30 tools on main
// were missing from README.md until a documentation audit (PR #97) caught it by hand.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allTools } from '../src/tools.js';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

describe('README tool documentation', () => {
  it('names every registered tool in backticks', () => {
    const names = [...allTools.map(tool => tool.schema.name), 'browser_connect'];
    const undocumented = names.filter(name => !readme.includes(`\`${name}\``));
    expect(undocumented, 'Document these tools in README.md, or remove them from src/tools.ts').toEqual([]);
  });
});
