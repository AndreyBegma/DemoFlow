import { test } from './demoflow.ts';

// A literal password: the fixture refuses to record it, with this line.
test('literal password', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Password').fill('literal-password-1');
});
