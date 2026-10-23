import { test } from './demoflow.ts';

// An empty caption fails the test while recording; without, it does nothing.
test('empty caption', async ({ page, demoflow }) => {
  await page.goto('/inline/buttons');
  demoflow.caption('');
});
