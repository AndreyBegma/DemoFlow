import { test } from './demoflow.ts';

// A chained locator has no scenario form: scrolling to it fails the test.
test('scroll into view, first', async ({ page }) => {
  await page.goto('/inline/scrolls');
  await page.getByTestId('x').first().scrollIntoViewIfNeeded();
});
