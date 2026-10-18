import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    // Real-run files starve each other on a 3–4 vCPU CI runner (#44): one at a time there.
    fileParallelism: !process.env.CI,
    // The command tests launch Chromium, record a video and render it.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
