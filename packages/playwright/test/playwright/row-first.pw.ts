import { test } from './demoflow.ts';

// A chained locator has no scenario form: clicking it fails the test.
test('first row', async ({ page }) => {
  await page.goto('/customers');
  await page.getByRole('row').first().click();
});
