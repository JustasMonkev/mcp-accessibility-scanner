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
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Agent worktrees live under .claude/worktrees and carry their own copy of
    // tests/; without this they are collected alongside the real suite.
    exclude: [...configDefaults.exclude, '.claude/worktrees/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/**',
        'lib/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData/**',
        'tests/**',
        'src/extension/**', // Extension code typically needs browser context
        'src/vscode/**', // VSCode specific code
        'src/browserServerBackend.ts', // Complex backend initialization
        'src/program.ts', // CLI program entry point
        'src/index.ts', // Entry point
        'src/tools.ts', // Server initialization
        // Tools requiring complex Playwright mocking or integration tests
        'src/tools/install.ts',
        'src/tools/pdf.ts',
        'src/utils/codegen.ts', // Code generation utilities
        'src/utils/package.ts', // Simple package.json wrapper
      ],
      include: ['src/**/*.ts'],
      all: true,
      // Must stay nested under `thresholds` — Vitest ignores these silently
      // when they sit directly on `coverage`, which is how a declared 90% gate
      // never once failed a build. A ratchet just under the measured values,
      // not an aspiration: raise it as coverage improves.
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 80,
        lines: 80,
      },
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    maxWorkers: 6,
    fileParallelism: true
  },
});
