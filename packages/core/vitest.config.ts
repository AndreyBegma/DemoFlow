import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    // Each turbo task brings its own pool; on the shared CI host the sum ran it out of memory (#315).
    maxWorkers: process.env.CI ? 2 : undefined,
  },
});
