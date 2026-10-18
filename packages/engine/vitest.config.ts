import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    // Each browser test launches Chromium and records a video. The video is
    // recorded at device pixels (2560×1440 for the fixture viewport), which a
    // macOS CI runner needs 12–25 s per test for; 60 s timed out a hook there.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
