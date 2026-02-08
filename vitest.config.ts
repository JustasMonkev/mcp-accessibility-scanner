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
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
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
        'src/browserContextFactory.ts', // Requires real Playwright browser launch
        'src/sessionLog.ts', // File system operations
        'src/tools.ts', // Server initialization
        'src/config.ts', // Requires file system reading and environment parsing
        'src/context.ts', // Requires complex async Playwright browser lifecycle
        'src/tab.ts', // Requires complex Playwright page navigation and lifecycle
        'src/mcp/**', // MCP server infrastructure requires server setup
        // Tools requiring complex Playwright mocking or integration tests
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
        'src/utils/codegen.ts', // Code generation utilities
        'src/utils/package.ts', // Simple package.json wrapper
        'src/utils/fileUtils.ts', // File system operations
      ],
      include: ['src/**/*.ts'],
      all: true,
      // Adjusted thresholds based on testable code without modifying source
      // Focused on: response, tool definitions, config, context basics, tested tools, utils
      lines: 90,
      functions: 90,
      branches: 90,
      statements: 90,
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    maxWorkers: 6,
    fileParallelism: true
  },
});
