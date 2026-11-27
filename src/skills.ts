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

import path from 'node:path';

import { loadSkills } from '@modelcontextprotocol/server/ext/skills/node';

import type { SkillCatalog } from '@modelcontextprotocol/server/ext/skills';

// Agent Skills shipped with the package and served over MCP (the
// `io.modelcontextprotocol/skills` extension, SEP-2640). The folder sits at the
// package root, next to `lib/`, so the same path works from source and build.
const bundledSkillsRoot = path.join(import.meta.dirname, '..', 'skills');

let bundledSkills: Promise<SkillCatalog> | undefined;

// Loaded once per process: a catalog holds metadata only and serves any number
// of servers. `strict` turns a malformed bundled skill into a startup error
// instead of a warning that silently drops the skill from `skills/list`.
export function loadBundledSkills(): Promise<SkillCatalog> {
  if (!bundledSkills) {
    bundledSkills = loadSkills(bundledSkillsRoot, { strict: true });
    bundledSkills.catch(() => { bundledSkills = undefined; });
  }
  return bundledSkills;
}
