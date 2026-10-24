import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    // The older-minor suite runs on its own, in one CI step (vitest.minors.config.ts).
    exclude: ['test/minors.spec.ts', '**/node_modules/**'],
    environment: 'node',
    // Each turbo task brings its own pool; on the shared CI host the sum ran it out of memory (#315).
    maxWorkers: process.env.CI ? 2 : undefined,
    // The probe suite spawns Playwright Test several times and replays each
    // scenario through the engine, which records a video.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
