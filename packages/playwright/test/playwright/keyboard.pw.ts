import { test } from './demoflow.ts';

// Raw keyboard input has no scenario form: it fails the test.
test('keyboard', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').click();
  await page.keyboard.type('ada@example.com');
});
