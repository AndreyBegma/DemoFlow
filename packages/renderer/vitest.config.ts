import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    // Real-run files starve each other on a 3–4 vCPU CI runner (#44): one at a time there.
    fileParallelism: !process.env.CI,
    // Integration tests record a run in Chromium and probe it with FFmpeg.
    // Serialized on CI, the slowest takes 29 s and the slowest file 42 s (#44).
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
