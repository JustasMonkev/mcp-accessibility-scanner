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
        'src/tools/files.ts',
        'src/tools/form.ts',
        'src/tools/install.ts',
        'src/tools/keyboard.ts',
        'src/tools/pdf.ts',
        'src/tools/wait.ts',
        'src/utils/codegen.ts', // Code generation utilities
        'src/utils/package.ts', // Simple package.json wrapper
      ],
      include: ['src/**/*.ts'],
      all: true,
      // These MUST stay nested under `thresholds`. Vitest only reads them
      // here; sitting directly on `coverage` they are silently ignored, which
      // is how a declared 90% gate ran for a long time against real coverage
      // in the 69-80% band without ever failing a build.
      //
      // The numbers are a ratchet set just under the measured values, not an
      // aspiration: raise them as coverage improves. They are deliberately
      // lower than the old inert 90 because they are now enforced — an
      // enforced 80 stops regressions that an ignored 90 never could.
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
