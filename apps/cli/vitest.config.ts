import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    // Real-run files starve each other on a 3–4 vCPU CI runner (#44): one at a time there.
    fileParallelism: !process.env.CI,
    // Belt and braces for the same host (#315): never more than two workers in CI.
    maxWorkers: process.env.CI ? 2 : undefined,
    // The command tests launch Chromium, record a video and render it.
    // Serialized on CI, the slowest takes 27 s (#44).
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
