import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    // Each browser test launches Chromium and records a video.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
