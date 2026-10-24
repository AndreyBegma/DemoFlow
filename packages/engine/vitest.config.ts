import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    // Real-run files starve each other on a 3–4 vCPU CI runner (#44): one at a time there.
    fileParallelism: !process.env.CI,
    // Belt and braces for the same host (#315): never more than two workers in CI.
    maxWorkers: process.env.CI ? 2 : undefined,
    // Each browser test launches Chromium and records a video. The video is
    // recorded at device pixels (2560×1440 for the fixture viewport), which a
    // macOS CI runner needs 12–25 s per test for; 60 s timed out a hook there.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
