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
      ],
      include: ['src/**/*.ts'],
      all: true,
      lines: 90,
      functions: 90,
      branches: 90,
      statements: 90,
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
