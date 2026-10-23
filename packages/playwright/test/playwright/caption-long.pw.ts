import { test } from './demoflow.ts';

// A caption over 120 characters fails the test while recording, even caught;
// without recording, it does nothing.
test('long caption', async ({ page, demoflow }) => {
  await page.goto('/inline/buttons');
  try {
    demoflow.caption('c'.repeat(121));
  } catch {
    // Caught: the recording still fails at teardown.
  }
});
