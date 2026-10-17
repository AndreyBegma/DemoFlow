import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    // The command tests launch Chromium, record a video and render it.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
