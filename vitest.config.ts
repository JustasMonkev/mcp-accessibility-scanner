import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true, // Use Vitest globals (describe, test, expect, etc.)
    environment: 'happy-dom', // Use happy-dom for DOM simulation
    // You might need to include setup files or other options here later
    // For example, to mock 'playwright' and '@axe-core/playwright' globally for tests
    // setupFiles: ['./src/vitest.setup.ts'], // Example, if we create this file
  },
});
