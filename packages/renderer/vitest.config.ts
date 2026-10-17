import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    // Integration tests record a run in Chromium and probe it with FFmpeg.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
