import { defineConfig } from 'vitest/config';

// Spec 208, Decision 10: the probes against the older supported minors of
// @playwright/test, through the npm aliases in devDependencies. Linux CI only;
// each alias needs its own Chromium (`node <alias>/cli.js install chromium`).
export default defineConfig({
  test: {
    include: ['test/minors.spec.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
