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
    exclude: [...configDefaults.exclude, '.codex/worktrees/**', '.claude/worktrees/**', 'scripts/**'],
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
        'src/extension/**',
        'src/vscode/**',
        'src/browserServerBackend.ts',
        'src/program.ts',
        'src/index.ts',
        'src/browserContextFactory.ts',
        'src/sessionLog.ts',
        'src/tools.ts',
        'src/config.ts',
        'src/context.ts',
        'src/tab.ts',
        'src/mcp/**',
        'src/tools/dialogs.ts',
        'src/tools/evaluate.ts',
        'src/tools/files.ts',
        'src/tools/form.ts',
        'src/tools/install.ts',
        'src/tools/keyboard.ts',
        'src/tools/mouse.ts',
        'src/tools/pdf.ts',
        'src/tools/screenshot.ts',
        'src/tools/snapshot.ts',
        'src/tools/verify.ts',
        'src/tools/wait.ts',
        'src/utils/codegen.ts',
        'src/utils/package.ts',
        'src/utils/fileUtils.ts',
      ],
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    maxWorkers: 6,
    fileParallelism: true
  },
});
